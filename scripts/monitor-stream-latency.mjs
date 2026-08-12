import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, getAddress, http, parseEventLogs } from 'viem'
import { assertRpcChain, chainEndpointsFromEnv, chainFromEnv, requireSupportedChain } from './chains.mjs'
import { bigintArg, numberArg, readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import { credentialSafeEndpointLabel, endpointSafeErrorMessage, installEndpointSafeProcessHandlers } from './lib/endpoint-privacy.mjs'
import { blockTimestampMs, hydrateEventBlockTimestamps, latencySegmentStats, pruneEventBlockTimestamps } from './lib/latency-metrics.mjs'
import { stationReadConfig } from './lib/station-deployment.mjs'
import { appendRotatingLineSync } from './lib/bounded-files.mjs'
import { MAX_LATENCY_LOG_BYTES, resolveRunDirectory, scopedStreamFilesystemIdentity } from './lib/filesystem-identity.mjs'
import {
  fetchStationLogsInChunks,
  STATION_LOG_AGGREGATE_LIMIT,
  STATION_LOG_RANGE_BLOCK_LIMIT,
  STATION_LOG_RESPONSE_LIMIT,
  STATION_SCAN_BLOCK_LIMIT,
  STATION_TIMESTAMP_BLOCK_LIMIT,
} from './lib/station-history.mjs'

if (helpRequested()) {
  console.log(`Usage:
  pnpm live:latency -- [--stream-id <id>] [--rpc-url <url>] [--station 0x...]
                         [--publisher 0x...] [--from-block <number>] [--lookback-blocks 1000]
                         [--interval-ms 30000] [--segment-ms 24000] [--max-loops 0] [--out <file>]
`)
  process.exit(0)
}
dotenv.config({ quiet: true })

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function segmentBlobVersionedHashes(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function monitorSegment(log, eventBlockTimestamps) {
  const args = log.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('SegmentPublished args must be an object')
  }
  if (typeof args.streamId !== 'string') throw new Error('SegmentPublished streamId must be a string')
  const eventBlockTimestampMs = eventBlockTimestamps.get(log.blockNumber.toString())
  if (!Number.isSafeInteger(eventBlockTimestampMs)) {
    throw new Error(`Missing actual timestamp for SegmentPublished block ${log.blockNumber}`)
  }
  return {
    streamId: args.streamId,
    publisher: getAddress(args.publisher),
    sequence: nonNegativeSafeNumber(args.sequence, 'SegmentPublished sequence'),
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber.toString(),
    blockTimestampMs: eventBlockTimestampMs,
    payloadBytes: nonNegativeSafeNumber(args.payloadBytes, 'SegmentPublished payloadBytes'),
    blobCount: segmentBlobVersionedHashes(args.blobVersionedHashes, 'SegmentPublished blobVersionedHashes').length,
  }
}

const streamId = readArg('stream-id', process.env.STREAM_ID || 'rfe-avatar-smoke-overlay-v1')
const { chainName, chain } = chainFromEnv()
requireSupportedChain(chain)
const endpoints = chainEndpointsFromEnv(chainName)
const rpcUrl = readArg('rpc-url', endpoints.executionRpcUrl)
installEndpointSafeProcessHandlers(() => [rpcUrl].filter(Boolean))
const stationConfig = stationReadConfig(chainName, {
  stationAddress: readArg('station', process.env.STATION_ADDRESS),
})
const station = stationConfig.stationAddress
const publisher = readArg('publisher', process.env.PUBLISHER_ADDRESS)
const abi = stationConfig.abi
const intervalMs = numberArg('interval-ms', '30000', { integer: true, min: 1 })
const segmentMs = numberArg('segment-ms', '24000', { integer: true, min: 1 })
const fromBlockArg = readArg('from-block')
const fromBlock = fromBlockArg === undefined ? null : bigintArg('from-block', fromBlockArg, { min: 0n })
const lookbackBlocks = bigintArg('lookback-blocks', '1000', {
  min: 0n,
  max: BigInt(STATION_SCAN_BLOCK_LIMIT - 1),
})
const outArg = readArg('out')
const runIdentity = scopedStreamFilesystemIdentity({ chain: chainName, station, publisher, streamId })
const defaultRunDir = outArg
  ? path.join(path.resolve('work/blob-radio-testnet/live-runs'), runIdentity.key)
  : resolveRunDirectory({ baseDir: path.resolve('work/blob-radio-testnet/live-runs'), streamId, identity: runIdentity })
const logPath = path.resolve(outArg || path.join(defaultRunDir, 'logs', 'latency-monitor.jsonl'))
const maxLoops = numberArg('max-loops', '0', { integer: true, min: 0 })
const rpcLabel = credentialSafeEndpointLabel(rpcUrl, 'RPC endpoint')

if (!rpcUrl || !station) {
  console.error('Missing rpc url or station address')
  process.exit(1)
}

const client = createPublicClient({
  chain,
  transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }),
})
await assertRpcChain(client, chain)
fs.mkdirSync(path.dirname(logPath), { recursive: true })

