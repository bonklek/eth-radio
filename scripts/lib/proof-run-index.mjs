import fs from 'node:fs'
import path from 'node:path'
import { createDirectoryCursor } from './bounded-directory.mjs'

function directorySignature(directory) {
  const stat = fs.statSync(directory, { bigint: true })
  return `${stat.mtimeNs}:${stat.ctimeNs}`
}

export function createProofRunIndex({
  directory,
  loadMarker,
  maxEntriesPerBatch = 256,
  maxCacheEntries = 10_000,
}) {
  if (!Number.isSafeInteger(maxCacheEntries) || maxCacheEntries < 1) throw new Error('maxCacheEntries must be positive')
  let cursor = null
  let signature = null
  let scanComplete = false
  let hasCompletedScan = false
  let seen = new Set()
  const cache = new Map()
  const channels = new Map()

  function channelKey(streamId, publisher) {
    return `${streamId}\u0000${String(publisher).toLowerCase()}`
  }

  function rebuildChannels() {
    channels.clear()
    for (const entry of cache.values()) {
      if (!entry.marker) continue
      const key = channelKey(entry.marker.scope.streamId, entry.marker.scope.publisher)
      const records = channels.get(key) || []
      records.push(entry)
      channels.set(key, records)
    }
    for (const records of channels.values()) {
      records.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name))
    }
  }

  function resetCursor(nextSignature) {
    cursor?.close()
    cursor = createDirectoryCursor(directory, { maxEntriesPerBatch })
    signature = nextSignature
    scanComplete = false
    seen = new Set()
  }

  function enforceCacheBound() {
    if (cache.size <= maxCacheEntries) return
    const oldest = [...cache.values()]
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name))
      .slice(maxCacheEntries)
    for (const entry of oldest) cache.delete(entry.name)
  }

  function inspectRun(name) {
    const runDirectory = path.join(directory, name)
    let directoryStat
    try {
      directoryStat = fs.lstatSync(runDirectory)
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        cache.delete(name)
        return
      }
    } catch {
      cache.delete(name)
      return
    }
    const markerPath = path.join(runDirectory, '.stream-identity.json')
    try {
      const markerStat = fs.lstatSync(markerPath)
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('marker is not a plain file')
      const marker = loadMarker(markerPath)
      if (!marker?.scope?.streamId || !marker?.scope?.publisher) throw new Error('marker scope is incomplete')
      cache.set(name, { name, runDirectory, marker, mtimeMs: markerStat.mtimeMs })
    } catch {
      cache.set(name, { name, runDirectory, marker: null, mtimeMs: directoryStat.mtimeMs })
    }
  }

  function scanBatch() {
    if (!fs.existsSync(directory)) {
      cursor?.close()
      cursor = null
      signature = null
      scanComplete = false
      hasCompletedScan = true
      cache.clear()
      channels.clear()
      return { complete: true, inspected: 0 }
    }
    const currentSignature = directorySignature(directory)
    if (currentSignature !== signature) {
      resetCursor(currentSignature)
      hasCompletedScan = false
    }
    // Continue with bounded full-directory cycles after the first scan. Merely
    // revalidating retained cache entries can permanently miss a late marker in
    // a directory evicted by maxCacheEntries, and cannot rediscover evicted
    // entries whose marker changes channel identity.
    if (scanComplete && !cursor) resetCursor(currentSignature)
    if (!cursor) resetCursor(currentSignature)
    const batch = cursor.next()
    for (const entry of batch.entries) {
      seen.add(entry.name)
      if (!entry.isDirectory()) {
        cache.delete(entry.name)
        continue
      }
      inspectRun(entry.name)
    }
    if (batch.complete) {
      for (const name of cache.keys()) if (!seen.has(name)) cache.delete(name)
      cursor = null
      signature = currentSignature
      scanComplete = true
      hasCompletedScan = true
    }
    enforceCacheBound()
    rebuildChannels()
    return { complete: hasCompletedScan, inspected: batch.entries.length }
  }

  function query({ streamId, publisher, scan = true }) {
    const progress = scan ? scanBatch() : { complete: hasCompletedScan, inspected: 0 }
    const key = channelKey(streamId, publisher)
    const matches = channels.get(key) || []
    return { directories: matches.map((entry) => entry.runDirectory), ...progress, cacheEntries: cache.size }
  }

  function close() {
    cursor?.close()
    cursor = null
    scanComplete = false
    hasCompletedScan = false
  }

  return { query, advance: scanBatch, close }
}
