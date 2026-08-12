import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  fetchStationLogsInChunks,
  reconcileStationHistory,
  scanStationHistory,
  stationHistoryScanPlan,
  stationHistoryScopeKey,
} from './lib/station-history.mjs'
import { canonicalStreamIdHash } from './lib/stream-identity-continuity.mjs'

const largeHead = 1_000_000n
const historyBlockLimit = 100
const refreshBlockLimit = 20
const logRangeBlockLimit = 25
const reorgBlockWindow = 5
const timestampConcurrency = 3
const publisherA = `0x${'11'.repeat(20)}`
const publisherB = `0x${'22'.repeat(20)}`
const historyStreamHash = canonicalStreamIdHash('large-history')

const serveSource = fs.readFileSync(new URL('./serve-live-demo.mjs', import.meta.url), 'utf8')
  .replaceAll('\r\n', '\n')
for (const marker of [
  "envNumber('STATION_HISTORY_INITIAL_BLOCKS'",
  "envNumber('STATION_HISTORY_REORG_BLOCKS'",
  'stationHistoryScopeKey(ctx.name, ctx.stationAddress)',
  'const state = await scanStationHistory({',
  'const previousState = stationSegmentsCache.get(cacheKey) || null',
  'readStationSegments(ctx, previousState)',
  'if (cached) {',
]) {
  assert.ok(serveSource.includes(marker), `serve-live-demo is missing incremental Station history integration: ${marker}`)
}
assert.ok(
  !serveSource.includes('fromBlock: ctx.stationFromBlock,\n    toBlock: \'latest\''),
  'serve-live-demo must not restore an unbounded deployment-to-latest Station query',
)

function blocksInRange(fromBlock, toBlock) {
  const blocks = []
  for (let block = fromBlock; block <= toBlock; block += 1n) blocks.push(block)
  return blocks
}

function mockLog(blockNumber, sequence = blockNumber, marker = 'canonical', publisher = publisherA) {
  return {
    blockNumber,
    blockHash: `${marker}-${blockNumber}`,
    transactionHash: `${marker}-tx-${blockNumber}-${sequence}`,
    logIndex: 0,
    sequence,
    publisher,
  }
}

function decodeLog(log, createdAtMs) {
  return {
    streamId: 'large-history',
    streamIdHash: historyStreamHash,
    publisher: log.publisher,
    sequence: Number(log.sequence),
    blockNumber: log.blockNumber.toString(),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    createdAtMs,
  }
}

function boundedTimestampFetcher(calls) {
  let active = 0
  let maximumActive = 0
  return {
    async fetch(blockNumber) {
      calls.push(blockNumber)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return Number(blockNumber) * 1000
    },
    maximumActive: () => maximumActive,
  }
}

assert.notEqual(
  stationHistoryScopeKey('sepolia', `0x${'1'.repeat(40)}`),
  stationHistoryScopeKey('sepolia', `0x${'2'.repeat(40)}`),
  'Station cursors must be isolated by contract address',
)
assert.notEqual(
  stationHistoryScopeKey('mainnet', `0x${'1'.repeat(40)}`),
  stationHistoryScopeKey('sepolia', `0x${'1'.repeat(40)}`),
  'Station cursors must be isolated by network',
)

const initialRanges = []
const initialTimestampCalls = []
const initialTimestampFetcher = boundedTimestampFetcher(initialTimestampCalls)
const initial = await scanStationHistory({
  deploymentBlock: 0n,
  historyBlockLimit,
  refreshBlockLimit,
  logRangeBlockLimit,
  reorgBlockWindow,
  timestampConcurrency,
  getLatestBlockNumber: async () => largeHead,
  getLogs: async (range) => {
    initialRanges.push(range)
    return blocksInRange(range.fromBlock, range.toBlock).map((blockNumber) => mockLog(blockNumber))
  },
  getBlockTimestampMs: initialTimestampFetcher.fetch,
  decodeLog,
})

