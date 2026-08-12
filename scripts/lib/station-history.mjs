import { segmentIdentityKey } from './stream-identity-continuity.mjs'

export const STATION_LOG_RANGE_BLOCK_LIMIT = 1024
export const STATION_SCAN_BLOCK_LIMIT = 100_000
export const STATION_LOG_RESPONSE_LIMIT = 5_000
export const STATION_LOG_AGGREGATE_LIMIT = 10_000
export const STATION_RETAINED_SEGMENT_LIMIT = 10_000
export const STATION_TIMESTAMP_BLOCK_LIMIT = 5_000

function nonNegativeBlock(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value)
  throw new Error(`${label} must be a non-negative block number`)
}

function optionalBlock(value, label) {
  return value === undefined || value === null ? null : nonNegativeBlock(value, label)
}

function positiveInteger(value, label) {
  if (Number.isSafeInteger(value) && value > 0) return value
  throw new Error(`${label} must be a positive safe integer`)
}

function boundedArray(value, limit, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > limit) {
    throw new Error(`${label} returned ${value.length} records; limit is ${limit}. Narrow the requested block range or add a more selective filter.`)
  }
  return value
}

function assertCollectionLimit(value, limit, label) {
  const size = value?.size ?? value?.length ?? 0
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
    throw new Error(`${label} contains ${size} records; limit is ${limit}. Narrow the history window.`)
  }
}

function minBlock(left, right) {
  return left < right ? left : right
}

function maxBlock(...values) {
  return values.reduce((maximum, value) => value > maximum ? value : maximum)
}

function blockBefore(value) {
  return value > 0n ? value - 1n : null
}

function segmentBlock(segment) {
  return nonNegativeBlock(segment?.blockNumber, 'Station history segment blockNumber')
}

function segmentIsAtLeastAsRecent(segment, previous) {
  const blockNumber = segmentBlock(segment)
  const previousBlockNumber = segmentBlock(previous)
  if (blockNumber !== previousBlockNumber) return blockNumber > previousBlockNumber
  const logIndex = nonNegativeBlock(segment?.logIndex ?? 0, 'Station history segment logIndex')
  const previousLogIndex = nonNegativeBlock(previous?.logIndex ?? 0, 'previous Station history segment logIndex')
  return logIndex >= previousLogIndex
}

export function stationHistoryScopeKey(network, stationAddress) {
  return `${String(network || '').toLowerCase()}:${String(stationAddress || '').toLowerCase()}`
}

export async function fetchStationLogsInChunks({
  fromBlock,
  toBlock,
  getLogs,
  logRangeBlockLimit = STATION_LOG_RANGE_BLOCK_LIMIT,
  scanBlockLimit = STATION_SCAN_BLOCK_LIMIT,
  responseLogLimit = STATION_LOG_RESPONSE_LIMIT,
  aggregateLogLimit = STATION_LOG_AGGREGATE_LIMIT,
}) {
  const from = nonNegativeBlock(fromBlock, 'Station log fromBlock')
  const to = nonNegativeBlock(toBlock, 'Station log toBlock')
  const rangeLimit = BigInt(positiveInteger(logRangeBlockLimit, 'Station log range block limit'))
  const scanLimit = BigInt(positiveInteger(scanBlockLimit, 'Station scan block limit'))
  const responseLimit = positiveInteger(responseLogLimit, 'Station per-response log limit')
  const aggregateLimit = positiveInteger(aggregateLogLimit, 'Station aggregate log limit')
  if (to < from) return []
  if (to - from + 1n > scanLimit) {
    throw new Error(`Station block range ${from}-${to} exceeds the ${scanLimit}-block scan limit. Narrow --from-block/--to-block or the monitoring lookback.`)
  }

  const logs = []
  for (let rangeFrom = from; rangeFrom <= to; rangeFrom += rangeLimit) {
    const rangeTo = minBlock(to, rangeFrom + rangeLimit - 1n)
    const rangeLogs = boundedArray(
      await getLogs({ fromBlock: rangeFrom, toBlock: rangeTo }),
      responseLimit,
      `Station log response for blocks ${rangeFrom}-${rangeTo}`,
    )
    if (logs.length + rangeLogs.length > aggregateLimit) {
      throw new Error(`Station scan exceeds the ${aggregateLimit}-log aggregate limit. Narrow the requested block range or add a more selective filter.`)
    }
    for (const log of rangeLogs) {
      const blockNumber = nonNegativeBlock(log?.blockNumber, 'Station log blockNumber')
      if (blockNumber < rangeFrom || blockNumber > rangeTo) {
        throw new Error(`Station log block ${blockNumber} is outside requested range ${rangeFrom}-${rangeTo}`)
      }
      logs.push(log)
    }
  }
  return logs
}

