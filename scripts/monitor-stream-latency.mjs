import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, getAddress, http, parseEventLogs } from 'viem'
import { sepolia } from 'viem/chains'
import { bigintArg, numberArg, readArg } from './lib/cli-args.mjs'
import { loadStationDeployment } from './lib/station-deployment.mjs'

const chains = { sepolia }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function isoSeconds(ms) {
  return Math.round(ms / 1000)
}

function nonNegativeSafeNumber(value, label) {
  if (typeof value === 'bigint') {
    const number = Number(value)
    if (Number.isSafeInteger(number) && number >= 0) return number
  }
  if (Number.isSafeInteger(value) && value >= 0) return value
  throw new Error(`${label} must be a non-negative safe integer`)
}

function blockTimestampMs(value, label) {
  const seconds = nonNegativeSafeNumber(value, label)
  const milliseconds = seconds * 1000
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`${label} milliseconds must be a safe integer`)
  return milliseconds
}

function segmentBlobVersionedHashes(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function monitorSegment(log, latestBlock, latestBlockMs) {
  const args = log.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('SegmentPublished args must be an object')
  }
  if (typeof args.streamId !== 'string') throw new Error('SegmentPublished streamId must be a string')
  const blockLag = nonNegativeSafeNumber(latestBlock.number - log.blockNumber, 'SegmentPublished block lag')
  return {
    streamId: args.streamId,
    sequence: nonNegativeSafeNumber(args.sequence, 'SegmentPublished sequence'),
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber.toString(),
    blockTimestampMs: latestBlockMs - blockLag * 12_000,
    payloadBytes: nonNegativeSafeNumber(args.payloadBytes, 'SegmentPublished payloadBytes'),
    blobCount: segmentBlobVersionedHashes(args.blobVersionedHashes, 'SegmentPublished blobVersionedHashes').length,
  }
}

function segmentStats(segments, segmentMs) {
  const ordered = [...segments].sort((a, b) => a.sequence - b.sequence)
  const gaps = []
  for (let i = 1; i < ordered.length; i += 1) {
    gaps.push(Number(ordered[i].blockTimestampMs - ordered[i - 1].blockTimestampMs) / 1000)
  }
  const avgGapSec = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : null
  const latest = ordered.at(-1) || null
  return {
    count: ordered.length,
    latest,
    avgGapSec,
    streamRatio: avgGapSec ? segmentMs / 1000 / avgGapSec : null,
  }
}

const streamId = readArg('stream-id', process.env.STREAM_ID || 'rfe-avatar-smoke-overlay-v1')
const chainName = process.env.CHAIN || 'sepolia'
const chain = chains[chainName]
const rpcUrl = readArg('rpc-url', process.env.ETH_RPC_URL || 'https://sepolia.drpc.org')
const stationAddress = readArg('station', process.env.STATION_ADDRESS)
const deployment = loadStationDeployment(chainName)
const station = stationAddress || deployment?.address
const abi = deployment?.abi
const intervalMs = numberArg('interval-ms', '30000', { integer: true, min: 1 })
const segmentMs = numberArg('segment-ms', '24000', { integer: true, min: 1 })
const fromBlockArg = readArg('from-block')
const fromBlock = fromBlockArg === undefined ? null : bigintArg('from-block', fromBlockArg, { min: 0n })
const lookbackBlocks = bigintArg('lookback-blocks', '1000', { min: 0n })
const logPath = path.resolve(readArg('out', `work/blob-radio-testnet/live-runs/${sanitize(streamId)}/logs/latency-monitor.jsonl`))
const maxLoops = numberArg('max-loops', '0', { integer: true, min: 0 })

if (!chain || !rpcUrl || !station || !abi) {
  console.error('Missing chain, rpc url, station address, or Station ABI')
  process.exit(1)
}

fs.mkdirSync(path.dirname(logPath), { recursive: true })

const client = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }),
})

let loops = 0
console.log(`monitoring ${streamId} via ${rpcUrl}`)
console.log(`station ${station}`)
console.log(`writing ${logPath}`)

while (true) {
  loops += 1
  const now = Date.now()
  const record = {
    checkedAt: new Date(now).toISOString(),
    streamId,
    segmentMs,
    rpcUrl,
  }

  try {
    const latestBlockNumber = await client.getBlockNumber()
    const latestBlock = await client.getBlock({ blockNumber: latestBlockNumber })
    const latestBlockMs = blockTimestampMs(latestBlock.timestamp, 'latest block timestamp')
    record.latestBlock = {
      number: latestBlock.number.toString(),
      timestamp: new Date(latestBlockMs).toISOString(),
      ageSec: isoSeconds(now - latestBlockMs),
    }

    const queryFrom = fromBlock !== null
      ? fromBlock
      : latestBlock.number > lookbackBlocks
        ? latestBlock.number - lookbackBlocks
        : 0n
    const logs = await client.getLogs({
      address: getAddress(station),
      fromBlock: queryFrom,
      toBlock: 'latest',
    })

    const parsed = parseEventLogs({ abi, eventName: 'SegmentPublished', logs })
    const segments = parsed
      .map((log) => monitorSegment(log, latestBlock, latestBlockMs))
      .filter((segment) => segment.streamId === streamId)

    const stats = segmentStats(segments, segmentMs)
    record.window = {
      fromBlock: queryFrom.toString(),
      toBlock: latestBlock.number.toString(),
      eventCount: stats.count,
      avgGapSec: stats.avgGapSec,
      streamRatio: stats.streamRatio,
      latestSequence: stats.latest?.sequence ?? null,
      latestTx: stats.latest?.transactionHash ?? null,
      latestBlobCount: stats.latest?.blobCount ?? null,
      latestPayloadBytes: stats.latest?.payloadBytes ?? null,
    }
  } catch (error) {
    record.error = error.shortMessage || error.message || String(error)
  }

  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`)
  const summary = record.error
    ? `error=${record.error}`
    : `headAge=${record.latestBlock.ageSec}s events=${record.window.eventCount} latestSeq=${record.window.latestSequence} avgGap=${record.window.avgGapSec?.toFixed?.(1) ?? 'n/a'}s ratio=${record.window.streamRatio?.toFixed?.(2) ?? 'n/a'}`
  console.log(`${record.checkedAt} ${summary}`)

  if (maxLoops > 0 && loops >= maxLoops) break
  await sleep(intervalMs)
}