assert.equal(initial.scan.fromBlock, 999_901n)
assert.equal(initial.scan.toBlock, largeHead)
assert.equal(initial.scan.ranges.length, 4)
assert.equal(initialRanges.length, 4, 'initial work must be chunked into bounded RPC requests')
for (const range of initialRanges) {
  assert.ok(range.toBlock - range.fromBlock + 1n <= BigInt(logRangeBlockLimit))
}
assert.equal(initial.segments.length, historyBlockLimit)
assert.equal(initialTimestampCalls.length, historyBlockLimit)
assert.ok(initialTimestampFetcher.maximumActive() <= timestampConcurrency)
assert.equal(initialTimestampFetcher.maximumActive(), timestampConcurrency)
assert.equal(initial.cursorBlock, 999_995n)

const refreshRanges = []
const refreshTimestampCalls = []
const refreshTimestampFetcher = boundedTimestampFetcher(refreshTimestampCalls)
const refreshed = await scanStationHistory({
  previousState: initial,
  deploymentBlock: 0n,
  historyBlockLimit,
  refreshBlockLimit,
  logRangeBlockLimit,
  reorgBlockWindow,
  timestampConcurrency,
  getLatestBlockNumber: async () => largeHead + 1n,
  getLogs: async (range) => {
    refreshRanges.push(range)
    const logs = []
    for (const blockNumber of blocksInRange(range.fromBlock, range.toBlock)) {
      if (blockNumber === 999_998n || blockNumber === 999_999n) continue
      if (blockNumber === 1_000_000n) {
        logs.push(mockLog(blockNumber, 999_998n, 'replacement'))
        logs.push(mockLog(blockNumber, 999_998n, 'replacement'))
      }
      logs.push(mockLog(blockNumber))
    }
    return logs
  },
  getBlockTimestampMs: refreshTimestampFetcher.fetch,
  decodeLog,
})

assert.deepEqual(refreshRanges, [{ fromBlock: 999_996n, toBlock: 1_000_001n }])
assert.ok(refreshRanges[0].fromBlock > 0n, 'refresh must not return to the deployment block')
assert.equal(refreshed.cursorBlock, 999_996n)
assert.equal(refreshTimestampCalls.length, 4, 'overlap timestamps should be refetched once per current canonical block')
assert.ok(refreshTimestampFetcher.maximumActive() <= timestampConcurrency)

const stable = refreshed.segments.find((segment) => segment.sequence === 999_995)
assert.equal(stable?.blockNumber, '999995', 'finalized history before the overlap must remain cached')
assert.equal(
  refreshed.segments.some((segment) => segment.sequence === 999_999),
  false,
  'a log removed by a shallow reorg must be removed from the cache',
)
const replacement = refreshed.segments.filter((segment) => segment.sequence === 999_998)
assert.equal(replacement.length, 1, 'overlap duplicates must reconcile to one canonical segment')
assert.equal(replacement[0].blockNumber, '1000000')
assert.match(replacement[0].blockHash, /^replacement-/)

const publisherCollision = reconcileStationHistory([], [
  decodeLog(mockLog(50n, 7n, 'publisher-a', publisherA), 50_000),
  decodeLog(mockLog(51n, 7n, 'publisher-b', publisherB), 51_000),
], { replaceFromBlock: 0n, retainFromBlock: 0n })
assert.equal(publisherCollision.length, 2, 'different publishers must retain the same streamId and sequence independently')
assert.deepEqual(new Set(publisherCollision.map((segment) => segment.publisher)), new Set([publisherA, publisherB]))

