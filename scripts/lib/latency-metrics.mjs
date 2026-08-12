function nonNegativeSafeNumber(value, label) {
  if (typeof value === 'bigint') {
    const number = Number(value)
    if (Number.isSafeInteger(number) && number >= 0) return number
  }
  if (Number.isSafeInteger(value) && value >= 0) return value
  throw new Error(`${label} must be a non-negative safe integer`)
}

export function blockTimestampMs(value, label = 'block timestamp') {
  const seconds = nonNegativeSafeNumber(value, label)
  const milliseconds = seconds * 1000
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`${label} milliseconds must be a safe integer`)
  return milliseconds
}

export async function hydrateEventBlockTimestamps(client, logs, cache = new Map(), { concurrency = 8 } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('timestamp hydration concurrency must be a positive safe integer')
  }
  const missing = new Map()
  for (const log of logs) {
    if (typeof log?.blockNumber !== 'bigint' || log.blockNumber < 0n) {
      throw new Error('SegmentPublished blockNumber must be a non-negative bigint')
    }
    const key = log.blockNumber.toString()
    if (!cache.has(key)) missing.set(key, log.blockNumber)
  }
  const queue = [...missing]
  let cursor = 0
  async function worker() {
    while (cursor < queue.length) {
      const [key, blockNumber] = queue[cursor]
      cursor += 1
      const block = await client.getBlock({ blockNumber })
      cache.set(key, blockTimestampMs(block.timestamp, `block ${key} timestamp`))
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()))
  return cache
}

export function pruneEventBlockTimestamps(cache, logs) {
  const retained = new Set()
  for (const log of logs) {
    if (typeof log?.blockNumber !== 'bigint' || log.blockNumber < 0n) {
      throw new Error('SegmentPublished blockNumber must be a non-negative bigint')
    }
    retained.add(log.blockNumber.toString())
  }
  for (const key of cache.keys()) {
    if (!retained.has(key)) cache.delete(key)
  }
  return cache
}

export function latencySegmentStats(segments, segmentMs) {
  const ordered = [...segments].sort((a, b) => a.sequence - b.sequence)
  const gaps = []
  for (let index = 1; index < ordered.length; index += 1) {
    gaps.push((ordered[index].blockTimestampMs - ordered[index - 1].blockTimestampMs) / 1000)
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
