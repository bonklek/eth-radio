import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mediaCacheFilename } from './lib/live-demo-integrity.mjs'
import { checkLoopbackRequest } from './lib/loopback-request-policy.mjs'
import { createProofRunIndex } from './lib/proof-run-index.mjs'
import { prepareSegmentOutputDirectory } from './lib/segment-output.mjs'

const root = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-runtime-bounds-'))
const manifestDir = path.join(tempRoot, 'work', 'blob-radio-testnet', 'manifests')
const reconstructedDir = path.join(tempRoot, 'work', 'blob-radio-testnet', 'reconstructed')
const sidecarDir = path.join(tempRoot, 'work', 'blob-radio-testnet', 'sidecars')
const streamId = 'bounded-fallback'
const publisher = `0x${'12'.repeat(20)}`
const quietPublisher = `0x${'34'.repeat(20)}`
const quietBlobHash = `0x01${'78'.repeat(31)}`
const zeroHash = `0x${'00'.repeat(32)}`

const policyBase = { method: 'GET', headers: { host: '127.0.0.1:5199' } }
assert.equal(checkLoopbackRequest(policyBase, { port: 5199 }).ok, true)
assert.equal(checkLoopbackRequest({ ...policyBase, method: 'POST' }, { port: 5199 }).status, 405)
assert.equal(checkLoopbackRequest({ ...policyBase, headers: { ...policyBase.headers, origin: 'https://attacker.invalid' } }, { port: 5199 }).status, 403)
assert.equal(checkLoopbackRequest({ ...policyBase, headers: { ...policyBase.headers, 'sec-fetch-site': 'cross-site' } }, { port: 5199 }).status, 403)
assert.equal(checkLoopbackRequest({ ...policyBase, headers: { host: 'attacker.invalid:5199' } }, { port: 5199 }).status, 403)

const selectiveOutput = path.join(tempRoot, 'selective-output')
fs.mkdirSync(selectiveOutput, { recursive: true })
const sentinelPath = path.join(selectiveOutput, 'unrelated-sentinel.txt')
fs.writeFileSync(sentinelPath, 'preserve me')
fs.writeFileSync(path.join(selectiveOutput, 'owned-000000.webm'), 'generated')
prepareSegmentOutputDirectory(selectiveOutput, 'owned')
assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'preserve me', 'selective output cleanup must preserve unrelated files')
assert.equal(fs.existsSync(path.join(selectiveOutput, 'owned-000000.webm')), false)

const proofRuns = path.join(tempRoot, 'proof-runs')
fs.mkdirSync(proofRuns, { recursive: true })
for (let index = 0; index < 12; index += 1) {
  const run = path.join(proofRuns, `run-${String(index).padStart(2, '0')}`)
  fs.mkdirSync(run)
  fs.writeFileSync(path.join(run, '.stream-identity.json'), JSON.stringify({
    scope: {
      streamId: index === 11 ? 'target-stream' : `noise-${index}`,
      publisher: index === 11 ? publisher : `0x${String(index + 1).padStart(40, '0')}`,
    },
  }))
}
fs.writeFileSync(path.join(proofRuns, 'mixed-file.txt'), 'not a run')
const proofIndex = createProofRunIndex({
  directory: proofRuns,
  maxEntriesPerBatch: 2,
  maxCacheEntries: 20,
  loadMarker: (markerPath) => JSON.parse(fs.readFileSync(markerPath, 'utf8')),
})
let proofResult
let inspectedTotal = 0
for (let pass = 0; pass < 20; pass += 1) {
  proofResult = proofIndex.query({ streamId: 'target-stream', publisher })
  inspectedTotal += proofResult.inspected
  assert(proofResult.inspected <= 2, 'proof inventory must bound each recurring scan batch')
  if (proofResult.directories.length) break
}
assert.equal(proofResult?.directories.length, 1, 'cursored proof inventory must eventually discover eligible records beyond the first batch')
assert(inspectedTotal > 2, 'proof regression must exercise more than one cursor batch')

