import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { appendRotatingLineSync, forEachBoundedLineSync, readBoundedJsonFileSync, sha256FileSync } from './lib/bounded-files.mjs'
import {
  legacyFilesystemKey,
  MAX_LATENCY_LOG_BYTES,
  resolveRunDirectory,
  resolveScopedJsonPath,
  resolveSegmentSet,
  scopedStreamFilesystemIdentity,
  streamFilesystemIdentity,
} from './lib/filesystem-identity.mjs'

const root = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-filesystem-identity-'))
const streamA = 'a/b'
const streamB = 'a?b'
const streamIdentityA = streamFilesystemIdentity(streamA)
const streamIdentityB = streamFilesystemIdentity(streamB)
const scopeA = scopedStreamFilesystemIdentity({ chain: 'sepolia', station: '0xstation', publisher: '0xpublisher-a', streamId: streamA })
const scopeB = scopedStreamFilesystemIdentity({ chain: 'sepolia', station: '0xstation', publisher: '0xpublisher-a', streamId: streamB })

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function runNode(script, args) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  })
}

try {
  assert.equal(legacyFilesystemKey(streamA), legacyFilesystemKey(streamB))
  for (const hostile of ['.', '..', '...', '/', '\\', 'CON', 'con.txt', 'NUL', 'LPT9.log', 'é/../文件']) {
    const key = legacyFilesystemKey(hostile)
    assert.notEqual(key, '.')
    assert.notEqual(key, '..')
    assert.equal(path.basename(key), key)
    assert.doesNotMatch(key, /[\\/]/)
    assert.doesNotMatch(key, /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i)
  }
  assert.notEqual(streamIdentityA.key, streamIdentityB.key)
  assert.notEqual(scopeA.key, scopeB.key)
  assert.notEqual(
    scopeA.key,
    scopedStreamFilesystemIdentity({ chain: 'mainnet', station: '0xstation', publisher: '0xpublisher-a', streamId: streamA }).key,
  )
  assert.notEqual(
    scopeA.key,
    scopedStreamFilesystemIdentity({ chain: 'sepolia', station: '0xstation', publisher: '0xpublisher-b', streamId: streamA }).key,
  )

  const segmentDir = path.join(tempRoot, 'segments')
  fs.mkdirSync(segmentDir, { recursive: true })
  const legacyPrefix = legacyFilesystemKey(streamA)
  const legacyFile = path.join(segmentDir, `${legacyPrefix}-000000.webm`)
  fs.writeFileSync(legacyFile, 'legacy segment payload')
  const payloadSha256 = crypto.createHash('sha256').update(fs.readFileSync(legacyFile)).digest('hex')
  writeJson(path.join(segmentDir, `${legacyPrefix}.segments.json`), {
    streamId: streamA,
    filePrefix: legacyPrefix,
    segments: [{ sequence: 0, file: legacyFile, bytes: fs.statSync(legacyFile).size, payloadSha256 }],
  })
  const migratedSet = resolveSegmentSet({ directory: segmentDir, streamId: streamA })
  assert.equal(migratedSet.filePrefix, streamIdentityA.key)
  assert.equal(migratedSet.manifest.streamId, streamA)
  assert.equal(migratedSet.manifest.filesystemIdentity.key, streamIdentityA.key)
  assert.equal(fs.existsSync(migratedSet.manifest.segments[0].file), true)
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(migratedSet.manifest.segments[0].file)).digest('hex'), payloadSha256)

  fs.writeFileSync(path.join(segmentDir, `${legacyPrefix}-000000.webm`), 'other collision')
  writeJson(path.join(segmentDir, `${legacyPrefix}.segments.json`), {
    streamId: streamB,
    filePrefix: legacyPrefix,
    segments: [{ sequence: 0, file: path.join(segmentDir, `${legacyPrefix}-000000.webm`) }],
  })
  const migratedCollisionSet = resolveSegmentSet({ directory: segmentDir, streamId: streamB })
  assert.equal(migratedCollisionSet.filePrefix, streamIdentityB.key)
  assert.notEqual(migratedCollisionSet.manifest.segments[0].file, migratedSet.manifest.segments[0].file)

  const stateDir = path.join(tempRoot, 'states')
  const legacyState = path.join(stateDir, `${legacyPrefix}.json`)
  const scopedState = path.join(stateDir, `${scopeA.key}.json`)
  writeJson(legacyState, { streamId: streamA, nextSequence: 0, previousSegmentHash: `0x${'00'.repeat(32)}`, published: [] })
  assert.equal(resolveScopedJsonPath({
    targetPath: scopedState,
    legacyPath: legacyState,
    streamId: streamA,
    identity: scopeA,
    description: 'test publisher state',
  }), scopedState)
  assert.equal(JSON.parse(fs.readFileSync(scopedState, 'utf8')).filesystemIdentity.key, scopeA.key)
  writeJson(legacyState, { streamId: streamB, nextSequence: 0, previousSegmentHash: `0x${'00'.repeat(32)}`, published: [] })
  assert.throws(() => resolveScopedJsonPath({
    targetPath: scopedState,
    legacyPath: legacyState,
    streamId: streamA,
    identity: scopeA,
    description: 'test publisher state',
  }), /Both scoped and legacy|does not match/)

  const runBase = path.join(tempRoot, 'runs')
  const legacyRun = path.join(runBase, legacyPrefix)
  writeJson(path.join(legacyRun, 'status.json'), { streamId: streamA })
  const scopedRun = resolveRunDirectory({ baseDir: runBase, streamId: streamA, identity: scopeA })
  assert.equal(scopedRun, path.join(runBase, scopeA.key))
  assert.equal(fs.existsSync(path.join(scopedRun, '.stream-identity.json')), true)

  const interruptedLegacyBase = path.join(tempRoot, 'interrupted-legacy-runs')
  const interruptedLegacyRun = path.join(interruptedLegacyBase, legacyPrefix)
  writeJson(path.join(interruptedLegacyRun, 'status.json'), { streamId: streamA })
  writeJson(path.join(interruptedLegacyRun, '.stream-identity.json'), scopeA)
  assert.equal(
    resolveRunDirectory({ baseDir: interruptedLegacyBase, streamId: streamA, identity: scopeA }),
    path.join(interruptedLegacyBase, scopeA.key),
    'restart after legacy marker publication but before rename must finish migration',
  )

  const dotRunBase = path.join(tempRoot, 'dot-runs')
  const dotParentSentinel = path.join(tempRoot, 'dot-parent-sentinel.txt')
  fs.writeFileSync(dotParentSentinel, 'preserve')
  const dotIdentity = scopedStreamFilesystemIdentity({
    chain: 'sepolia', station: '0xstation', publisher: '0xpublisher-a', streamId: '..',
  })
  const dotRun = resolveRunDirectory({ baseDir: dotRunBase, streamId: '..', identity: dotIdentity })
  assert.equal(path.dirname(dotRun), path.resolve(dotRunBase), 'dot-only legacy IDs must remain inside the run root')
  assert.equal(fs.readFileSync(dotParentSentinel, 'utf8'), 'preserve')

  const interruptedBase = path.join(tempRoot, 'interrupted-runs')
  const interruptedIdentity = scopedStreamFilesystemIdentity({
    chain: 'sepolia', station: '0xstation', publisher: '0xpublisher-a', streamId: 'interrupted',
  })
  const interruptedTarget = path.join(interruptedBase, interruptedIdentity.key)
  fs.mkdirSync(interruptedTarget, { recursive: true })
  assert.equal(
    resolveRunDirectory({ baseDir: interruptedBase, streamId: 'interrupted', identity: interruptedIdentity }),
    interruptedTarget,
    'an exact empty target left between mkdir and marker publication must recover',
  )
  assert.equal(JSON.parse(fs.readFileSync(path.join(interruptedTarget, '.stream-identity.json'), 'utf8')).key, interruptedIdentity.key)

  const unownedIdentity = scopedStreamFilesystemIdentity({
    chain: 'sepolia', station: '0xstation', publisher: '0xpublisher-a', streamId: 'unowned',
  })
  const unownedTarget = path.join(interruptedBase, unownedIdentity.key)
  fs.mkdirSync(unownedTarget)
  fs.writeFileSync(path.join(unownedTarget, 'sentinel.txt'), 'do not adopt')
  assert.throws(
    () => resolveRunDirectory({ baseDir: interruptedBase, streamId: 'unowned', identity: unownedIdentity }),
    /no identity marker and is not empty/,
  )
  assert.equal(fs.readFileSync(path.join(unownedTarget, 'sentinel.txt'), 'utf8'), 'do not adopt')

  const mismatchedIdentity = scopedStreamFilesystemIdentity({
    chain: 'sepolia', station: '0xstation', publisher: '0xpublisher-a', streamId: 'mismatched',
  })
  const mismatchedTarget = path.join(interruptedBase, mismatchedIdentity.key)
  fs.mkdirSync(mismatchedTarget)
  writeJson(path.join(mismatchedTarget, '.stream-identity.json'), interruptedIdentity)
  assert.throws(
    () => resolveRunDirectory({ baseDir: interruptedBase, streamId: 'mismatched', identity: mismatchedIdentity }),
    /does not match the requested stream scope/,
  )

  const symlinkIdentity = scopedStreamFilesystemIdentity({
    chain: 'sepolia', station: '0xstation', publisher: '0xpublisher-a', streamId: 'symlinked',
  })
  const symlinkTarget = path.join(interruptedBase, symlinkIdentity.key)
  const symlinkDestination = path.join(tempRoot, 'symlink-destination')
  fs.mkdirSync(symlinkDestination)
  try {
    fs.symlinkSync(symlinkDestination, symlinkTarget, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(
      () => resolveRunDirectory({ baseDir: interruptedBase, streamId: 'symlinked', identity: symlinkIdentity }),
      /must be a plain directory/,
    )
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error
  }

  const boundedDir = path.join(tempRoot, 'bounded')
  const boundedJson = path.join(boundedDir, 'record.json')
  writeJson(boundedJson, { ok: true })
  assert.deepEqual(readBoundedJsonFileSync(boundedJson, { maxBytes: 64, label: 'bounded test JSON' }), { ok: true })
  fs.writeFileSync(path.join(boundedDir, 'hash.bin'), 'abc')
  assert.equal(sha256FileSync(path.join(boundedDir, 'hash.bin')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.throws(
    () => readBoundedJsonFileSync(boundedJson, { maxBytes: 2, label: 'bounded test JSON' }),
    /bounded test JSON exceeds 2 bytes/,
  )

  const rotatingLog = path.join(boundedDir, 'latency.jsonl')
  appendRotatingLineSync(rotatingLog, JSON.stringify({ streamId: streamA, n: 1 }), { maxBytes: 80 })
  const rotation = appendRotatingLineSync(rotatingLog, JSON.stringify({ streamId: streamA, payload: 'x'.repeat(40) }), { maxBytes: 80 })
  assert.equal(rotation.rotated, true)
  assert.equal(fs.existsSync(`${rotatingLog}.1`), true)
  const streamedRecords = []
  forEachBoundedLineSync(rotatingLog, (line) => {
    if (line) streamedRecords.push(JSON.parse(line))
  }, { maxBytes: 80, label: 'rotating latency log' })
  assert.equal(streamedRecords.length, 1)
  assert.equal(streamedRecords[0].streamId, streamA)

  const latencyOnlyBase = path.join(tempRoot, 'latency-only-runs')
  const latencyLegacyDir = path.join(latencyOnlyBase, legacyPrefix)
  const latencyLegacyLog = path.join(latencyLegacyDir, 'logs', 'latency-monitor.jsonl')
  fs.mkdirSync(path.dirname(latencyLegacyLog), { recursive: true })
  fs.writeFileSync(latencyLegacyLog, `${JSON.stringify({ streamId: streamA })}\n${JSON.stringify({ streamId: streamA })}\n`)
  const latencyMigrated = resolveRunDirectory({ baseDir: latencyOnlyBase, streamId: streamA, identity: scopeA })
  assert.equal(latencyMigrated, path.join(latencyOnlyBase, scopeA.key))

  const oversizedBase = path.join(tempRoot, 'oversized-latency-runs')
  const oversizedLegacyDir = path.join(oversizedBase, legacyPrefix)
  const oversizedLatencyLog = path.join(oversizedLegacyDir, 'logs', 'latency-monitor.jsonl')
  fs.mkdirSync(path.dirname(oversizedLatencyLog), { recursive: true })
  fs.writeFileSync(oversizedLatencyLog, Buffer.alloc(MAX_LATENCY_LOG_BYTES + 1, 0x20))
  assert.throws(
    () => resolveRunDirectory({ baseDir: oversizedBase, streamId: streamA, identity: scopeA }),
    new RegExp(`legacy monitor log .* exceeds ${MAX_LATENCY_LOG_BYTES} bytes`),
  )

  const reconstructDir = path.join(tempRoot, 'reconstructed')
  const emptyHash = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex')
  const manifestPath = path.join(tempRoot, 'reconstruct-manifest.json')
  const sidecarsPath = path.join(tempRoot, 'reconstruct-sidecars.json')
  writeJson(manifestPath, {
    chain: 'sepolia',
    stationAddress: '0xstation',
    publisher: '0xpublisher-a',
    streamId: streamA,
    sequence: 0,
    payloadBytes: 0,
    payloadSha256: emptyHash,
    blobCount: 0,
    blobVersionedHashes: [],
  })
  writeJson(sidecarsPath, { matches: [] })
  const reconstructedOut = path.join(reconstructDir, 'output.webm')
  const firstReconstruct = runNode('scripts/reconstruct-blob-media.mjs', ['--manifest', manifestPath, '--sidecars', sidecarsPath, '--out', reconstructedOut])
  assert.equal(firstReconstruct.status, 0, firstReconstruct.stderr)
  fs.writeFileSync(reconstructedOut, 'corrupt')
  const corruptReuse = runNode('scripts/reconstruct-blob-media.mjs', ['--manifest', manifestPath, '--sidecars', sidecarsPath, '--out', reconstructedOut])
  assert.notEqual(corruptReuse.status, 0)
  assert.match(`${corruptReuse.stdout}\n${corruptReuse.stderr}`, /mismatched SHA-256/)

  const callers = [
    'segment-av1-webm.mjs',
    'live-segment-av1-webm.mjs',
    'live-composite-rfe-segments.mjs',
    'run-live-station.mjs',
    'publish-live-segments.mjs',
    'publish-live-segments-pipelined.mjs',
    'publish-blob-chunk.mjs',
    'monitor-live-stream.mjs',
    'monitor-stream-latency.mjs',
    'reconstruct-blob-media.mjs',
  ]
  for (const caller of callers) {
    const source = fs.readFileSync(path.join(root, 'scripts', caller), 'utf8')
    assert(source.includes('filesystem-identity.mjs'), `${caller} must use the authoritative filesystem identity helper`)
    assert(!source.includes("replace(/[^a-zA-Z0-9_.-]/g, '_')"), `${caller} reintroduced lossy stream ID replacement`)
  }

  console.log('filesystem identity tests ok')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
