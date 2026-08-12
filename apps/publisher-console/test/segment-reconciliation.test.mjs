import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { reconcileSegmentResume, sourceIdentity } from '../lib/segment-reconciliation.mjs'

function fixture(mode = 'finite') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-segment-reconcile-'))
  const segments = [0, 1].map((index) => {
    const payload = Buffer.from(`segment-${index}`)
    const file = path.join(directory, `stream-${String(10 + index).padStart(6, '0')}.webm`)
    fs.writeFileSync(file, payload)
    return {
      sequence: 10 + index,
      ...(mode === 'finite' ? { mediaIndex: index } : { captureIndex: index + 4 }),
      file,
      bytes: payload.length,
      payloadSha256: crypto.createHash('sha256').update(payload).digest('hex'),
    }
  })
  return { directory, manifest: { segments, nextCaptureIndex: 6 } }
}

function rejectsMutation(mutator, pattern, mode = 'finite') {
  const value = fixture(mode)
  try {
    mutator(value)
    assert.throws(() => reconcileSegmentResume({
      manifest: value.manifest, segmentDir: value.directory, startSequence: 10, mode,
    }), pattern)
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true })
  }
}

test('PUB-097/AC-01 accepts a fully reconciled finite cursor', () => {
  const value = fixture()
  try {
    assert.deepEqual(reconcileSegmentResume({
      manifest: value.manifest, segmentDir: value.directory, startSequence: 10, mode: 'finite',
    }), { nextSequence: 12, retainedCount: 2 })
  } finally { fs.rmSync(value.directory, { recursive: true, force: true }) }
})

test('PUB-097/AC-02 rejects missing unconfirmed bytes but permits attributed confirmed-prefix cleanup', () => {
  const value = fixture()
  try {
    fs.rmSync(value.manifest.segments[0].file)
    assert.throws(() => reconcileSegmentResume({ manifest: value.manifest, segmentDir: value.directory, startSequence: 10, mode: 'finite' }), /unconfirmed.*missing/)
    assert.doesNotThrow(() => reconcileSegmentResume({ manifest: value.manifest, segmentDir: value.directory, startSequence: 10, mode: 'finite', confirmedCount: 1 }))
  } finally { fs.rmSync(value.directory, { recursive: true, force: true }) }
})

test('PUB-097/AC-03 rejects tampered payload and byte metadata', () => {
  rejectsMutation(({ manifest }) => fs.writeFileSync(manifest.segments[0].file, 'SEGMENT-0'), /digest changed/)
  rejectsMutation(({ manifest }) => { manifest.segments[0].bytes += 1 }, /byte length changed/)
})

test('PUB-097/AC-04 rejects duplicate, gap, reorder, and media-index drift', () => {
  rejectsMutation(({ manifest }) => { manifest.segments[1].sequence = 10 }, /sequence gap or reorder/)
  rejectsMutation(({ manifest }) => { manifest.segments[1].sequence = 12 }, /sequence gap or reorder/)
  rejectsMutation(({ manifest }) => { manifest.segments.reverse() }, /sequence gap or reorder/)
  rejectsMutation(({ manifest }) => { manifest.segments[1].mediaIndex = 9 }, /media index gap or reorder/)
})

test('PUB-097/AC-05 rejects partial and untracked completed segment artifacts', () => {
  rejectsMutation(({ directory }) => fs.writeFileSync(path.join(directory, 'stream.webm.tmp'), 'partial'), /partial segment artifact/)
  rejectsMutation(({ directory }) => fs.writeFileSync(path.join(directory, 'unexpected.webm'), 'extra'), /untracked segment file/)
})

test('PUB-097/AC-06 binds finite resume to source file identity', () => {
  const value = fixture()
  const source = path.join(value.directory, 'source.mp4')
  fs.writeFileSync(source, 'original')
  const identity = sourceIdentity(source)
  value.manifest.sourceIdentity = identity
  assert.doesNotThrow(() => reconcileSegmentResume({ manifest: value.manifest, segmentDir: value.directory, startSequence: 10, mode: 'finite', expectedSourceIdentity: identity }))
  fs.appendFileSync(source, ' changed')
  assert.throws(() => reconcileSegmentResume({ manifest: value.manifest, segmentDir: value.directory, startSequence: 10, mode: 'finite', expectedSourceIdentity: sourceIdentity(source) }), /source identity changed/)
  fs.rmSync(value.directory, { recursive: true, force: true })
})

test('PUB-097/AC-07 rejects live capture epoch cursor and retained-order drift', () => {
  rejectsMutation(({ manifest }) => { manifest.segments[1].captureIndex = 4 }, /capture index duplicate or reorder/, 'live')
  rejectsMutation(({ manifest }) => { manifest.nextCaptureIndex = 5 }, /nextCaptureIndex does not advance/, 'live')
  rejectsMutation(({ directory }) => fs.writeFileSync(path.join(directory, 'capture-000006.part.webm'), 'partial'), /partial segment artifact/, 'live')
})