export function stationHistoryScanPlan({
  deploymentBlock,
  latestBlock,
  cursorBlock = null,
  historyBlockLimit,
  refreshBlockLimit,
  logRangeBlockLimit,
}) {
  const deployment = nonNegativeBlock(deploymentBlock, 'Station deployment block')
  const latest = nonNegativeBlock(latestBlock, 'latest Station block')
  const cursor = optionalBlock(cursorBlock, 'Station finalized cursor')
  const historyLimit = BigInt(positiveInteger(historyBlockLimit, 'Station history block limit'))
  const refreshLimit = BigInt(positiveInteger(refreshBlockLimit, 'Station refresh block limit'))
  const logRangeLimit = BigInt(positiveInteger(logRangeBlockLimit, 'Station log range block limit'))

  if (latest < deployment) {
    return {
      initial: cursor === null,
      latestBlock: latest,
      retentionFromBlock: deployment,
      fromBlock: null,
      toBlock: null,
      ranges: [],
    }
  }

  const retentionFromBlock = maxBlock(deployment, latest >= historyLimit - 1n ? latest - historyLimit + 1n : 0n)
  const initial = cursor === null
  const fromBlock = initial
    ? retentionFromBlock
    : maxBlock(deployment, retentionFromBlock, cursor + 1n)
  if (fromBlock > latest) {
    return {
      initial,
      latestBlock: latest,
      retentionFromBlock,
      fromBlock: null,
      toBlock: null,
      ranges: [],
    }
  }

  const blockLimit = initial ? historyLimit : refreshLimit
  const toBlock = minBlock(latest, fromBlock + blockLimit - 1n)
  const ranges = []
  for (let start = fromBlock; start <= toBlock; start += logRangeLimit) {
    ranges.push({
      fromBlock: start,
      toBlock: minBlock(toBlock, start + logRangeLimit - 1n),
    })
  }
  return { initial, latestBlock: latest, retentionFromBlock, fromBlock, toBlock, ranges }
}

export function stationHistoryFinalizedCursor({ previousCursor = null, fromBlock, toBlock, latestBlock, reorgBlockWindow }) {
  const previous = optionalBlock(previousCursor, 'previous Station finalized cursor')
  const from = nonNegativeBlock(fromBlock, 'Station scan fromBlock')
  const to = nonNegativeBlock(toBlock, 'Station scan toBlock')
  const latest = nonNegativeBlock(latestBlock, 'latest Station block')
  const overlap = BigInt(positiveInteger(reorgBlockWindow, 'Station reorg block window'))
  const beforeWindow = latest >= overlap ? latest - overlap : null
  const scannedFinalized = beforeWindow === null ? null : minBlock(to, beforeWindow)
  const floor = blockBefore(from)
  return [previous, floor, scannedFinalized]
    .filter((value) => value !== null)
    .reduce((maximum, value) => maximum === null || value > maximum ? value : maximum, null)
}

export function reconcileStationHistory(previousSegments, incomingSegments, { replaceFromBlock, retainFromBlock }) {
  const replaceFrom = nonNegativeBlock(replaceFromBlock, 'Station reconciliation block')
  const retainFrom = nonNegativeBlock(retainFromBlock, 'Station retention block')
  const retained = (previousSegments || []).filter((segment) => {
    const block = segmentBlock(segment)
    return block >= retainFrom && block < replaceFrom
  })
  const latestByKey = new Map()
  for (const segment of [...retained, ...(incomingSegments || [])]) {
    if (segmentBlock(segment) < retainFrom) continue
    const key = segmentIdentityKey(segment)
    const previous = latestByKey.get(key)
    if (!previous || segmentIsAtLeastAsRecent(segment, previous)) latestByKey.set(key, segment)
  }
  return [...latestByKey.values()]
}

