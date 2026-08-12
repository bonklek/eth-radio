import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readDirectoryBoundedSync } from './lib/bounded-directory.mjs'
import { printableSingleLineDiagnostic } from './lib/endpoint-privacy.mjs'
import { checkLoopbackRequest } from './lib/loopback-request-policy.mjs'
import { createProofRunIndex } from './lib/proof-run-index.mjs'
import { segmentEntry } from './lib/segment-input.mjs'
import { prepareSegmentOutputDirectory } from './lib/segment-output.mjs'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-security-remediation-'))
const publisher = `0x${'12'.repeat(20)}`

try {
  const policyBase = { method: 'GET', headers: { host: '127.0.0.1:5199' } }
  assert.equal(checkLoopbackRequest(policyBase, { port: 5199 }).ok, true)
  assert.equal(checkLoopbackRequest({ ...policyBase, method: 'POST' }, { port: 5199 }).status, 405)
  assert.equal(checkLoopbackRequest({ ...policyBase, headers: { ...policyBase.headers, origin: 'https://attacker.invalid' } }, { port: 5199 }).status, 403)
  assert.equal(checkLoopbackRequest({ ...policyBase, headers: { ...policyBase.headers, 'sec-fetch-site': 'cross-site' } }, { port: 5199 }).status, 403)
  assert.equal(checkLoopbackRequest({ ...policyBase, headers: { host: 'attacker.invalid:5199' } }, { port: 5199 }).status, 403)

  const terminalCanary = 'rpc\rforged\u001b]52;c;YQ==\u0007\u202esecret\nnext'
  const printable = printableSingleLineDiagnostic(terminalCanary)
  assert(!Array.from(printable).some((character) => ['\r', '\n', '\u001b', '\u0007', '\u202e'].includes(character)))
  assert(printable.includes('\\u001b') && printable.includes('\\u0007') && printable.includes('\\u202e'))

  const output = path.join(tempRoot, 'explicit-output')
  fs.mkdirSync(output)
  const sentinel = path.join(output, 'unrelated-sentinel.txt')
  fs.writeFileSync(sentinel, 'preserve')
  fs.writeFileSync(path.join(output, 'owned-000000.webm'), 'generated')
  prepareSegmentOutputDirectory(output, 'owned')
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve')
  assert.equal(fs.existsSync(path.join(output, 'owned-000000.webm')), false)

  for (let index = 0; index < 12; index += 1) fs.writeFileSync(path.join(output, `junk-${index}.txt`), 'junk')
  assert.throws(() => readDirectoryBoundedSync(output, { maxEntries: 4 }), /exceeds the 4-entry safety limit/)
  const targeted = path.join(output, 'owned-000007.webm')
  fs.writeFileSync(targeted, 'target')
  assert.deepEqual(segmentEntry(output, 'owned', 7), { sequence: 7, file: targeted })

  const proofRuns = path.join(tempRoot, 'proof-runs')
  fs.mkdirSync(proofRuns)
  for (let index = 0; index < 30; index += 1) {
    const run = path.join(proofRuns, `run-${String(index).padStart(2, '0')}`)
    fs.mkdirSync(run)
    fs.writeFileSync(path.join(run, '.stream-identity.json'), JSON.stringify({
      scope: {
        streamId: index === 29 ? 'target-stream' : `noise-${index}`,
        publisher: index === 29 ? publisher : `0x${String(index + 1).padStart(40, '0')}`,
      },
    }))
  }
  fs.writeFileSync(path.join(proofRuns, 'mixed-file.txt'), 'not a run')
  const proofIndex = createProofRunIndex({
    directory: proofRuns,
    maxEntriesPerBatch: 3,
    maxCacheEntries: 40,
    loadMarker: (markerPath) => JSON.parse(fs.readFileSync(markerPath, 'utf8')),
  })
  let found = false
  let completed = false
  let inspected = 0
  for (let pass = 0; pass < 20 && !completed; pass += 1) {
    const result = proofIndex.query({ streamId: 'target-stream', publisher })
    assert(result.inspected <= 3)
    found ||= result.directories.length === 1
    completed = result.complete
    inspected += result.inspected
  }
  proofIndex.close()
  assert.equal(completed, true)
  assert.equal(found, true, 'cursor must eventually reveal an eligible record beyond early sparse/mixed batches')
  assert(inspected > 3)

  const lateRuns = path.join(tempRoot, 'late-proof-runs')
  fs.mkdirSync(lateRuns)
  for (let index = 0; index < 8; index += 1) {
    const run = path.join(lateRuns, `run-${index}`)
    fs.mkdirSync(run)
    if (index > 0) {
      fs.writeFileSync(path.join(run, '.stream-identity.json'), JSON.stringify({
        scope: { streamId: `initial-${index}`, publisher },
      }))
    }
    const timestamp = new Date(1_700_000_000_000 + index * 1_000)
    fs.utimesSync(run, timestamp, timestamp)
  }
  const lateIndex = createProofRunIndex({
    directory: lateRuns,
    maxEntriesPerBatch: 2,
    maxCacheEntries: 3,
    loadMarker: (markerPath) => JSON.parse(fs.readFileSync(markerPath, 'utf8')),
  })
  let initialLateScanComplete = false
  while (!initialLateScanComplete) initialLateScanComplete = lateIndex.advance().complete
  const lateMarker = path.join(lateRuns, 'run-0', '.stream-identity.json')
  fs.writeFileSync(lateMarker, JSON.stringify({ scope: { streamId: 'late-stream', publisher } }))
  let lateDiscovered = false
  for (let pass = 0; pass < 8 && !lateDiscovered; pass += 1) {
    const progress = lateIndex.advance()
    assert(progress.inspected <= 2)
    lateDiscovered = lateIndex.query({ streamId: 'late-stream', publisher, scan: false }).directories.length === 1
  }
  assert.equal(lateDiscovered, true, 'bounded recurring scans must rediscover a late marker even after cache eviction')

  fs.writeFileSync(lateMarker, JSON.stringify({ scope: { streamId: 'changed-stream', publisher } }))
  let changedDiscovered = false
  for (let pass = 0; pass < 8 && !changedDiscovered; pass += 1) {
    lateIndex.advance()
    changedDiscovered = lateIndex.query({ streamId: 'changed-stream', publisher, scan: false }).directories.length === 1
  }
  assert.equal(changedDiscovered, true, 'bounded recurring scans must refresh changed marker identity')
  assert.equal(lateIndex.query({ streamId: 'late-stream', publisher, scan: false }).directories.length, 0)
  lateIndex.close()

  const runSource = fs.readFileSync(new URL('./run-live-station.mjs', import.meta.url), 'utf8')
  assert(!runSource.includes('fs.rmSync(outDir, { recursive: true'), 'explicit output roots must never be recursively deleted')
  assert(runSource.includes('prepareOwnedSegmentDirectory(outDir, filePrefix)'))
  const demoSource = fs.readFileSync(new URL('./serve-live-demo.mjs', import.meta.url), 'utf8')
  assert(!demoSource.includes('fs.readdirSync(liveRunDir'), 'recurring proof discovery must use its bounded cursor')
  assert(demoSource.indexOf('checkLoopbackRequest(request, { port })') < demoSource.indexOf('networkContext(parsed.searchParams'))

  console.log('security remediation tests ok')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