const lateRun = path.join(proofRuns, 'run-late-marker')
fs.mkdirSync(lateRun)
let lateResult
for (let pass = 0; pass < 20; pass += 1) {
  lateResult = proofIndex.query({ streamId: 'late-stream', publisher })
  assert(lateResult.inspected <= 2, 'late-marker revalidation must remain within the scan budget')
  if (lateResult.complete) break
}
assert.equal(lateResult?.directories.length, 0)
fs.writeFileSync(path.join(lateRun, '.stream-identity.json'), JSON.stringify({
  scope: { streamId: 'late-stream', publisher },
}))
for (let pass = 0; pass < 20 && !lateResult?.directories.length; pass += 1) {
  lateResult = proofIndex.query({ streamId: 'late-stream', publisher })
  assert(lateResult.inspected <= 2, 'late-marker revalidation must remain bounded')
}
assert.equal(lateResult?.directories.length, 1, 'a marker published after the initial scan must become discoverable')

fs.writeFileSync(path.join(lateRun, '.stream-identity.json'), JSON.stringify({
  scope: { streamId: 'remapped-stream', publisher },
}))
let remappedResult
for (let pass = 0; pass < 20; pass += 1) {
  remappedResult = proofIndex.query({ streamId: 'remapped-stream', publisher })
  assert(remappedResult.inspected <= 2, 'marker replacement revalidation must remain bounded')
  if (remappedResult.directories.length) break
}
assert.equal(remappedResult?.directories.length, 1, 'a cached marker remapped from A to B must become visible while querying B')
assert.equal(
  proofIndex.query({ streamId: 'late-stream', publisher, scan: false }).directories.length,
  0,
  'marker replacement must remove the stale channel mapping',
)
proofIndex.close()

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function writeManifest(sequence, previousSegmentHash, options = {}) {
  const payloadSha256 = `${String(sequence + 1).padStart(64, '0')}`
  const manifestStreamId = options.streamId || streamId
  const manifestPublisher = options.publisher || publisher
  const filePath = path.join(manifestDir, options.name || `stream-${sequence}.json`)
  fs.writeFileSync(filePath, `${JSON.stringify({
    app: 'eth-radio',
    version: 1,
    chain: 'sepolia',
    streamId: manifestStreamId,
    publisher: manifestPublisher,
    sequence,
    durationMs: 12_000,
    payloadBytes: 3,
    payloadSha256,
    previousSegmentHash,
    txHash: `0x${String(sequence + 10).padStart(64, '0')}`,
    blobVersionedHashes: options.blobVersionedHashes || [],
    createdAt: new Date(1_700_000_000_000 + sequence * 12_000).toISOString(),
  })}\n`)
  const time = options.time || new Date(1_700_000_000_000 + sequence * 1000)
  fs.utimesSync(filePath, time, time)
  return `0x${payloadSha256}`
}