export async function mapWithConcurrency(values, concurrency, callback) {
  const limit = positiveInteger(concurrency, 'Station timestamp concurrency')
  const items = [...values]
  const results = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await callback(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

export async function scanStationHistory({
  previousState = null,
  deploymentBlock,
  historyBlockLimit,
  refreshBlockLimit,
  logRangeBlockLimit,
  reorgBlockWindow,
  timestampConcurrency,
  responseLogLimit = STATION_LOG_RESPONSE_LIMIT,
  aggregateLogLimit = STATION_LOG_AGGREGATE_LIMIT,
  retainedSegmentLimit = STATION_RETAINED_SEGMENT_LIMIT,
  timestampBlockLimit = STATION_TIMESTAMP_BLOCK_LIMIT,
  scanBlockLimit = STATION_SCAN_BLOCK_LIMIT,
  getLatestBlockNumber,
  getLogs,
  getBlockTimestampMs,
  decodeLog,
  parseLogs = (logs) => logs,
}) {
  const retainedLimit = positiveInteger(retainedSegmentLimit, 'Station retained segment limit')
  const timestampLimit = positiveInteger(timestampBlockLimit, 'Station timestamp block limit')
  const scanLimit = positiveInteger(scanBlockLimit, 'Station scan block limit')
  if (historyBlockLimit > scanLimit || refreshBlockLimit > scanLimit) {
    throw new Error(`Station history and refresh block limits must not exceed the ${scanLimit}-block scan ceiling`)
  }
  assertCollectionLimit(previousState?.segments, retainedLimit, 'Previous Station history')
  assertCollectionLimit(previousState?.blockTimestamps, timestampLimit, 'Previous Station timestamp cache')
  const latestBlock = nonNegativeBlock(await getLatestBlockNumber(), 'latest Station block')
  const plan = stationHistoryScanPlan({
    deploymentBlock,
    latestBlock,
    cursorBlock: previousState?.cursorBlock ?? null,
    historyBlockLimit,
    refreshBlockLimit,
    logRangeBlockLimit,
  })
  if (plan.fromBlock === null) {
    return {
      segments: previousState?.segments || [],
      cursorBlock: previousState?.cursorBlock ?? null,
      blockTimestamps: previousState?.blockTimestamps || new Map(),
      latestBlock,
      scan: plan,
    }
  }

  const logs = []
  for (const range of plan.ranges) {
    const rawRangeLogs = boundedArray(
      await getLogs(range),
      positiveInteger(responseLogLimit, 'Station per-response log limit'),
      `Station log response for blocks ${range.fromBlock}-${range.toBlock}`,
    )
    const rangeLogs = boundedArray(
      parseLogs(rawRangeLogs),
      positiveInteger(responseLogLimit, 'Station per-response log limit'),
      `Parsed Station logs for blocks ${range.fromBlock}-${range.toBlock}`,
    )
    if (logs.length + rangeLogs.length > positiveInteger(aggregateLogLimit, 'Station aggregate log limit')) {
      throw new Error(`Station scan exceeds the ${aggregateLogLimit}-log aggregate limit. Narrow the configured Station history window.`)
    }
    for (const log of rangeLogs) {
      const blockNumber = nonNegativeBlock(log?.blockNumber, 'Station log blockNumber')
      if (blockNumber < range.fromBlock || blockNumber > range.toBlock) {
        throw new Error(`Station log block ${blockNumber} is outside requested range ${range.fromBlock}-${range.toBlock}`)
      }
      logs.push(log)
    }
  }

  const blockTimestamps = new Map(previousState?.blockTimestamps || [])
  for (const key of blockTimestamps.keys()) {
    const block = nonNegativeBlock(key, 'Station timestamp cache block')
    if (block < plan.retentionFromBlock || block >= plan.fromBlock) blockTimestamps.delete(key)
  }
  const uniqueLogBlocks = new Map()
  for (const log of logs) uniqueLogBlocks.set(log.blockNumber.toString(), log.blockNumber)
  assertCollectionLimit(uniqueLogBlocks, timestampLimit, 'Station timestamp hydration set')
  const combinedTimestampBlocks = new Set([...blockTimestamps.keys(), ...uniqueLogBlocks.keys()])
  assertCollectionLimit(combinedTimestampBlocks, timestampLimit, 'Station retained and pending timestamp set')
  await mapWithConcurrency(uniqueLogBlocks, timestampConcurrency, async ([key, blockNumber]) => {
    const timestamp = await getBlockTimestampMs(blockNumber)
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error(`Station block ${blockNumber} timestamp must be non-negative safe integer milliseconds`)
    }
    blockTimestamps.set(key, timestamp)
  })

  const incomingSegments = logs.map((log) => decodeLog(log, blockTimestamps.get(log.blockNumber.toString())))
  const segments = reconcileStationHistory(previousState?.segments || [], incomingSegments, {
    replaceFromBlock: plan.fromBlock,
    retainFromBlock: plan.retentionFromBlock,
  })
  assertCollectionLimit(segments, retainedLimit, 'Reconciled Station history')
  const cursorBlock = stationHistoryFinalizedCursor({
    previousCursor: previousState?.cursorBlock ?? null,
    fromBlock: plan.fromBlock,
    toBlock: plan.toBlock,
    latestBlock,
    reorgBlockWindow,
  })
  return { segments, cursorBlock, blockTimestamps, latestBlock, scan: plan }
}
