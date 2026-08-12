import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zeroHash } from 'viem'
import {
  appendPublishedHistory,
  makePublisherState,
  MAX_PUBLISHED_HISTORY,
  MAX_PUBLISHER_STATE_BYTES,
  MAX_SUBMITTED_HISTORY,
  readPublisherState,
  readPublisherStateSnapshot,
  savePublisherState,
} from './lib/publisher-state.mjs'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-publisher-state-bounds-'))

function payloadHash(sequence) {
  return sequence.toString(16).padStart(64, '0')
}

function buildState(count) {
  const state = makePublisherState({
    streamId: 'bounded-stream',
    startSeq: 0,
    previousSegmentHash: zeroHash,
    submitted: true,
  })
  for (let sequence = 0; sequence < count; sequence += 1) {
    appendPublishedHistory(state, {
      sequence,
      previousSegmentHash: sequence === 0 ? zeroHash : `0x${payloadHash(sequence - 1)}`,
      payloadSha256: payloadHash(sequence),
      txHash: `0x${payloadHash(sequence + 1000)}`,
      costWei: '1',
      executionCostWei: '1',
      blobCostWei: '0',
    })
    state.nextSequence = sequence + 1
    state.previousSegmentHash = `0x${payloadHash(sequence)}`
    state.metrics.actualSpendWei = String(sequence + 1)
    state.metrics.actualExecutionSpendWei = String(sequence + 1)
    state.metrics.confirmedCount = sequence + 1
  }
  return state
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`)
}

try {
  const count = MAX_PUBLISHED_HISTORY + 44
  const bounded = buildState(count)
  assert.equal(bounded.published.length, MAX_PUBLISHED_HISTORY)
  assert.equal(bounded.published[0].sequence, 44)
  assert.deepEqual(bounded.historyAnchor, {
    throughSequence: 43,
    payloadSha256: `0x${payloadHash(43)}`,
    publishedCount: 44,
    costWei: '44',
    executionCostWei: '44',
    blobCostWei: '0',
  })

  const boundedPath = path.join(tempRoot, 'bounded.json')
  writeJson(boundedPath, bounded)
  const defaults = makePublisherState({
    streamId: 'bounded-stream',
    startSeq: 0,
    previousSegmentHash: zeroHash,
    submitted: true,
  })
  const loaded = readPublisherState(boundedPath, defaults, { submitted: true })
  assert.equal(loaded.version, 2)
  assert.equal(loaded.published.length, MAX_PUBLISHED_HISTORY)
  assert.equal(loaded.historyAnchor.throughSequence, 43)
  assert.equal(loaded.metrics.actualSpendWei, String(count))

  const legacy = makePublisherState({
    streamId: 'bounded-stream',
    startSeq: 0,
    previousSegmentHash: zeroHash,
    submitted: true,
  })
  delete legacy.version
  delete legacy.historyAnchor
  legacy.published = []
  for (let sequence = 0; sequence < count; sequence += 1) {
    legacy.published.push({
      sequence,
      previousSegmentHash: sequence === 0 ? zeroHash : `0x${payloadHash(sequence - 1)}`,
      payloadSha256: payloadHash(sequence),
      costWei: '1',
      executionCostWei: '1',
      blobCostWei: '0',
    })
  }
  legacy.nextSequence = count
  legacy.previousSegmentHash = `0x${payloadHash(count - 1)}`
  legacy.metrics.actualSpendWei = String(count)
  legacy.metrics.actualExecutionSpendWei = String(count)
  legacy.metrics.confirmedCount = count
  const legacyPath = path.join(tempRoot, 'legacy.json')
  writeJson(legacyPath, legacy)
  const migrated = readPublisherState(legacyPath, defaults, { submitted: true })
  assert.equal(migrated.version, 2)
  assert.equal(migrated.published.length, MAX_PUBLISHED_HISTORY)
  assert.equal(migrated.historyAnchor.publishedCount, 44)

  const gap = structuredClone(bounded)
  gap.historyAnchor.throughSequence -= 1
  const gapPath = path.join(tempRoot, 'gap.json')
  writeJson(gapPath, gap)
  assert.throws(() => readPublisherState(gapPath, defaults, { submitted: true }), /immediately follow historyAnchor/)

  const tooManySubmitted = makePublisherState({
    streamId: 'bounded-stream',
    startSeq: MAX_SUBMITTED_HISTORY + 1,
    previousSegmentHash: zeroHash,
    submitted: true,
  })
  tooManySubmitted.submitted = Array.from({ length: MAX_SUBMITTED_HISTORY + 1 }, (_, sequence) => ({ sequence }))
  const submittedPath = path.join(tempRoot, 'submitted.json')
  writeJson(submittedPath, tooManySubmitted)
  assert.throws(() => readPublisherState(submittedPath, defaults, { submitted: true }), /submitted exceeds/)

  const oversizedPath = path.join(tempRoot, 'oversized.json')
  fs.writeFileSync(oversizedPath, '{}')
  fs.truncateSync(oversizedPath, MAX_PUBLISHER_STATE_BYTES + 1)
  assert.throws(() => readPublisherState(oversizedPath, defaults, { submitted: true }), /exceeds .* bytes/)
  assert.throws(() => readPublisherStateSnapshot(oversizedPath), /exceeds .* bytes/)

  const oversizedState = makePublisherState({
    streamId: 'bounded-stream',
    startSeq: 0,
    previousSegmentHash: zeroHash,
    submitted: true,
  })
  oversizedState.untrustedPadding = 'x'.repeat(MAX_PUBLISHER_STATE_BYTES)
  assert.throws(
    () => savePublisherState(path.join(tempRoot, 'oversized-write.json'), oversizedState),
    /exceeds .* bytes/,
  )

  for (const file of ['publish-live-segments.mjs', 'publish-live-segments-pipelined.mjs']) {
    const source = fs.readFileSync(path.join(process.cwd(), 'scripts', file), 'utf8')
    assert.match(source, /savePublisherState/)
    assert.doesNotMatch(source, /savePublisherStateAtomic/)
  }

  console.log('publisher state bound tests ok')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
