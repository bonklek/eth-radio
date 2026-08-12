import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  credentialSafeEndpointLabel,
  endpointSafeErrorMessage,
  redactEndpointSecrets,
} from './lib/endpoint-privacy.mjs'
import { fetchBoundedJson, readBoundedJsonResponse } from './lib/bounded-fetch.mjs'

const root = process.cwd()
const canary = 'RPC_SECRET_CANARY_7fd91a'
const privateKey = `0x${'1'.repeat(64)}`
const stationAddress = `0x${'2'.repeat(40)}`

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

function jsonRpcResult(request) {
  const result = request.method === 'eth_chainId'
    ? '0xaa36a7'
    : request.method === 'eth_getTransactionCount'
      ? '0x0'
      : request.method === 'eth_getLogs'
        ? []
        : request.method === 'eth_blockNumber'
          ? '0x1'
          : null
  return { jsonrpc: '2.0', id: request.id, result }
}

function rpcSentinel(hits) {
  return http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      hits.push({ method: request.method, url: request.url, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.method === 'POST') {
        let payload
        try {
          payload = JSON.parse(body)
        } catch {
          response.end(JSON.stringify({ error: 'invalid json' }))
          return
        }
        response.end(JSON.stringify(Array.isArray(payload) ? payload.map(jsonRpcResult) : jsonRpcResult(payload)))
        return
      }
      if (request.url.includes('/eth/v1/beacon/genesis')) {
        response.end(JSON.stringify({ data: { genesis_time: '0' } }))
      } else if (request.url.includes('/eth/v1/beacon/headers/head')) {
        response.end(JSON.stringify({ data: { header: { message: { slot: '1' } } } }))
      } else {
        response.end(JSON.stringify({ data: [] }))
      }
    })
  })
}

