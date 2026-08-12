import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  manifestNonNegativeInteger,
  manifestSegmentBytes,
  manifestSegmentFile,
  manifestSegments,
  MAX_SEGMENT_MANIFEST_BYTES,
  MAX_SEGMENT_MANIFEST_ENTRIES,
  readBoundedSegmentManifest,
  segmentEntry,
  segmentEntries,
  waitForManifestSegment,
  waitForStableFile,
} from './lib/segment-input.mjs'
import { serializeSegmentManifest, upsertSegment } from './lib/live-segment-manifest.mjs'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-segment-input-'))
const prefix = 'stream[one]'
const segmentFile = path.join(tempRoot, `${prefix}-000000.webm`)
const manifestPath = path.join(tempRoot, `${prefix}.segments.json`)

function writeManifest(value) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(value)}\n`)
}

try {
  fs.writeFileSync(segmentFile, 'abc')
  fs.writeFileSync(path.join(tempRoot, 'streamxone-000001.webm'), 'wrong prefix')
  assert.deepEqual(segmentEntries(tempRoot, prefix), [{ sequence: 0, file: segmentFile }])
  for (let index = 0; index < 8; index += 1) fs.writeFileSync(path.join(tempRoot, `junk-${index}.txt`), 'junk')
  assert.throws(
    () => segmentEntries(tempRoot, prefix, { maxDirectoryEntries: 3 }),
    /segment input directory .* exceeds the 3-entry safety limit/,
  )
  assert.deepEqual(segmentEntry(tempRoot, prefix, 0), { sequence: 0, file: segmentFile }, 'targeted recurring lookup must not scan junk inventory')

  assert.throws(() => manifestSegments(manifestPath, null), /must be a JSON object/)
  assert.throws(() => manifestSegments(manifestPath, { segments: {} }), /segments must be an array/)
  assert.throws(
    () => manifestSegments(manifestPath, { segments: Array(MAX_SEGMENT_MANIFEST_ENTRIES + 1) }),
    /exceeds .* segment entries/,
  )
  const duplicateEntries = [{ sequence: 0, bytes: 2 }, { sequence: '0', bytes: 3 }]
  assert.throws(
    () => manifestSegments(manifestPath, { segments: duplicateEntries }),
    /duplicate segment sequence 0/,
  )
  assert.throws(
    () => upsertSegment(duplicateEntries, { sequence: 0, bytes: 3 }),
    /duplicate segment sequence 0/,
  )
  const cappedEntries = Array.from({ length: MAX_SEGMENT_MANIFEST_ENTRIES }, (_, sequence) => ({ sequence }))
  assert.equal(upsertSegment(cappedEntries, { sequence: MAX_SEGMENT_MANIFEST_ENTRIES - 1, bytes: 3 }).length, MAX_SEGMENT_MANIFEST_ENTRIES)
  assert.throws(
    () => upsertSegment(cappedEntries, { sequence: MAX_SEGMENT_MANIFEST_ENTRIES }),
    /exceeds .* segment entries/,
  )
  assert.throws(
    () => serializeSegmentManifest({ segments: [], padding: 'x'.repeat(MAX_SEGMENT_MANIFEST_BYTES) }, manifestPath),
    /exceeds .* bytes/,
  )
  assert.equal(manifestNonNegativeInteger('2', 'sequence'), 2)
  assert.throws(() => manifestNonNegativeInteger('-1', 'sequence'), /non-negative integer/)
  assert.throws(() => manifestNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1, 'sequence'), /non-negative integer/)
  assert.equal(manifestSegmentBytes({ bytes: '3' }, 0), 3)
  assert.throws(() => manifestSegmentBytes({ bytes: 0 }, 0), /greater than zero/)

  assert.equal(
    manifestSegmentFile({ dir: tempRoot, filePrefix: prefix, sequence: 0, segment: { file: path.basename(segmentFile) } }),
    segmentFile,
  )
  assert.throws(
    () => manifestSegmentFile({ dir: tempRoot, filePrefix: prefix, sequence: 0, segment: { file: '../escape.webm' } }),
    /points outside the watched segment file/,
  )
  assert.throws(
    () => manifestSegmentFile({ dir: tempRoot, filePrefix: prefix, sequence: 0, segment: { file: `${prefix}-000001.webm` } }),
    /points outside the watched segment file/,
  )

  writeManifest({ segments: [{ sequence: 0, file: path.basename(segmentFile), bytes: 3 }] })
  assert.equal(readBoundedSegmentManifest(manifestPath).segments.length, 1)
  assert.deepEqual(
    await waitForManifestSegment(tempRoot, prefix, 0, 1, true),
    { sequence: 0, file: segmentFile, bytes: 3 },
  )

  writeManifest({ segments: [
    { sequence: 0, file: path.basename(segmentFile), bytes: 2 },
    { sequence: 0, file: path.basename(segmentFile), bytes: 3 },
  ] })
  await assert.rejects(
    waitForManifestSegment(tempRoot, prefix, 0, 1, true, { warn: () => {} }),
    /duplicate segment sequence 0/,
  )

  fs.writeFileSync(manifestPath, '{ malformed json')
  const optionalWarnings = []
  assert.equal(
    await waitForManifestSegment(tempRoot, prefix, 0, 1, false, { warn: (message) => optionalWarnings.push(message) }),
    null,
  )
  assert.equal(optionalWarnings.length, 1)
  assert.match(optionalWarnings[0], /falling back to segment file/)

  fs.writeFileSync(manifestPath, '{ being written')
  const requiredWarnings = []
  let manifestSleeps = 0
  const recovered = await waitForManifestSegment(tempRoot, prefix, 0, 1, true, {
    warn: (message) => requiredWarnings.push(message),
    sleep: async () => {
      manifestSleeps += 1
      writeManifest({ segments: [{ sequence: '0', file: path.basename(segmentFile), bytes: '3' }] })
    },
  })
  assert.equal(recovered.file, segmentFile)
  assert.equal(manifestSleeps, 1)
  assert.equal(requiredWarnings.length, 1)
  assert.match(requiredWarnings[0], /waiting for a valid manifest/)

  writeManifest({ segments: [{ sequence: 0, file: '../escape.webm', bytes: 3 }] })
  await assert.rejects(
    waitForManifestSegment(tempRoot, prefix, 0, 1, true, { warn: () => {} }),
    /points outside the watched segment file/,
  )

  fs.writeFileSync(manifestPath, Buffer.alloc(MAX_SEGMENT_MANIFEST_BYTES + 1, 0x20))
  assert.throws(() => readBoundedSegmentManifest(manifestPath), /exceeds .* bytes/)
  await assert.rejects(
    waitForManifestSegment(tempRoot, prefix, 0, 1, true, { warn: () => {} }),
    /exceeds .* bytes/,
  )

  const unstableFile = path.join(tempRoot, 'unstable.webm')
  fs.writeFileSync(unstableFile, 'a')
  let stableSleeps = 0
  const stable = await waitForStableFile(unstableFile, 1, {
    sleep: async () => {
      stableSleeps += 1
      if (stableSleeps === 1) fs.writeFileSync(unstableFile, 'changed')
    },
  })
  assert.equal(stable.size, 7)
  assert.equal(stableSleeps, 2, 'a changing file must remain pending until two consecutive observations match')

  fs.rmSync(manifestPath)
  const controller = new AbortController()
  await assert.rejects(
    waitForManifestSegment(tempRoot, prefix, 0, 1, true, {
      signal: controller.signal,
      sleep: async () => controller.abort(new Error('test cancellation')),
      warn: () => {},
    }),
    (error) => error.name === 'AbortError' && /test cancellation/.test(error.message),
  )

  for (const caller of ['publish-live-segments.mjs', 'publish-live-segments-pipelined.mjs']) {
    const source = fs.readFileSync(new URL(caller, import.meta.url), 'utf8')
    assert.match(source, /from '\.\/lib\/segment-input\.mjs'/)
    for (const duplicate of [
      'function escapeRegExp(',
      'function segmentEntries(',
      'function manifestSegmentFile(',
      'function manifestSegments(',
      'function manifestNonNegativeInteger(',
      'function manifestSegmentSequence(',
      'function manifestSegmentBytes(',
      'function waitForStableFile(',
      'function waitForManifestSegment(',
    ]) {
      assert.doesNotMatch(source, new RegExp(duplicate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
  }

  for (const caller of ['live-segment-av1-webm.mjs', 'live-composite-rfe-segments.mjs']) {
    const source = fs.readFileSync(new URL(caller, import.meta.url), 'utf8')
    assert.match(source, /serializeSegmentManifest/)
    assert.match(source, /readExistingSegmentManifest/)
    assert.match(source, /upsertSegment/)
  }
  const batchSegmenterSource = fs.readFileSync(new URL('segment-av1-webm.mjs', import.meta.url), 'utf8')
  assert.match(batchSegmenterSource, /serializeSegmentManifest\(manifest, out\)/)
  assert.doesNotMatch(batchSegmenterSource, /JSON\.stringify\(manifest/)
  const orchestratorSource = fs.readFileSync(new URL('run-live-station.mjs', import.meta.url), 'utf8')
  assert.match(orchestratorSource, /readBoundedSegmentManifest/)
  assert.match(orchestratorSource, /segmentManifestEntries/)
  assert.match(orchestratorSource, /serializeSegmentManifest/)

  console.log('segment input tests ok')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
