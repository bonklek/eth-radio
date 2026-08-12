import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import {
  endpointSafeErrorMessage,
  printableSingleLineDiagnostic,
  redactEndpointSecrets,
} from './lib/endpoint-privacy.mjs'

const terminalCanary = 'rpc\rforged\u001b]52;c;YQ==\u0007\u202esecret\nnext'
const printableCanary = printableSingleLineDiagnostic(terminalCanary)
assert(!Array.from(printableCanary).some((character) => ['\r', '\n', '\u001b', '\u0007', '\u202e'].includes(character)), 'terminal diagnostics must be single-line and control-free')
assert(printableCanary.includes('\\u001b') && printableCanary.includes('\\u0007') && printableCanary.includes('\\u202e'))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-endpoint-privacy-'))
const privateKey = `0x${'1'.repeat(64)}`
const stationAddress = `0x${'2'.repeat(40)}`
const transactionHash = `0x${'3'.repeat(64)}`
const forbidden = {
  username: 'operator-user-canary',
  password: 'operator-password-canary',
  route: 'operator-route-canary',
  query: 'operator-query-canary',
  nested: 'operator-nested-cause-canary',
}

function generateInput(inputPath) {
  const result = spawnSync(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=64x64:rate=2',
    '-t', '0.5',
    '-pix_fmt', 'yuv420p',
    inputPath,
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `Unable to generate endpoint test input: ${result.stderr || ''}`)
}

function runNode(args, env, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Endpoint privacy command did not terminate promptly: ${args[0]}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status, signal) => {
      clearTimeout(timeout)
      resolve({ status, signal, stdout, stderr, elapsedMs: Date.now() - startedAt })
    })
  })
}

function assertNoEndpointDisclosure(label, output, fullUrl) {
  for (const value of [...Object.values(forbidden), fullUrl]) {
    assert(!output.includes(value), `${label} disclosed credential-bearing endpoint material`)
  }
  assert(!output.includes('http://'), `${label} disclosed a full HTTP endpoint`)
}

const nestedEndpointError = {
  cause: {
    cause: {
      details: `https://${forbidden.username}:${forbidden.password}@example.invalid/${forbidden.route}?key=${forbidden.query}&cause=${forbidden.nested}`,
    },
  },
}
const nestedMessage = endpointSafeErrorMessage(nestedEndpointError, [
  `https://${forbidden.username}:${forbidden.password}@example.invalid/${forbidden.route}?key=${forbidden.query}&cause=${forbidden.nested}`,
])
for (const value of Object.values(forbidden)) assert(!nestedMessage.includes(value))
assert(!nestedMessage.includes('https://'))

const input = path.join(tempRoot, 'input.mp4')
const blobInput = path.join(tempRoot, 'blob.bin')
generateInput(input)
fs.writeFileSync(blobInput, 'endpoint privacy test')

const serialDir = path.join(tempRoot, 'serial')
const pipelineDir = path.join(tempRoot, 'pipeline')
fs.mkdirSync(serialDir, { recursive: true })
fs.mkdirSync(pipelineDir, { recursive: true })
fs.writeFileSync(path.join(serialDir, 'stream-000000.webm'), 'serial endpoint test')
fs.writeFileSync(path.join(pipelineDir, 'stream-000000.webm'), 'pipeline endpoint test')

const cases = [
  { label: 'wallet balance', script: 'scripts/check-wallet.mjs', args: [] },
  { label: 'station deployment', script: 'scripts/deploy-station.mjs', args: [] },
  { label: 'slot metrics', script: 'scripts/blob-slot-metrics.mjs', args: ['--station', stationAddress, '--slots', '1'] },
  { label: 'blob sidecar fetch', script: 'scripts/fetch-blob-sidecars.mjs', args: ['--tx', transactionHash] },
  { label: 'station segment listing', script: 'scripts/list-station-segments.mjs', args: ['--station', stationAddress] },
  {
    label: 'latency monitor',
    script: 'scripts/monitor-stream-latency.mjs',
    args: ['--station', stationAddress, '--max-loops', '1', '--out', path.join(tempRoot, 'latency.jsonl')],
  },
  {
    label: 'proof compositor',
    script: 'scripts/live-composite-rfe-segments.mjs',
    args: [
      '--input', input,
      '--stream-id', 'stream',
      '--out-dir', path.join(tempRoot, 'composite'),
      '--publisher-state', path.join(tempRoot, 'composite-state.json'),
      '--segment-ms', '250',
      '--max-segments', '1',
      '--profile', '360p',
      '--no-audio',
      '--reset',
    ],
  },
  { label: 'blob publisher', script: 'scripts/publish-blob-chunk.mjs', args: ['--input', blobInput, '--stream-id', 'stream'] },
  {
    label: 'serial live publisher',
    script: 'scripts/publish-live-segments.mjs',
    args: [
      '--dir', serialDir,
      '--stream-id', 'stream',
      '--state', path.join(tempRoot, 'serial-state.json'),
      '--once',
      '--max-cost-eth', '1',
      '--skip-wallet-balance-check',
    ],
  },
  {
    label: 'pipelined live publisher',
    script: 'scripts/publish-live-segments-pipelined.mjs',
    args: [
      '--dir', pipelineDir,
      '--stream-id', 'stream',
      '--state', path.join(tempRoot, 'pipeline-state.json'),
      '--once',
    ],
  },
  {
    label: 'live station orchestrator',
    script: 'scripts/run-live-station.mjs',
    args: [
      '--input', input,
      '--stream-id', 'stream',
      '--out-dir', path.join(tempRoot, 'run-segments'),
      '--status', path.join(tempRoot, 'run-status.json'),
      '--state', path.join(tempRoot, 'run-state.json'),
      '--profile', '360p24',
      '--video-bitrate', '40k',
      '--segment-ms', '250',
      '--max-cost-eth', '1',
      '--skip-wallet-balance-check',
      '--no-audio',
      '--no-adaptive',
      '--reset',
    ],
  },
]

