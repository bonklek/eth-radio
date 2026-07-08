import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, getAddress, http, parseEventLogs } from 'viem'
import { sepolia } from 'viem/chains'

const chains = { sepolia }

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return process.argv[idx + 1]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function isoSeconds(ms) {
  return Math.round(ms / 1000)
}

function segmentStats(segments, segmentMs) {
  const ordered = [...segments].sort((a, b) => Number(a.sequence) - Number(b.sequence))
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

const streamId = arg('stream-id', process.env.STREAM_ID || 'rfe-avatar-smoke-overlay-v1')
const chainName = process.env.CHAIN || 'sepolia'
const chain = chains[chainName]
const rpcUrl = arg('rpc-url', process.env.ETH_RPC_URL || 'https://sepolia.drpc.org')
const stationAddress = arg('station', process.env.STATION_ADDRESS)
const deploymentPath = path.resolve(`work/blob-radio-testnet/contracts/Station.${chainName}.json`)
const deployment = fs.existsSync(deploymentPath) ? loadJson(deploymentPath) : null
const station = stationAddress || deployment?.address
const abi = deployment?.abi
const intervalMs = Number(arg('interval-ms', '30000'))
const segmentMs = Number(arg('segment-ms', '24000'))
const fromBlockArg = arg('from-block')
const lookbackBlocks = BigInt(arg('lookback-blocks', '1000'))
const logPath = path.resolve(arg('out', `work/blob-radio-testnet/live-runs/${sanitize(streamId)}/logs/latency-monitor.jsonl`))
const maxLoops = Number(arg('max-loops', '0'))

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
    const latestBlockMs = Number(latestBlock.timestamp) * 1000
    record.latestBlock = {
      number: latestBlock.number.toString(),
      timestamp: new Date(latestBlockMs).toISOString(),
      ageSec: isoSeconds(now - latestBlockMs),
    }

    const queryFrom = fromBlockArg
      ? BigInt(fromBlockArg)
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
      .filter((log) => log.args.streamId === streamId)
      .map((log) => ({
        sequence: Number(log.args.sequence),
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber.toString(),
        blockTimestampMs: latestBlockMs - Number(latestBlock.number - log.blockNumber) * 12_000,
        payloadBytes: Number(log.args.payloadBytes),
        blobCount: log.args.blobVersionedHashes.length,
      }))

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
