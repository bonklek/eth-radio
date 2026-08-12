import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLocalManifestIndex } from './lib/local-manifest-index.mjs'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-local-index-'))
const publisherA = `0x${'11'.repeat(20)}`
const publisherB = `0x${'22'.repeat(20)}`
let jsonReads = 0
let maxReadsInQuery = 0

function writeManifest(name, { streamId, publisher, sequence, padding = '' }) {
  const filePath = path.join(tempDir, name)
  fs.writeFileSync(filePath, JSON.stringify({
    streamId,
    publisher,
    channelKey: JSON.stringify([publisher, streamId]),
    sequence,
    padding,
  }))
  return filePath
}

function makeIndex(options = {}) {
  return createLocalManifestIndex({
    directoryPath: tempDir,
    maxManifestBytes: 4096,
    maxCacheEntries: options.maxCacheEntries ?? 3,
    maxCacheBytes: options.maxCacheBytes ?? 64 * 1024,
    maxScanEntries: 2,
    loadManifest: (filePath) => {
      jsonReads += 1
      return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    },
  })
}

function query(index, request) {
  const before = jsonReads
  const result = index.query(request)
  maxReadsInQuery = Math.max(maxReadsInQuery, jsonReads - before)
  return result
}

try {
  for (let sequence = 0; sequence < 6; sequence += 1) {
    const filePath = writeManifest(`busy-${sequence}.json`, {
      streamId: 'shared-stream',
      publisher: publisherA,
      sequence,
    })
    const time = new Date(1_700_000_000_000 + sequence * 1000)
    fs.utimesSync(filePath, time, time)
  }
  const quietPath = writeManifest('quiet-publisher.json', {
    streamId: 'shared-stream',
    publisher: publisherB,
    sequence: 7,
  })
  fs.utimesSync(quietPath, new Date(1_600_000_000_000), new Date(1_600_000_000_000))

  const index = makeIndex()
  let busy
  for (let pass = 0; pass < 8; pass += 1) {
    busy = query(index, { streamId: 'shared-stream', publisher: publisherA })
    if (index.stats().complete) break
  }
  assert.ok(busy.manifests.length > 0)
  const firstQuietAttempt = query(index, { streamId: 'shared-stream', publisher: publisherB })
  assert.ok(
    firstQuietAttempt.manifests.length > 0 || firstQuietAttempt.complete === false,
    'an evicted channel request must either find its target or report non-definitive discovery',
  )
  let quiet = firstQuietAttempt
  for (let pass = 0; pass < 8 && !quiet.complete; pass += 1) {
    quiet = query(index, { streamId: 'shared-stream', publisher: publisherB })
  }
  assert.deepEqual(quiet.manifests.map((manifest) => manifest.sequence), [7], 'a busy publisher must not evict a requested quiet publisher on the same stream')
  assert.equal(new Set(quiet.manifests.map((manifest) => manifest.publisher)).size, 1, 'same-stream publishers must remain isolated')
  assert.ok(maxReadsInQuery <= 2, 'one request must parse no more manifests than its scan budget')
  assert.ok(index.stats().cacheEntries <= 3, 'parsed cache cardinality must remain bounded')
  assert.ok(index.stats().cacheBytes <= 64 * 1024, 'parsed cache bytes must remain bounded')

  const warmReads = jsonReads
  quiet = query(index, { streamId: 'shared-stream', publisher: publisherB })
  assert.equal(jsonReads, warmReads, 'an unchanged warm request must perform zero JSON reads')

  writeManifest('quiet-publisher.json', {
    streamId: 'shared-stream',
    publisher: publisherB,
    sequence: 8,
  })
  quiet = query(index, { streamId: 'shared-stream', publisher: publisherB })
  assert.equal(jsonReads, warmReads + 1, 'a changed cached manifest must be reparsed exactly once')
  assert.deepEqual(quiet.manifests.map((manifest) => manifest.sequence), [8])
  const changedWarmReads = jsonReads
  query(index, { streamId: 'shared-stream', publisher: publisherB })
  assert.equal(jsonReads, changedWarmReads, 'the changed manifest must return to zero-reread warm behavior')

  fs.rmSync(quietPath)
  for (let pass = 0; pass < 8 && index.query({ streamId: 'shared-stream', publisher: publisherB }).manifests.length; pass += 1) {
    // Bounded discovery eventually observes deletion without unbounded request work.
  }
  assert.deepEqual(index.query({ streamId: 'shared-stream', publisher: publisherB }).manifests, [])

  const bytesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-local-index-bytes-'))
  try {
    const paths = []
    for (let sequence = 0; sequence < 3; sequence += 1) {
      const filePath = path.join(bytesDir, `${sequence}.json`)
      fs.writeFileSync(filePath, JSON.stringify({
        streamId: `bytes-${sequence}`,
        publisher: publisherA,
        channelKey: `bytes-${sequence}`,
        sequence,
        padding: 'x'.repeat(100),
      }))
      paths.push(filePath)
    }
    const oneFileBytes = fs.statSync(paths[0]).size
    const byteIndex = createLocalManifestIndex({
      directoryPath: bytesDir,
      maxManifestBytes: 4096,
      maxCacheEntries: 10,
      maxCacheBytes: oneFileBytes * 2,
      maxScanEntries: 2,
      loadManifest: (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')),
    })
    for (let pass = 0; pass < 4; pass += 1) {
      byteIndex.query()
      if (byteIndex.stats().complete) break
    }
    assert.equal(byteIndex.stats().cacheEntries, 2, 'byte pressure must evict parsed entries')
    assert.ok(byteIndex.stats().cacheBytes <= oneFileBytes * 2, 'byte eviction must enforce the configured budget')
  } finally {
    fs.rmSync(bytesDir, { recursive: true, force: true })
  }

  const sequenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-local-index-sequence-'))
  try {
    const creationOrder = ['quiet', 4, 3, 0, 2, 1]
    for (const item of creationOrder) {
      const sequence = item === 'quiet' ? 0 : item
      const filePath = path.join(sequenceDir, item === 'quiet' ? 'quiet.json' : `${sequence}.json`)
      fs.writeFileSync(filePath, JSON.stringify({
        streamId: 'sequence-order',
        publisher: item === 'quiet' ? publisherB : publisherA,
        channelKey: item === 'quiet' ? 'quiet-sequence-order' : 'sequence-order',
        sequence,
      }))
      const misleadingTime = new Date(1_700_000_000_000 + (sequence === 2 ? 10_000 : sequence * 1000))
      fs.utimesSync(filePath, misleadingTime, misleadingTime)
    }
    const sequenceIndex = createLocalManifestIndex({
      directoryPath: sequenceDir,
      maxManifestBytes: 4096,
      maxCacheEntries: 2,
      maxCacheBytes: 4096,
      maxScanEntries: 2,
      loadManifest: (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')),
    })
    let sequenceResult
    for (let pass = 0; pass < 5; pass += 1) {
      sequenceResult = sequenceIndex.query({ streamId: 'sequence-order', publisher: publisherA })
      sequenceIndex.query()
      if (sequenceResult.complete) break
    }
    assert.deepEqual(
      sequenceResult.manifests.map((manifest) => manifest.sequence).sort((left, right) => left - right),
      [3, 4],
      'global monitoring must not replace publisher-scoped scan retention or protocol sequence order',
    )
  } finally {
    fs.rmSync(sequenceDir, { recursive: true, force: true })
  }

  const missesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-local-index-misses-'))
  try {
    const missIndex = createLocalManifestIndex({
      directoryPath: missesDir,
      maxManifestBytes: 4096,
      maxCacheEntries: 3,
      maxCacheBytes: 4096,
      maxScanEntries: 2,
      loadManifest: () => null,
    })
    for (let index = 0; index < 12; index += 1) {
      missIndex.query({ streamId: `missing-${index}`, publisher: publisherA })
    }
    assert.ok(missIndex.stats().negativeEntries <= 3, 'request-specific negative discovery cache cardinality must remain bounded')
  } finally {
    fs.rmSync(missesDir, { recursive: true, force: true })
  }

  const expiryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-local-index-expiry-'))
  try {
    const manifest = (streamId, sequence) => JSON.stringify({
      streamId,
      publisher: publisherA,
      channelKey: JSON.stringify([publisherA, streamId]),
      sequence,
    })
    const firstPath = path.join(expiryDir, 'first.json')
    fs.writeFileSync(firstPath, manifest('stream-a', 0))
    fs.writeFileSync(path.join(expiryDir, 'second.json'), manifest('stream-b', 1))
    let fakeNow = 1_000
    const expiryIndex = createLocalManifestIndex({
      directoryPath: expiryDir,
      maxManifestBytes: 4096,
      maxCacheEntries: 1,
      maxCacheBytes: 4096,
      maxScanEntries: 2,
      negativeTtlMs: 50,
      now: () => fakeNow,
      loadManifest: (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')),
    })
    const request = { streamId: 'stream-z', publisher: publisherA }
    for (let pass = 0; pass < 4; pass += 1) expiryIndex.query(request)
    assert.equal(expiryIndex.query(request).manifests.length, 0)

    fs.writeFileSync(firstPath, manifest('stream-z', 0))
    assert.equal(expiryIndex.query(request).manifests.length, 0, 'a fresh negative cache entry should suppress immediate rescans')
    fakeNow += 51
    let discovered = expiryIndex.query(request)
    for (let pass = 0; pass < 4 && !discovered.manifests.length; pass += 1) discovered = expiryIndex.query(request)
    assert.deepEqual(discovered.manifests.map((entry) => entry.streamId), ['stream-z'], 'an expired negative lookup must discover an evicted file rewritten in place')
  } finally {
    fs.rmSync(expiryDir, { recursive: true, force: true })
  }

  console.log('local manifest index tests ok')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