for (const testCase of cases) {
  const source = fs.readFileSync(path.join(root, testCase.script), 'utf8')
  assert(
    source.includes('installEndpointSafeProcessHandlers'),
    `${testCase.script} must install the shared fatal endpoint redaction handler`,
  )
}

const hits = new Map()
const endpointById = new Map()
const server = http.createServer((request, response) => {
  const id = request.url?.split(/[/?]/).filter(Boolean)[0] || ''
  hits.set(id, (hits.get(id) || 0) + 1)
  const fullUrl = endpointById.get(id) || ''
  const failure = fullUrl

  if (request.method === 'GET') {
    response.statusCode = 500
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ error: { cause: { cause: { details: failure } } } }))
    return
  }

  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      payload = { id: null }
    }
    const requests = Array.isArray(payload) ? payload : [payload]
    const replies = requests.map((entry) => ({
      jsonrpc: '2.0',
      id: entry.id,
      error: { code: -32_000, message: failure, data: { cause: { details: failure } } },
    }))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]))
  })
})

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')

  const nestedFatalEndpoint = `http://${forbidden.username}:${forbidden.password}@127.0.0.1:${address.port}/nested-fatal/${forbidden.route}?token=${forbidden.query}&cause=${forbidden.nested}`
  const nestedFatal = await runNode([
    '--input-type=module',
    '--eval',
    `const { installEndpointSafeProcessHandlers } = await import('./scripts/lib/endpoint-privacy.mjs'); const endpoint = ${JSON.stringify(nestedFatalEndpoint)}; installEndpointSafeProcessHandlers(() => [endpoint]); setInterval(() => {}, 60_000); Promise.reject({ cause: { cause: { details: endpoint } } });`,
  ], {}, 5_000)
  assert.equal(nestedFatal.status, 1, 'nested fatal rejection must exit nonzero')
  assert.equal(nestedFatal.signal, null, 'nested fatal rejection required forced termination')
  assert(nestedFatal.elapsedMs < 5_000, 'nested fatal rejection did not exit promptly')
  assertNoEndpointDisclosure('nested fatal rejection', `${nestedFatal.stdout}${nestedFatal.stderr}`, nestedFatalEndpoint)

  for (const [index, testCase] of cases.entries()) {
    const id = `operator-${index}`
    const endpoint = `http://${forbidden.username}:${forbidden.password}@127.0.0.1:${address.port}/${id}/${forbidden.route}?token=${forbidden.query}&cause=${forbidden.nested}`
    endpointById.set(id, endpoint)
    const env = {
      CHAIN: 'sepolia',
      ETH_RPC_URL: endpoint,
      BEACON_RPC_URL: endpoint,
      SEPOLIA_ETH_RPC_URL: endpoint,
      SEPOLIA_BEACON_RPC_URL: endpoint,
      ETH_SEND_RPC_URLS: endpoint,
      PRIVATE_KEY: privateKey,
      STATION_ADDRESS: stationAddress,
      PUBLISHER_ADDRESS: '',
      MAINNET_CONFIRM: '',
    }
    const result = await runNode([testCase.script, ...testCase.args], env)
    const output = `${result.stdout}${result.stderr}`
    assert.notEqual(result.status, 0, `${testCase.label} unexpectedly succeeded`)
    assert.equal(result.signal, null, `${testCase.label} required forced termination`)
    assert((hits.get(id) || 0) > 0, `${testCase.label} did not reach its configured endpoint`)
    assert(result.elapsedMs < 30_000, `${testCase.label} did not exit promptly`)
    assertNoEndpointDisclosure(testCase.label, output, endpoint)
  }

  const publisherSource = fs.readFileSync(path.join(root, 'scripts', 'publish-blob-chunk.mjs'), 'utf8')
  assert(
    publisherSource.includes('endpointSafeErrorMessage(error, [rpcUrl])'),
    'getTransaction retry diagnostics must use endpoint-safe redaction',
  )
  assert(!publisherSource.includes('getTransaction retry ${attempt}/${attempts} for ${hash}: ${error'), 'getTransaction retry diagnostics must not interpolate raw errors')
  console.log(`operator endpoint privacy tests ok (${cases.length} commands)`)
} catch (error) {
  const endpoints = [...endpointById.values()]
  // eslint-disable-next-line preserve-caught-error -- The caught error can contain the credential-bearing canary by design.
  throw new Error(redactEndpointSecrets(error?.message || String(error), endpoints))
} finally {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
