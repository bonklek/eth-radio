import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertStationEventMetadata,
  manifestBlobVersionedHashes,
  normalizeBlobVersionedHashes,
  stationEventSequenceMatches,
} from './lib/publisher-manifest.mjs'

const hashA = `0x${'Aa'.repeat(32)}`
const hashB = `0x${'Bb'.repeat(32)}`
const normalizedA = hashA.toLowerCase()
const normalizedB = hashB.toLowerCase()

const expectedMetadata = {
  streamId: 'station-stream',
  durationMs: 12_000,
  payloadBytes: 456,
  payloadSha256: hashA,
  codec: 'av1/webm',
  previousSegmentHash: hashB,
}
const matchingMetadataEvent = {
  args: {
    streamId: expectedMetadata.streamId,
    durationMs: 12_000n,
    payloadBytes: 456n,
    payloadSha256: normalizedA,
    codec: expectedMetadata.codec,
    previousSegmentHash: normalizedB,
  },
}
assert.equal(assertStationEventMetadata(matchingMetadataEvent, expectedMetadata), matchingMetadataEvent)
for (const [field, value] of [
  ['streamId', 'other-stream'],
  ['durationMs', 11_999n],
  ['payloadBytes', 455n],
  ['payloadSha256', hashB],
  ['codec', 'other/codec'],
  ['previousSegmentHash', hashA],
]) {
  assert.throws(
    () => assertStationEventMetadata(
      { args: { ...matchingMetadataEvent.args, [field]: value } },
      expectedMetadata,
    ),
    new RegExp(`Station event ${field} does not match`),
  )
}
assert.throws(() => assertStationEventMetadata(null, expectedMetadata), /metadata is missing/)

assert.equal(stationEventSequenceMatches(7n, 7), true)
assert.equal(stationEventSequenceMatches(7n, '7'), true)
assert.equal(stationEventSequenceMatches(8n, 7), false)
assert.equal(stationEventSequenceMatches('7', 7), false)
assert.equal(stationEventSequenceMatches('not-a-sequence', 7), false)

assert.deepEqual(normalizeBlobVersionedHashes([hashA, hashB], 'hashes'), [normalizedA, normalizedB])
assert.deepEqual(normalizeBlobVersionedHashes([], 'hashes'), [])
assert.equal(normalizeBlobVersionedHashes(null, 'hashes', { optional: true }), null)
assert.equal(normalizeBlobVersionedHashes(undefined, 'hashes', { optional: true }), null)
for (const value of [null, undefined, {}, 'not-an-array']) {
  assert.throws(() => normalizeBlobVersionedHashes(value, 'hashes'), /hashes must be an array/)
}
for (const value of [['0x12'], [''], [null], [123]]) {
  assert.throws(() => normalizeBlobVersionedHashes(value, 'hashes'), /invalid bytes32 hash/)
}

const event = { args: { blobVersionedHashes: [hashB] } }
assert.deepEqual(manifestBlobVersionedHashes({ blobVersionedHashes: [hashB] }, event), [normalizedB])
assert.deepEqual(manifestBlobVersionedHashes({ blobVersionedHashes: null }, event), [normalizedB])
assert.deepEqual(manifestBlobVersionedHashes({ blobVersionedHashes: undefined }, event), [normalizedB])
assert.deepEqual(manifestBlobVersionedHashes({ blobVersionedHashes: [] }, event), [normalizedB])
assert.deepEqual(manifestBlobVersionedHashes({ blobVersionedHashes: [hashA] }), [normalizedA])
assert.deepEqual(
  manifestBlobVersionedHashes(
    { blobVersionedHashes: [hashA, hashA] },
    { args: { blobVersionedHashes: [hashA, hashA] } },
  ),
  [normalizedA, normalizedA],
)
for (const [transactionHashes, eventHashes] of [
  [[hashA], [hashB]],
  [[hashA], [hashA, hashB]],
  [[hashA, hashB], [hashB, hashA]],
]) {
  assert.throws(
    () => manifestBlobVersionedHashes(
      { blobVersionedHashes: transactionHashes },
      { args: { blobVersionedHashes: eventHashes } },
    ),
    /do not match exactly/,
  )
}
assert.throws(() => manifestBlobVersionedHashes({ blobVersionedHashes: null }), /must be an array/)
assert.throws(() => manifestBlobVersionedHashes({ blobVersionedHashes: [] }), /requires at least one/)
assert.throws(
  () => manifestBlobVersionedHashes({ blobVersionedHashes: [] }, { args: { blobVersionedHashes: [] } }),
  /Station event must contain at least one/,
)
assert.throws(
  () => manifestBlobVersionedHashes({ blobVersionedHashes: null }, { args: { blobVersionedHashes: ['bad'] } }),
  /Station event blobVersionedHashes contains invalid bytes32 hash/,
)

const root = process.cwd()
for (const file of ['publish-blob-chunk.mjs', 'publish-live-segments-pipelined.mjs']) {
  const source = fs.readFileSync(path.join(root, 'scripts', file), 'utf8')
  assert.match(source, /from '\.\/lib\/publisher-manifest\.mjs'/)
  assert.match(source, /assertStationEventMetadata\(/)
  assert.match(source, /stationEventSequenceMatches\(/)
  assert.match(source, /blobVersionedHashes: manifestBlobVersionedHashes\(transaction, stationEvent\)/)
  assert.doesNotMatch(source, /function normalizeBlobVersionedHashes\(/)
  assert.doesNotMatch(source, /function stationEventSequenceMatches\(/)
  assert.doesNotMatch(source, /function manifestBlobVersionedHashes\(/)
}

console.log('publisher manifest tests ok')