const catchupPlan = stationHistoryScanPlan({
  deploymentBlock: 0n,
  latestBlock: largeHead,
  cursorBlock: 100n,
  historyBlockLimit,
  refreshBlockLimit,
  logRangeBlockLimit,
})
assert.equal(catchupPlan.fromBlock, 999_901n, 'stale cursors must jump to the configured retention window')
assert.equal(catchupPlan.toBlock, 999_920n, 'one refresh must remain bounded even after a long outage')
assert.ok(catchupPlan.ranges.length <= Math.ceil(refreshBlockLimit / logRangeBlockLimit))

await assert.rejects(
  fetchStationLogsInChunks({
    fromBlock: 0n,
    toBlock: 0n,
    responseLogLimit: 10_000,
    aggregateLogLimit: 10_000,
    getLogs: async () => Array.from({ length: 10_001 }, () => mockLog(0n)),
  }),
  /returned 10001 records; limit is 10000.*Narrow/,
  'a 10,001-log RPC response must fail before decode, hydration, or sorting',
)

let oversizedParseCalls = 0
await assert.rejects(
  scanStationHistory({
    deploymentBlock: 0n,
    historyBlockLimit: 1,
    refreshBlockLimit: 1,
    logRangeBlockLimit: 1,
    reorgBlockWindow: 1,
    timestampConcurrency: 1,
    responseLogLimit: 10_000,
    aggregateLogLimit: 10_000,
    getLatestBlockNumber: async () => 0n,
    getLogs: async () => Array.from({ length: 10_001 }, () => mockLog(0n)),
    parseLogs(logs) {
      oversizedParseCalls += 1
      return logs
    },
    getBlockTimestampMs: async () => 0,
    decodeLog,
  }),
  /returned 10001 records; limit is 10000/,
)
assert.equal(oversizedParseCalls, 0, 'oversized raw responses must fail before ABI parsing')

await assert.rejects(
  fetchStationLogsInChunks({
    fromBlock: 0n,
    toBlock: 1n,
    logRangeBlockLimit: 1,
    responseLogLimit: 6_000,
    aggregateLogLimit: 10_000,
    getLogs: async ({ fromBlock: block }) => Array.from({ length: 5_001 }, () => mockLog(block)),
  }),
  /10000-log aggregate limit.*Narrow/,
  'multiple individually valid responses must still obey the aggregate ceiling',
)

await assert.rejects(
  fetchStationLogsInChunks({
    fromBlock: 0n,
    toBlock: 100n,
    scanBlockLimit: 100,
    getLogs: async () => [],
  }),
  /100-block scan limit.*Narrow/,
)

await assert.rejects(
  scanStationHistory({
    deploymentBlock: 0n,
    historyBlockLimit: 10,
    refreshBlockLimit: 10,
    logRangeBlockLimit: 10,
    reorgBlockWindow: 1,
    timestampConcurrency: 1,
    timestampBlockLimit: 2,
    getLatestBlockNumber: async () => 2n,
    getLogs: async () => [mockLog(0n), mockLog(1n), mockLog(2n)],
    getBlockTimestampMs: async (block) => Number(block) * 1000,
    decodeLog,
  }),
  /timestamp hydration set contains 3 records; limit is 2/,
  'timestamp work must be rejected before any timestamp RPC is issued',
)

await assert.rejects(
  scanStationHistory({
    previousState: {
      cursorBlock: 1n,
      segments: [],
      blockTimestamps: new Map([['0', 0], ['1', 1000]]),
    },
    deploymentBlock: 0n,
    historyBlockLimit: 10,
    refreshBlockLimit: 10,
    logRangeBlockLimit: 10,
    reorgBlockWindow: 1,
    timestampConcurrency: 1,
    timestampBlockLimit: 3,
    getLatestBlockNumber: async () => 3n,
    getLogs: async () => [mockLog(2n), mockLog(3n)],
    getBlockTimestampMs: async (block) => Number(block) * 1000,
    decodeLog,
  }),
  /retained and pending timestamp set contains 4 records; limit is 3/,
  'retained and new timestamp blocks must share one hard cache/work ceiling',
)

console.log('Station history incremental scan tests ok')
