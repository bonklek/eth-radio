import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, normalizeConfig, publicConfig } from '../lib/config.mjs'
import { publisherArmConsent, publisherArmConsentDigest } from '../lib/arm-consent.mjs'

const consoleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(consoleDir, '../..')
const station = '0x1111111111111111111111111111111111111111'
const privateKey = `0x${'1'.padStart(64, '0')}`
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-console-'))
const source = path.join(tempDir, 'source.mp4')
fs.writeFileSync(source, 'fixture')

const operatorGuide = fs.readFileSync(path.join(consoleDir, 'README.md'), 'utf8')
const reliablePublisherSource = fs.readFileSync(path.join(consoleDir, 'reliable-publisher.mjs'), 'utf8')
const serverSource = fs.readFileSync(path.join(consoleDir, 'server.mjs'), 'utf8')
const appSource = fs.readFileSync(path.join(consoleDir, 'public', 'app.js'), 'utf8')
assert.doesNotMatch(operatorGuide, /\.private[\\/]publisher-console/)
assert.doesNotMatch(operatorGuide, /replacement is signed only after/i)
assert.match(operatorGuide, /durably stores an immutable\s+`rfe\/publication-intent@1` reservation before invoking the local signer/i)
assert.match(reliablePublisherSource, /durableReserveThenSign\(\{/)
assert.match(reliablePublisherSource, /maybeInjectPublisherFault\('console-after-reservation'\)/)
assert.match(reliablePublisherSource, /verifySignedPublicationIntent/)
assert.doesNotMatch(reliablePublisherSource, /prepareAndSign/)
assert.doesNotMatch(reliablePublisherSource, /gas:\s*180000n/)
assert.match(reliablePublisherSource, /estimateGas\(\{ \.\.\.request, blockNumber: block\.number \}\)/)
assert.match(reliablePublisherSource, /await revalidateGasPreflight\(item\)/)
assert.match(reliablePublisherSource, /writePublisherEngineStateAtomic\(statePath, state, lastDurableState\)/)
assert.doesNotMatch(reliablePublisherSource, /atomicWriteJson\(statePath, state\)/)
assert.match(reliablePublisherSource, /publisherDurabilityCapability\(path\.dirname\(statePath\)\)/)
assert.match(appSource, /file-sync-verified-readback/)
assert.match(reliablePublisherSource, /settleEndpointOperation\(clients, async \(client, \{ signal \}\) =>/)
assert.doesNotMatch(reliablePublisherSource, /for \(const client of clients\) \{\s*try \{\s*const hash = await client\.walletClient\.sendRawTransaction/)
assert.doesNotMatch(reliablePublisherSource, /for \(const client of clients(?:\.filter\([^\n]+\))?\)/)
const liquidityChecks = [...reliablePublisherSource.matchAll(/await observeSignerLiquidity\(budget\.proposedPendingWei\)/g)]
const durableReservations = [...reliablePublisherSource.matchAll(/await durableReserveThenSign\(\{/g)]
assert.equal(liquidityChecks.length, 2, 'initial and replacement paths must both recheck signer liquidity')
assert.equal(durableReservations.length, 2, 'test expects one initial and one replacement reservation path')
for (let index = 0; index < durableReservations.length; index += 1) {
  assert.ok(liquidityChecks[index].index < durableReservations[index].index, 'liquidity evidence must precede durable reservation')
}
for (const worker of ['segment-worker.mjs', 'live-capture-worker.mjs', 'reliable-publisher.mjs']) {
  assert.doesNotMatch(fs.readFileSync(path.join(consoleDir, worker), 'utf8'), /import ['"]dotenv\/config['"]/, `${worker} must not reload the repository .env`)
}
assert.doesNotMatch(serverSource, /\.\.\.process\.env/)
assert.match(serverSource, /env: childEnv\(kind\)/)
assert.match(serverSource, /item\.finalityStatus !== 'finalized-tag-observed'/)
assert.match(serverSource, /publisherRestartDecision\(\{/)
assert.match(serverSource, /state\.desired = 'failed'[\s\S]{0,300}stopChild\('encoder'\)/)
const persistedLoadSource = serverSource.slice(serverSource.indexOf('function loadPersistedJob()'), serverSource.indexOf('function sendJson('))
assert.match(persistedLoadSource, /enterRecoveryRequired\(`/)
assert.doesNotMatch(persistedLoadSource, /startEncoder\(\)|startPublisher\(\)/)
assert.match(serverSource, /Recovery classification is required before a new publisher job can start/)
assert.match(serverSource, /quarantineCriticalStateTemps\(paths\.publisherStatePath\)/)
assert.match(reliablePublisherSource, /quarantineCriticalStateTemps\(statePath\)/)
assert.match(serverSource, /await coordinateChildShutdown\(children\)/)
assert.ok(
  serverSource.indexOf('await coordinateChildShutdown(children)') < serverSource.indexOf("process.exit(outcome.clean ? 0 : 2)"),
  'supervisor must observe/escalate child exit before process exit',
)
assert.doesNotMatch(serverSource, /setTimeout\(\(\) => process\.exit\(0\), 3000\)/)
assert.match(serverSource, /shutdown-ambiguity\.json/)
assert.match(serverSource, /if \(fs\.existsSync\(shutdownAmbiguityPath\)\)[\s\S]{0,200}operator reconciliation is required before relaunch/)
assert.ok(
  reliablePublisherSource.lastIndexOf('await verifyLoadedStateIntents()') < reliablePublisherSource.lastIndexOf('await initializeNonce()'),
  'persisted signer output must be verified before nonce initialization or broadcast recovery',
)
assert.ok(
  reliablePublisherSource.lastIndexOf('await acquireSignerCoordinatorLease') < reliablePublisherSource.lastIndexOf('await initializeClients()'),
  'chain/account coordinator must be held before RPC, state recovery, nonce allocation, or signing',
)
for (const relativePath of [
  'apps/publisher-console/launch.mjs',
  'apps/publisher-console/stop.mjs',
]) {
  assert.ok(fs.existsSync(path.join(root, relativePath)), `documented command target is missing: ${relativePath}`)
}

const normalized = normalizeConfig({
  ...DEFAULT_CONFIG,
  sourcePath: source,
  streamId: 'private-console-test',
  stationAddress: station,
  executionRpcUrl: 'https://rpc.example.test/key',
}, { env: { PRIVATE_KEY: privateKey } })
assert.equal(normalized.sourcePath, path.resolve(source))
assert.equal(normalized.maxBlobs, 3)
assert.equal(normalized.startupBufferSegments, 2)
assert.equal(normalized.maxSegmentCostEth, '0.005')
assert.equal(normalized.feeBumpPercent, 15)
assert.equal(normalized.confirmationDepth, 2)
assert.equal(normalized.captureTarget, 'desktop')
assert.equal(publicConfig(normalized).executionRpcUrl, '(configured)')
assert.equal(publisherArmConsent(normalized).schema, 'rfe/publisher-arm-consent@1')
const reordered = Object.fromEntries(Object.entries(normalized).reverse())
reordered.overlay = Object.fromEntries(Object.entries(normalized.overlay).reverse())
assert.equal(publisherArmConsentDigest(reordered), publisherArmConsentDigest(normalized))
for (const mutation of [
  { streamId: 'different-stream' },
  { maxStreamCostEth: '0.06' },
  { maxBlobs: 4 },
  { executionRpcUrl: 'https://other.example.test/key' },
  { sourcePath: path.join(tempDir, 'other.mp4') },
]) {
  assert.notEqual(publisherArmConsentDigest({ ...normalized, ...mutation }), publisherArmConsentDigest(normalized))
}
const armJson = JSON.stringify(publisherArmConsent(normalized))
assert.equal(armJson.includes(normalized.executionRpcUrl), false)
assert.equal(armJson.includes(normalized.sourcePath), false)
assert.throws(
  () => normalizeConfig({ ...normalized, futureAuthority: true }, { env: { PRIVATE_KEY: privateKey } }),
  /unknown field: futureAuthority/,
)
assert.throws(
  () => normalizeConfig({ ...normalized, overlay: { ...normalized.overlay, futureOverlay: true } }, { env: { PRIVATE_KEY: privateKey } }),
  /unknown field: futureOverlay/,
)
assert.throws(
  () => normalizeConfig({ ...normalized, maxBlobs: 7 }, { env: { PRIVATE_KEY: privateKey } }),
  /Maximum blobs per segment/,
)
assert.throws(
  () => normalizeConfig({
    ...normalized,
    sendRpcUrls: 'https://rpc-2.example.test,https://rpc-3.example.test,https://rpc-4.example.test,https://rpc-5.example.test',
  }, { env: { PRIVATE_KEY: privateKey } }),
  /At most 4 unique execution RPC endpoints/,
)
assert.throws(
  () => normalizeConfig({ ...normalized, chain: 'mainnet', confirmMainnet: false }, { env: { PRIVATE_KEY: privateKey } }),
  /real-ETH confirmation/,
)
assert.throws(
  () => normalizeConfig({ ...normalized, maxSegmentCostEth: '0.06' }, { env: { PRIVATE_KEY: privateKey } }),
  /cannot exceed the total stream budget/,
)
const exactFinancialConfig = normalizeConfig({
  ...normalized,
  maxStreamCostEth: '0001.230000000000000000',
  maxSegmentCostEth: '1.229999999999999999',
  maxFeePerBlobGasGwei: '0002.500000000',
}, { env: { PRIVATE_KEY: privateKey } })
assert.equal(exactFinancialConfig.maxStreamCostEth, '1.23')
assert.equal(exactFinancialConfig.maxSegmentCostEth, '1.229999999999999999')
assert.equal(exactFinancialConfig.maxFeePerBlobGasGwei, '2.5')
for (const maxStreamCostEth of [
  '0',
  '0.0000000000000000000',
  '1.0000000000000000001',
  '1e3',
  'Infinity',
  'NaN',
  '-1',
  '+1',
  '999999999999999999999999999999999',
]) {
  assert.throws(
    () => normalizeConfig({ ...normalized, maxStreamCostEth }, { env: { PRIVATE_KEY: privateKey } }),
    /Maximum stream cost/,
    `unsafe ETH decimal should fail: ${maxStreamCostEth}`,
  )
}
assert.throws(
  () => normalizeConfig({
    ...normalized,
    maxStreamCostEth: '1.000000000000000001',
    maxSegmentCostEth: '1.000000000000000002',
  }, { env: { PRIVATE_KEY: privateKey } }),
  /cannot exceed the total stream budget/,
)
for (const maxFeePerGasGwei of ['0', '0.0000000000', '1.0000000001', '1e2']) {
  assert.throws(
    () => normalizeConfig({ ...normalized, maxFeePerGasGwei }, { env: { PRIVATE_KEY: privateKey } }),
    /Maximum execution fee/,
  )
}
assert.throws(
  () => normalizeConfig({ ...normalized, sourceMode: 'live-url', liveInputUrl: 'file:///secret.mp4' }, { env: { PRIVATE_KEY: privateKey } }),
  /must use HTTP, HTTPS, RTMP, RTMPS, SRT, or UDP/,
)
assert.throws(
  () => normalizeConfig({ ...normalized, captureTarget: 'window' }, { env: { PRIVATE_KEY: privateKey } }),
  /desktop or region/,
)
assert.throws(
  () => normalizeConfig({ ...normalized, captureWidth: 100 }, { env: { PRIVATE_KEY: privateKey } }),
  /Capture width/,
)

for (const file of [
  'server.mjs',
  'segment-worker.mjs',
  'live-capture-worker.mjs',
  'reliable-publisher.mjs',
  'lib/transaction-continuity.mjs',
  'launch.mjs',
  'stop.mjs',
  'public/app.js',
]) {
  const result = spawnSync(process.execPath, ['--check', path.join(consoleDir, file)], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${file} syntax failed: ${result.stderr}`)
}
assert.match(fs.readFileSync(path.join(consoleDir, 'segment-worker.mjs'), 'utf8'), /overlayBurnedIn/)
assert.match(fs.readFileSync(path.join(consoleDir, 'live-capture-worker.mjs'), 'utf8'), /overlayBurnedIn/)

const port = 18000 + Math.floor(Math.random() * 10000)
const origin = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [path.join(consoleDir, 'server.mjs'), `--port=${port}`], {
  cwd: root,
  env: {
    ...process.env,
    RFE_CONSOLE_TEST: '1',
    RFE_CONSOLE_RUNTIME_DIR: path.join(tempDir, 'runtime'),
    PRIVATE_KEY: privateKey,
    STATION_ADDRESS: station,
    ETH_RPC_URL: 'https://rpc.example.test',
    BEACON_RPC_URL: 'https://beacon.example.test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
const serverExit = new Promise((resolve) => server.once('exit', resolve))
let serverOutput = ''
server.stdout.on('data', (chunk) => { serverOutput += chunk })
server.stderr.on('data', (chunk) => { serverOutput += chunk })

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(300) })
      if (response.ok) return
    } catch {
      // Retry while the local listener starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Test server did not start:\n${serverOutput}`)
}

try {
  await waitForServer()
  const page = await fetch(origin)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/)
  const html = await page.text()
  const token = html.match(/name="rfe-token" content="([a-f0-9]+)"/)?.[1]
  assert.ok(token)

  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json()
  assert.equal(bootstrap.environment.walletConfigured, true)
  assert.ok(bootstrap.walletAddress.startsWith('0x'))
  assert.equal(JSON.stringify(bootstrap).includes(privateKey), false)

  const devices = await fetch(`${origin}/api/audio-devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rfe-token': token, origin },
    body: '{}',
  })
  assert.equal(devices.status, 200)
  assert.ok(Array.isArray((await devices.json()).devices))

  const valid = await fetch(`${origin}/api/config/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rfe-token': token, origin },
    body: JSON.stringify({
      ...DEFAULT_CONFIG,
      streamId: 'api-test',
      stationAddress: station,
      executionRpcUrl: 'https://rpc.example.test',
    }),
  })
  assert.equal(valid.status, 200)

  const rejected = await fetch(`${origin}/api/config/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rfe-token': 'wrong', origin },
    body: '{}',
  })
  assert.equal(rejected.status, 400)

  const startRejected = await fetch(`${origin}/api/jobs/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rfe-token': token, origin },
    body: '{}',
  })
  assert.equal(startRejected.status, 400)
  assert.match((await startRejected.json()).error, /disabled in console test mode/)
} finally {
  if (server.exitCode == null) server.kill('SIGTERM')
  await serverExit
  fs.rmSync(tempDir, { recursive: true, force: true })
}

console.log('private publisher console tests ok')