function runNode(args, { env = {}, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Timed out running node ${args.join(' ')}`))
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, output: `${stdout}\n${stderr}` })
    })
  })
}

async function waitForServer(port, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local demo exited before listening with code ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch {
      // The server is expected to refuse connections until its listener is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for the local demo')
}

assert.deepEqual(
  await readBoundedJsonResponse(new Response('{"ok":true}'), { maxBytes: 64, label: 'test response' }),
  { ok: true },
)
await assert.rejects(
  readBoundedJsonResponse(new Response('x'.repeat(65)), { maxBytes: 64, label: 'test response' }),
  /test response exceeds 64 bytes/,
)
await assert.rejects(
  readBoundedJsonResponse(new Response(`sensitive-${canary}`, { status: 400, statusText: 'Bad Request' }), {
    maxBytes: 64,
    label: 'test response',
  }),
  (error) => error.message === '400 Bad Request: response body omitted' && !error.message.includes(canary),
)
await assert.rejects(
  readBoundedJsonResponse(new Response('x'.repeat(65), { status: 502, statusText: 'Bad Gateway' }), {
    maxBytes: 64,
    label: 'test response',
  }),
  /502 Bad Gateway: test response error body exceeds 64 bytes/,
)
assert.deepEqual(await fetchBoundedJson('https://bounded.invalid/data', {
  maxBytes: 64,
  fetchImpl: async (_url, options) => {
    assert(options.signal instanceof AbortSignal)
    return new Response('{"bounded":true}')
  },
}), { bounded: true })

const credentialUrl = `https://user-${canary}:pass-${canary}@${canary}.example/v2/${canary}?apiKey=${canary}`
assert.equal(credentialSafeEndpointLabel(credentialUrl, 'RPC endpoint 1'), 'RPC endpoint 1 (https)')
const nestedError = {
  cause: {
    details: `request failed at ${credentialUrl}; host ${canary}.example; credential ${canary}`,
  },
}
for (const sanitized of [
  endpointSafeErrorMessage(nestedError, [credentialUrl]),
  redactEndpointSecrets(nestedError.cause.details, [credentialUrl]),
]) {
  assert(!sanitized.includes(canary), `Sanitized endpoint message leaked canary: ${sanitized}`)
  assert(!sanitized.includes('https://'), `Sanitized endpoint message leaked URL: ${sanitized}`)
}

const publisherSource = fs.readFileSync(path.join(root, 'scripts', 'publish-live-segments-pipelined.mjs'), 'utf8')
assert(!publisherSource.includes('${client.url}'), 'Publisher log templates must not interpolate client.url')
assert(publisherSource.includes('client.label'), 'Publisher logs must use credential-safe client labels')
assert(publisherSource.includes('endpointSafeErrorMessage(error, endpoints)'), 'Publisher nested errors must use shared redaction')

const monitorSource = fs.readFileSync(path.join(root, 'scripts', 'monitor-stream-latency.mjs'), 'utf8')
assert(!monitorSource.includes('via ${rpcUrl}'), 'Latency monitor startup log must not print the RPC URL')
assert(!monitorSource.includes('    rpcUrl,'), 'Latency monitor records must not persist the RPC URL')
assert(monitorSource.includes('endpointSafeErrorMessage(error, [rpcUrl])'), 'Latency monitor errors must use shared redaction')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-security-boundaries-'))
try {
  const publisherHits = []
  const publisherSentinel = rpcSentinel(publisherHits)
  const publisherPort = await listen(publisherSentinel)
  try {
    const rpcUrl = `http://127.0.0.1:${publisherPort}/v2/${canary}?apiKey=${canary}`
    const result = await runNode([
      'scripts/publish-live-segments-pipelined.mjs',
      '--dir', tempRoot,
      '--stream-id', 'security-log-canary',
      '--once',
      '--state', path.join(tempRoot, 'publisher-state.json'),
    ], {
      env: {
        CHAIN: 'sepolia',
        ETH_RPC_URL: rpcUrl,
        ETH_SEND_RPC_URLS: '',
        PRIVATE_KEY: privateKey,
        STATION_ADDRESS: stationAddress,
      },
    })
    assert.equal(result.code, 0, `Publisher canary run failed:\n${redactEndpointSecrets(result.output, [rpcUrl])}`)
    assert(result.output.includes('rpc read: RPC endpoint 1 (http)'), 'Publisher did not emit the safe startup endpoint label')
    assert(!result.output.includes(canary), 'Publisher stdout/stderr leaked the RPC credential canary')
    assert(publisherHits.some((hit) => hit.body.includes('eth_chainId')), 'Publisher canary RPC did not receive chain validation')
  } finally {
    await close(publisherSentinel)
  }

  const trustedHits = []
  const attackerHits = []
  const trustedSentinel = rpcSentinel(trustedHits)
  const attackerSentinel = rpcSentinel(attackerHits)
  const trustedPort = await listen(trustedSentinel)
  const attackerPort = await listen(attackerSentinel)
  const portProbe = http.createServer()
  const localDemoPort = await listen(portProbe)
  await close(portProbe)
  const trustedUrl = `http://127.0.0.1:${trustedPort}`
  const attackerUrl = `http://127.0.0.1:${attackerPort}/${canary}`
  const localDemo = spawn(process.execPath, ['scripts/serve-live-demo.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(localDemoPort),
      CHAIN: 'sepolia',
      ETH_RPC_URL: trustedUrl,
      BEACON_RPC_URL: trustedUrl,
      MAINNET_ETH_RPC_URL: trustedUrl,
      MAINNET_BEACON_RPC_URL: trustedUrl,
      STATION_ADDRESS: stationAddress,
      MAINNET_STATION_ADDRESS: stationAddress,
      STATION_FROM_BLOCK: '0',
      MAINNET_STATION_FROM_BLOCK: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let localDemoOutput = ''
  localDemo.stdout.on('data', (chunk) => { localDemoOutput += chunk })
  localDemo.stderr.on('data', (chunk) => { localDemoOutput += chunk })
  try {
    await waitForServer(localDemoPort, localDemo)
    attackerHits.length = 0
    const query = new URLSearchParams({
      network: 'sepolia',
      ethRpcUrl: attackerUrl,
      beaconRpcUrl: attackerUrl,
    })
    await fetch(`http://127.0.0.1:${localDemoPort}/api/streams/probe/live?${query}`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.text())
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(attackerHits.length, 0, 'Request query parameters selected an attacker-controlled outbound endpoint')
  } finally {
    localDemo.kill()
    await Promise.all([close(trustedSentinel), close(attackerSentinel)])
  }

  const liveDemoSource = fs.readFileSync(path.join(root, 'scripts', 'serve-live-demo.mjs'), 'utf8')
  assert(!liveDemoSource.includes('ethRpcUrl'), 'Local demo source must not accept request-scoped execution RPC URLs')
  assert(!liveDemoSource.includes('beaconRpcUrl'), 'Local demo source must not accept request-scoped beacon RPC URLs')
  assert(liveDemoSource.includes("parsed.searchParams.get('endpointPreset')"), 'Trusted endpoint preset selection should remain available')
  assert(liveDemoSource.includes("parsed.searchParams.get('network')"), 'UI network selection should remain available')
  assert(!localDemoOutput.includes(attackerUrl), 'Local demo logs leaked the ignored attacker endpoint')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('security boundary tests ok')