let loops = 0
const eventBlockTimestamps = new Map()
let retentionWarningEmitted = false
console.log(`monitoring ${streamId} via ${rpcLabel}`)
console.log(`station ${station}`)
console.log(`writing ${logPath}`)

while (true) {
  loops += 1
  const now = Date.now()
  const record = {
    checkedAt: new Date(now).toISOString(),
    streamId,
    publisher: publisher ? getAddress(publisher) : null,
    segmentMs,
    rpcEndpoint: rpcLabel,
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

    const requestedFrom = fromBlock !== null
      ? fromBlock
      : latestBlock.number > lookbackBlocks
        ? latestBlock.number - lookbackBlocks
        : 0n
    const retainedFrom = latestBlock.number >= BigInt(STATION_SCAN_BLOCK_LIMIT - 1)
      ? latestBlock.number - BigInt(STATION_SCAN_BLOCK_LIMIT - 1)
      : 0n
    const queryFrom = requestedFrom > retainedFrom ? requestedFrom : retainedFrom
    if (requestedFrom < retainedFrom && !retentionWarningEmitted) {
      console.warn(`Station query start ${requestedFrom} is outside the ${STATION_SCAN_BLOCK_LIMIT}-block monitoring window; narrowing to ${retainedFrom}.`)
      retentionWarningEmitted = true
    }
    const logs = await fetchStationLogsInChunks({
      fromBlock: queryFrom,
      toBlock: latestBlock.number,
      logRangeBlockLimit: STATION_LOG_RANGE_BLOCK_LIMIT,
      scanBlockLimit: STATION_SCAN_BLOCK_LIMIT,
      responseLogLimit: STATION_LOG_RESPONSE_LIMIT,
      aggregateLogLimit: STATION_LOG_AGGREGATE_LIMIT,
      getLogs: (range) => client.getLogs({ address: getAddress(station), ...range }),
    })

    const parsed = parseEventLogs({ abi, eventName: 'SegmentPublished', logs })
    if (new Set(parsed.map((log) => log.blockNumber.toString())).size > STATION_TIMESTAMP_BLOCK_LIMIT) {
      throw new Error(`Station timestamp hydration exceeds ${STATION_TIMESTAMP_BLOCK_LIMIT} blocks. Narrow --lookback-blocks or --from-block.`)
    }
    await hydrateEventBlockTimestamps(client, parsed, eventBlockTimestamps)
    pruneEventBlockTimestamps(eventBlockTimestamps, parsed)
    const segments = parsed
      .map((log) => monitorSegment(log, eventBlockTimestamps))
      .filter((segment) => segment.streamId === streamId)
      .filter((segment) => !publisher || segment.publisher === getAddress(publisher))

    const stats = latencySegmentStats(segments, segmentMs)
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
    record.error = endpointSafeErrorMessage(error, [rpcUrl])
  }

  const logWrite = appendRotatingLineSync(logPath, JSON.stringify(record), {
    maxBytes: MAX_LATENCY_LOG_BYTES,
  })
  if (logWrite.rotated) console.warn(`rotated latency log at ${MAX_LATENCY_LOG_BYTES} bytes: ${logPath}.1`)
  const summary = record.error
    ? `error=${record.error}`
    : `headAge=${record.latestBlock.ageSec}s events=${record.window.eventCount} latestSeq=${record.window.latestSequence} avgGap=${record.window.avgGapSec?.toFixed?.(1) ?? 'n/a'}s ratio=${record.window.streamRatio?.toFixed?.(2) ?? 'n/a'}`
  console.log(`${record.checkedAt} ${summary}`)

  if (maxLoops > 0 && loops >= maxLoops) break
  await sleep(intervalMs)
}
