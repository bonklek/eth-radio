import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function fileSignature(stat) {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

function directorySignature(directoryPath) {
  const stat = fs.statSync(directoryPath)
  return `${stat.mtimeMs}:${stat.ctimeMs}`
}

function requestMatches(manifest, request) {
  if (!request?.streamId) return true
  if (manifest.streamId !== request.streamId) return false
  return !request.publisher || manifest.publisher === request.publisher
}

function manifestSequence(entry) {
  const sequence = entry.manifest?.sequence
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null
}

/**
 * Incrementally discovers and parses a directory of bounded segment manifests.
 * Parsed, immutable manifest data is cached; callers add mutable filesystem
 * enrichment (media readiness and sidecar state) after querying the index.
 */
export function createLocalManifestIndex({
  directoryPath,
  maxManifestBytes,
  maxCacheEntries,
  maxCacheBytes,
  maxScanEntries,
  loadManifest,
  onWarning = /** @type {(key: string, message: string) => void} */ (() => {}),
  onTrace = /** @type {(event: object) => void} */ (() => {}),
  negativeTtlMs = 10_000,
  now = Date.now,
}) {
  if (!Number.isSafeInteger(negativeTtlMs) || negativeTtlMs < 0) {
    throw new Error('negativeTtlMs must be a non-negative safe integer')
  }
  const entries = new Map()
  let cacheBytes = 0
  let clock = 0
  let scan = null
  let completedDirectorySignature = null
  let eligibleCount = 0
  let revalidationCursor = 0
  const completedMisses = new Map()

  function requestKey(request) {
    if (!request?.streamId) return null
    return crypto.createHash('sha256')
      .update(JSON.stringify([request.streamId, request.publisher || null]))
      .digest('hex')
  }

  function recordCompletedMiss(key) {
    completedMisses.delete(key)
    completedMisses.set(key, now())
    while (completedMisses.size > maxCacheEntries) {
      completedMisses.delete(completedMisses.keys().next().value)
    }
  }

  function hasFreshCompletedMiss(key) {
    const completedAt = completedMisses.get(key)
    if (completedAt === undefined) return false
    if (now() - completedAt < negativeTtlMs) return true
    completedMisses.delete(key)
    return false
  }

  function closeScan() {
    if (!scan?.directory) return
    try {
      scan.directory.closeSync()
    } catch {
      // Directory replacement/removal invalidates an outstanding scan handle.
    }
    scan.directory = null
  }

  function reset() {
    closeScan()
    scan = null
    completedDirectorySignature = null
    eligibleCount = 0
    entries.clear()
    cacheBytes = 0
    revalidationCursor = 0
    completedMisses.clear()
  }

  function removeEntry(name) {
    const previous = entries.get(name)
    if (!previous) return
    entries.delete(name)
    cacheBytes -= previous.size
  }

  function evictionCandidate(request) {
    const cached = [...entries.values()]
    const channelCounts = new Map()
    for (const entry of cached) {
      channelCounts.set(entry.manifest.channelKey, (channelCounts.get(entry.manifest.channelKey) || 0) + 1)
    }
    const unprotected = cached.filter((entry) => !requestMatches(entry.manifest, request))
    let candidates = unprotected.length ? unprotected : cached
    const largestChannel = Math.max(...candidates.map((entry) => channelCounts.get(entry.manifest.channelKey) || 0))
    candidates = candidates.filter((entry) => channelCounts.get(entry.manifest.channelKey) === largestChannel)
    const channels = new Map()
    for (const entry of candidates) {
      const channel = channels.get(entry.manifest.channelKey) || []
      channel.push(entry)
      channels.set(entry.manifest.channelKey, channel)
    }
    const victimChannel = [...channels.entries()].sort((left, right) => {
      const leftRecent = Math.max(...left[1].map((entry) => entry.lastUsed))
      const rightRecent = Math.max(...right[1].map((entry) => entry.lastUsed))
      return leftRecent - rightRecent || String(left[0]).localeCompare(String(right[0]))
    })[0]?.[1] || []
    return victimChannel.sort((left, right) => {
      const leftSequence = manifestSequence(left)
      const rightSequence = manifestSequence(right)
      const sequenceOrder = leftSequence != null && rightSequence != null
        ? leftSequence - rightSequence
        : 0
      return sequenceOrder
      || left.mtimeMs - right.mtimeMs
      || left.lastUsed - right.lastUsed
      || left.name.localeCompare(right.name)
    })[0]
  }

  function enforceBounds(request) {
    while (entries.size > maxCacheEntries || cacheBytes > maxCacheBytes) {
      const victim = evictionCandidate(request)
      if (!victim) break
      onTrace({
        type: 'evict',
        victim: { name: victim.name, sequence: victim.manifest?.sequence, channelKey: victim.manifest?.channelKey },
        entries: [...entries.values()].map((entry) => ({ name: entry.name, sequence: entry.manifest?.sequence, channelKey: entry.manifest?.channelKey })),
      })
      removeEntry(victim.name)
    }
  }

  function parseCandidate(candidate, request) {
    if (candidate.size > maxManifestBytes) {
      onWarning(
        `local-size:${candidate.name}`,
        `Skipping local segment manifest ${candidate.name}: exceeds ${maxManifestBytes} bytes.`,
      )
      removeEntry(candidate.name)
      return
    }
    if (candidate.size > maxCacheBytes) {
      onWarning(
        `local-cache-size:${candidate.name}`,
        `Skipping local segment manifest ${candidate.name}: exceeds parsed cache budget ${maxCacheBytes} bytes.`,
      )
      removeEntry(candidate.name)
      return
    }
    let manifest
    try {
      manifest = loadManifest(candidate.path, candidate)
    } catch (error) {
      onWarning(`local-read:${candidate.name}`, `Skipping unreadable local segment manifest ${candidate.name}: ${error.message}`)
      removeEntry(candidate.name)
      return
    }
    if (!manifest) {
      onWarning(`local-invalid:${candidate.name}`, `Skipping invalid local segment manifest ${candidate.name}`)
      removeEntry(candidate.name)
      return
    }
    removeEntry(candidate.name)
    const entry = {
      ...candidate,
      manifest,
      lastUsed: ++clock,
    }
    entries.set(candidate.name, entry)
    cacheBytes += candidate.size
    onTrace({ type: 'add', name: candidate.name, sequence: manifest.sequence, channelKey: manifest.channelKey })
    enforceBounds(request)
  }

  function inspectFile(name, request, seenNames = null) {
    const manifestPath = path.join(directoryPath, name)
    let stat
    try {
      stat = fs.statSync(manifestPath)
    } catch (error) {
      onWarning(`local-stat:${name}`, `Skipping unreadable local segment manifest ${name}: ${error.message}`)
      removeEntry(name)
      return
    }
    if (!stat.isFile()) {
      removeEntry(name)
      return
    }
    seenNames?.add(name)
    if (seenNames && stat.size <= maxManifestBytes) eligibleCount += 1
    const signature = fileSignature(stat)
    const current = entries.get(name)
    if (current?.signature === signature) return
    parseCandidate({
      name,
      path: manifestPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      signature,
    }, request)
  }

  function startScan(signature, request) {
    closeScan()
    scan = {
      directory: fs.opendirSync(directoryPath),
      signature,
      seenNames: new Set(),
      coverageKey: requestKey(request),
      coverageRequest: { ...request },
    }
    eligibleCount = 0
  }

  function discover(request) {
    const signature = directorySignature(directoryPath)
    if (scan && scan.signature !== signature) {
      completedMisses.clear()
      startScan(signature, request)
    }
    if (!scan && completedDirectorySignature !== signature) {
      completedMisses.clear()
      startScan(signature, request)
    }
    if (!scan) return
    if (scan.coverageKey !== requestKey(request)) {
      scan.coverageKey = null
      scan.coverageRequest = null
    }

    let inspected = 0
    while (inspected < maxScanEntries) {
      const directoryEntry = scan.directory.readSync()
      if (!directoryEntry) {
        const completedScanSignature = scan.signature
        const seenNames = scan.seenNames
        const coverageKey = scan.coverageKey
        const coverageRequest = scan.coverageRequest
        closeScan()
        for (const name of entries.keys()) {
          if (!seenNames.has(name)) removeEntry(name)
        }
        const finalDirectorySignature = directorySignature(directoryPath)
        completedDirectorySignature = completedScanSignature
        scan = null
        enforceBounds(request)
        if (finalDirectorySignature !== completedScanSignature) {
          completedMisses.clear()
          startScan(finalDirectorySignature, request)
          return
        }
        if (coverageKey && ![...entries.values()].some((entry) => requestMatches(entry.manifest, coverageRequest))) {
          recordCompletedMiss(coverageKey)
        }
        return
      }
      inspected += 1
      if (!directoryEntry.isFile() || !directoryEntry.name.endsWith('.json')) continue
      inspectFile(directoryEntry.name, request, scan.seenNames)
    }
    onWarning(
      'local-scan-in-progress',
      `Local manifest scan is processing at most ${maxScanEntries} directory entries per request; results remain partial until the bounded scan completes.`,
    )
  }

  function revalidate(request) {
    const cached = [...entries.values()]
    if (!cached.length) return
    const prioritized = cached.filter((entry) => requestMatches(entry.manifest, request))
    const background = cached.filter((entry) => !requestMatches(entry.manifest, request))
    const rotated = background.length
      ? [...background.slice(revalidationCursor % background.length), ...background.slice(0, revalidationCursor % background.length)]
      : []
    const selected = [...prioritized, ...rotated].slice(0, maxScanEntries)
    revalidationCursor += Math.max(0, selected.length - prioritized.length)
    for (const entry of selected) inspectFile(entry.name, request)
  }

  function query(request = {}) {
    if (!fs.existsSync(directoryPath)) {
      reset()
      return { manifests: [], complete: true, eligibleCount: 0, cacheEntries: 0, cacheBytes: 0, negativeEntries: 0 }
    }
    const key = requestKey(request)
    const freshCompletedMiss = key ? hasFreshCompletedMiss(key) : false
    if (!freshCompletedMiss) {
      discover(request)
      revalidate(request)
    }
    let matchingEntries = [...entries.values()].filter((entry) => requestMatches(entry.manifest, request))
    if (!matchingEntries.length && key && !scan && !freshCompletedMiss) {
      // A prior request may have filled the bounded cache with other channels.
      // Rescan incrementally with this identity protected so a busy channel
      // cannot permanently starve a later, quieter requested channel.
      startScan(directorySignature(directoryPath), request)
      discover(request)
      matchingEntries = [...entries.values()].filter((entry) => requestMatches(entry.manifest, request))
    }
    const manifests = []
    for (const entry of matchingEntries) {
      entry.lastUsed = ++clock
      manifests.push({ ...entry.manifest, manifestPath: entry.path })
    }
    enforceBounds(request)
    return {
      manifests,
      complete: scan == null,
      eligibleCount,
      cacheEntries: entries.size,
      cacheBytes,
      negativeEntries: completedMisses.size,
    }
  }

  function stats() {
    return {
      complete: scan == null,
      eligibleCount,
      cacheEntries: entries.size,
      cacheBytes,
      negativeEntries: completedMisses.size,
    }
  }

  return { query, reset, stats }
}