async function waitForServer(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`live demo exited before startup with ${child.exitCode}: ${stdout}${stderr}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(250) })
      if (response.ok) return
    } catch {
      // Startup polling intentionally tolerates connection refusal.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('timed out waiting for bounded live demo')
}

fs.mkdirSync(manifestDir, { recursive: true })
let previous = zeroHash
for (let sequence = 0; sequence < 5; sequence += 1) previous = writeManifest(sequence, previous)
writeManifest(0, zeroHash, {
  name: 'quiet-publisher.json',
  publisher: quietPublisher,
  blobVersionedHashes: [quietBlobHash],
  time: new Date(1_600_000_000_000),
})
const oversized = path.join(manifestDir, 'oversized.json')
fs.writeFileSync(oversized, Buffer.alloc(4097, 0x20))
const newest = new Date(1_800_000_000_000)
fs.utimesSync(oversized, newest, newest)

const port = await availablePort()
const child = spawn(process.execPath, [path.join(root, 'scripts', 'serve-live-demo.mjs')], {
  cwd: tempRoot,
  env: {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || '',
    TEMP: process.env.TEMP || os.tmpdir(),
    TMP: process.env.TMP || os.tmpdir(),
    DOTENV_CONFIG_PATH: 'NUL',
    PORT: String(port),
    CHAIN: 'sepolia',
    ETH_RPC_URL: '',
    BEACON_RPC_URL: '',
    SEPOLIA_ETH_RPC_URL: '',
    SEPOLIA_BEACON_RPC_URL: '',
    MAINNET_ETH_RPC_URL: '',
    MAINNET_BEACON_RPC_URL: '',
    STATION_ADDRESS: '',
    LOCAL_MANIFEST_MAX_BYTES: '4096',
    LOCAL_MANIFEST_MAX_FILES: '2',
    LOCAL_MANIFEST_SCAN_MAX_ENTRIES: '2',
    LOCAL_MANIFEST_AGGREGATE_MAX_BYTES: '1048576',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += chunk })
child.stderr.on('data', (chunk) => { stderr += chunk })

try {
  await waitForServer(port, child)
  const url = `http://127.0.0.1:${port}/api/streams/${encodeURIComponent(streamId)}/live?publisher=${publisher}`
  const invalidPublisherResponse = await fetch(url.replace(publisher, 'not-an-address'))
  assert.equal(invalidPublisherResponse.status, 400, 'publisher validation must happen before identity-scoped index work')
  let body
  for (let pass = 0; pass < 10; pass += 1) {
    const response = await fetch(url)
    assert.equal(response.status, 200)
    body = await response.json()
    if (body.discoveryComplete) break
  }
  assert.equal(body.discoveryComplete, true, 'bounded manifest discovery must complete within the request ceiling')
  assert.deepEqual(
    body.segments.map((segment) => segment.sequence),
    [3, 4],
    `incremental bounded scans must eventually discover the newest records beyond the first batch; body=${JSON.stringify(body)} stderr=${stderr}`,
  )
  assert.deepEqual(body.segments.map((segment) => segment.continuity.status), ['unknown', 'unknown'])
  assert.match(stderr, /oversized\.json: exceeds 4096 bytes/)
  assert.match(stderr, /processing at most 2 directory entries per request/)
  assert.match(stderr, /retained newest 2 of 6 candidates/)

  const quietUrl = url.replace(`publisher=${publisher}`, `publisher=${quietPublisher}`)
  let quietBody = null
  for (let pass = 0; pass < 10; pass += 1) {
    const response = await fetch(quietUrl)
    const candidate = await response.json()
    if (response.status === 503) {
      assert.equal(candidate.discoveryComplete, false, 'an unfinished identity rescan must be explicitly non-definitive')
      assert.equal(candidate.retryable, true)
      continue
    }
    assert.equal(response.status, 200)
    assert.deepEqual(candidate.segments.map((segment) => segment.sequence), [0], 'a completed busy-publisher scan must not permanently starve a later same-stream publisher request')
    assert.equal(candidate.publisher, quietPublisher, 'same-stream publishers must remain isolated during identity recovery')
    quietBody = candidate
    if (candidate.discoveryComplete) break
  }
  assert.equal(quietBody?.discoveryComplete, true, 'the identity-protected bounded rescan must eventually complete')

  const quietSegment = quietBody.segments[0]
  const mediaPath = path.join(reconstructedDir, mediaCacheFilename(quietSegment, { name: 'sepolia' }))
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
  fs.writeFileSync(mediaPath, Buffer.from('dynamic cache readiness'))
  fs.mkdirSync(sidecarDir, { recursive: true })
  fs.writeFileSync(path.join(sidecarDir, `${quietSegment.txHash}.json`), JSON.stringify({
    txHash: quietSegment.txHash,
    slot: '123',
    matches: [{
      index: 0,
      versionedHash: quietBlobHash,
      blob: `0x${'00'.repeat(131_072)}`,
    }],
  }))
  const enrichedResponse = await fetch(quietUrl)
  assert.equal(enrichedResponse.status, 200)
  const enrichedBody = await enrichedResponse.json()
  assert.equal(enrichedBody.segments[0].hasMedia, true, 'warm parsed manifests must recompute dynamic media readiness per request')
  assert.equal(enrichedBody.segments[0].slot, '123', 'warm parsed manifests must recompute dynamic sidecar enrichment per request')
  console.log('runtime filesystem bound tests ok')
} finally {
  child.kill()
  await new Promise((resolve) => child.once('close', resolve))
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
