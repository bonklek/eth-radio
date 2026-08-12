import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { resolveLatestBeaconSlot } from './lib/beacon-head.mjs'
import { assertCompleteBlobSidecarMatches } from './lib/blob-sidecar-matches.mjs'
import { assertLiveSegmentManifestInvariants } from './lib/live-segment-manifest.mjs'
import { prepareSegmentOutputDirectory, segmentOutputEntries } from './lib/segment-output.mjs'
import { streamFilesystemIdentity } from './lib/filesystem-identity.mjs'

const root = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-cli-correctness-'))
let monitorCase = 0

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with ${result.status}\n${result.stdout || ''}${result.stderr || ''}`)
  }
}

function runMonitor(published, staleMs = 60_000) {
  monitorCase += 1
  const statePath = path.join(tempRoot, `monitor-${monitorCase}.json`)
  writeJson(statePath, { streamId: 'stream', nextSequence: 3, published })
  const result = spawnSync(process.execPath, [
    'scripts/monitor-live-stream.mjs',
    '--stream-id',
    'stream',
    '--state',
    statePath,
    '--manifest',
    path.join(tempRoot, 'missing-manifest.json'),
    '--stale-ms',
    String(staleMs),
  ], { cwd: root, encoding: 'utf8' })
  return {
    ...result,
    output: `${result.stdout || ''}${result.stderr || ''}`,
    summary: result.stdout ? JSON.parse(result.stdout) : null,
  }
}

try {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve an ffmpeg binary')

  const firstInput = path.join(tempRoot, 'first-input.mp4')
  const secondInput = path.join(tempRoot, 'second-input.mp4')
  for (const [input, duration] of [[firstInput, '2.2'], [secondInput, '1']]) {
    run(ffmpegPath, [
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=2',
      '-t', duration, '-pix_fmt', 'yuv420p', input,
    ])
  }
  const repeatedOutDir = path.join(tempRoot, 'repeated-segment-output')
  const repeatPrefix = streamFilesystemIdentity('repeat').key
  const segmentArgs = (input) => [
    'scripts/segment-av1-webm.mjs', '--input', input, '--out-dir', repeatedOutDir,
    '--stream-id', 'repeat', '--segment-ms', '1000', '--width', '64', '--height', '64',
    '--fps', '2', '--video-bitrate', '80k', '--no-audio',
  ]
  run(process.execPath, segmentArgs(firstInput))
  const firstManifest = JSON.parse(fs.readFileSync(path.join(repeatedOutDir, `${repeatPrefix}.segments.json`), 'utf8'))
  assert.ok(firstManifest.segments.length >= 2, 'first segmentation should create a stale-tail candidate')
  fs.writeFileSync(path.join(repeatedOutDir, 'unrelated.txt'), 'preserve')
  fs.writeFileSync(path.join(repeatedOutDir, 'other-000000.webm'), 'preserve')
  run(process.execPath, segmentArgs(secondInput))
  const secondManifest = JSON.parse(fs.readFileSync(path.join(repeatedOutDir, `${repeatPrefix}.segments.json`), 'utf8'))
  assert.equal(secondManifest.segments.length, 1)
  assert.deepEqual(secondManifest.segments.map((segment) => segment.sequence), [0])
  assert.deepEqual(
    fs.readdirSync(repeatedOutDir).filter((name) => name.startsWith(`${repeatPrefix}-`) && name.endsWith('.webm')),
    [`${repeatPrefix}-000000.webm`],
  )
  assert.equal(fs.readFileSync(path.join(repeatedOutDir, 'unrelated.txt'), 'utf8'), 'preserve')
  assert.equal(fs.readFileSync(path.join(repeatedOutDir, 'other-000000.webm'), 'utf8'), 'preserve')

  const outputDir = path.join(tempRoot, 'segment-output')
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, 'stream-000000.webm'), 'old zero')
  fs.writeFileSync(path.join(outputDir, 'stream-000001.webm'), 'old one')
  fs.writeFileSync(path.join(outputDir, 'other-000000.webm'), 'keep')
  fs.writeFileSync(path.join(outputDir, 'stream.segments.json'), '{}\n')
  prepareSegmentOutputDirectory(outputDir, 'stream')
  assert.equal(fs.existsSync(path.join(outputDir, 'stream-000000.webm')), false)
  assert.equal(fs.existsSync(path.join(outputDir, 'stream-000001.webm')), false)
  assert.equal(fs.existsSync(path.join(outputDir, 'stream.segments.json')), false)
  assert.equal(fs.existsSync(path.join(outputDir, 'other-000000.webm')), true)

  fs.writeFileSync(path.join(outputDir, 'stream-000001.webm'), 'gap')
  assert.throws(() => segmentOutputEntries(outputDir, 'stream'), /sequence gap/)
  fs.rmSync(path.join(outputDir, 'stream-000001.webm'))
  fs.writeFileSync(path.join(outputDir, 'stream-000000.webm'), 'new zero')
  assert.deepEqual(segmentOutputEntries(outputDir, 'stream').map(({ sequence, bytes }) => ({ sequence, bytes })), [
    { sequence: 0, bytes: 8 },
  ])
  fs.writeFileSync(path.join(outputDir, 'stream-0000000.webm'), 'noncanonical')
  assert.throws(() => segmentOutputEntries(outputDir, 'stream'), /Invalid segment output filename/)

  const hashA = `0x${'a'.repeat(64)}`
  const hashB = `0x${'b'.repeat(64)}`
  assert.throws(
    () => assertCompleteBlobSidecarMatches(new Set([hashA, hashB]), [{ versionedHash: hashA }]),
    new RegExp(hashB),
  )
  assert.doesNotThrow(() => assertCompleteBlobSidecarMatches(
    new Set([hashA, hashB]),
    [{ versionedHash: hashA }, { versionedHash: hashB }],
  ))

  const beaconHead = await resolveLatestBeaconSlot({
    fetchHead: async () => ({ data: { header: { message: { slot: '123' } } } }),
    latestExecutionTimestamp: 1_120n,
    genesisTime: 1_000n,
  })
  assert.deepEqual(beaconHead, { slot: 123n, source: 'beacon-head', warning: null })
  const fallback = await resolveLatestBeaconSlot({
    fetchHead: async () => ({ data: { header: { message: { slot: '01' } } } }),
    latestExecutionTimestamp: 1_120n,
    genesisTime: 1_000n,
  })
  assert.equal(fallback.slot, 10n)
  assert.equal(fallback.source, 'execution-head-timestamp-fallback')
  assert.match(fallback.warning, /potentially lagging slot fallback/)
  await assert.rejects(
    resolveLatestBeaconSlot({
      fetchHead: async () => { throw new Error('unavailable') },
      latestExecutionTimestamp: 999n,
      genesisTime: 1_000n,
    }),
    /before beacon genesis/,
  )

  assert.throws(
    () => assertLiveSegmentManifestInvariants(
      { input: 'old.mp4', segmentMs: 1_000 },
      'stream.segments.json',
      { input: 'new.mp4', segmentMs: 1_000 },
    ),
    /input "old\.mp4" does not match requested "new\.mp4"/,
  )

  for (const [name, published, expectedState] of [
    ['missing', [{ sequence: 1 }], 'missing'],
    ['invalid', [{ sequence: 1, includedAt: 'not-a-date' }], 'invalid'],
    ['future', [{ sequence: 1, includedAt: new Date(Date.now() + 60_000).toISOString() }], 'future'],
    ['stale', [{ sequence: 1, includedAt: new Date(Date.now() - 120_000).toISOString() }], 'stale'],
  ]) {
    const result = runMonitor(published)
    assert.equal(result.status, 2, `${name} inclusion should be unhealthy\n${result.output}`)
    assert.equal(result.summary.latestInclusionState, expectedState)
    assert.equal(result.summary.ok, false)
  }

  const fresh = new Date().toISOString()
  const sorted = runMonitor([
    { sequence: 2, includedAt: fresh, txHash: `0x${'2'.repeat(64)}` },
    { sequence: 0, includedAt: 'invalid-old-entry' },
    { sequence: 1, includedAt: fresh, txHash: `0x${'1'.repeat(64)}` },
  ])
  assert.equal(sorted.status, 0, sorted.output)
  assert.equal(sorted.summary.latestSequence, 2)
  assert.equal(sorted.summary.latestInclusionState, 'fresh')
  assert.equal(sorted.summary.invalidIncludedAtCount, 1)

  const sourceChecks = [
    ['scripts/segment-av1-webm.mjs', ['prepareSegmentOutputDirectory(outDir, filePrefix)', 'segmentOutputEntries(outDir, filePrefix)']],
    ['scripts/fetch-blob-sidecars.mjs', ['assertCompleteBlobSidecarMatches(wanted, matches)']],
    ['scripts/blob-slot-metrics.mjs', ["fetchHead: () => beacon(beaconUrl, '/eth/v1/beacon/headers/head')", 'latestSlotSource: latestSlotResolution.source']],
    ['scripts/live-segment-av1-webm.mjs', ['invariants: manifestInvariants']],
    ['scripts/live-composite-rfe-segments.mjs', ['invariants: manifestInvariants']],
  ]
  for (const [file, markers] of sourceChecks) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    for (const marker of markers) assert.ok(source.includes(marker), `${file} is missing ${marker}`)
  }
  const fetchSource = fs.readFileSync(path.join(root, 'scripts/fetch-blob-sidecars.mjs'), 'utf8')
  assert.ok(
    fetchSource.indexOf('assertCompleteBlobSidecarMatches(wanted, matches)') < fetchSource.indexOf("fs.mkdirSync('work/blob-radio-testnet/sidecars'"),
    'sidecar completeness must be checked before any output write',
  )

  console.log('CLI correctness tests ok')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
