import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-cli-help-'))
const protectedDir = path.join(tempRoot, 'protected-output')
const inputPath = path.join(tempRoot, 'input.webm')
fs.mkdirSync(protectedDir)
fs.writeFileSync(path.join(protectedDir, 'sentinel.txt'), 'must survive help\n')
fs.writeFileSync(inputPath, 'not real media')

const entrypoints = [
  'blob-slot-metrics.mjs',
  'build-static-client.mjs',
  'check-syntax.mjs',
  'check-text.mjs',
  'check-wallet.mjs',
  'check.mjs',
  'compile-station.mjs',
  'deploy-station.mjs',
  'fetch-blob-sidecars.mjs',
  'generate-rfe-overlay-assets.mjs',
  'list-station-segments.mjs',
  'live-composite-rfe-segments.mjs',
  'live-segment-av1-webm.mjs',
  'monitor-live-stream.mjs',
  'monitor-stream-latency.mjs',
  'prepare-ipfs-publish.mjs',
  'publish-blob-chunk.mjs',
  'publish-live-segments-pipelined.mjs',
  'publish-live-segments.mjs',
  'reconstruct-blob-media.mjs',
  'run-live-station.mjs',
  'segment-av1-webm.mjs',
  'serve-live-demo.mjs',
  'serve-static-client.mjs',
  'verify-static-artifact.mjs',
  'verify-static-client.mjs',
]

function directorySnapshot(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .map((entry) => `${entry.isDirectory() ? 'd' : 'f'}:${path.relative(directory, path.join(entry.parentPath, entry.name))}`)
    .sort()
}

function sanitizedEnvironment(endpoint) {
  const inheritedNames = ['ComSpec', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR']
  const inherited = Object.fromEntries(inheritedNames
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]))
  return {
    ...inherited,
    HOME: tempRoot,
    USERPROFILE: tempRoot,
    CHAIN: 'unsupported-help-canary',
    ETH_RPC_URL: endpoint,
    BEACON_RPC_URL: endpoint,
    ETH_SEND_RPC_URLS: endpoint,
    PRIVATE_KEY: `0x${'1'.repeat(64)}`,
    STATION_ADDRESS: `0x${'2'.repeat(40)}`,
    MAINNET_CONFIRM: 'help must never inspect this',
    MAX_BLOBS_PER_BLOCK: 'not-a-number',
  }
}

function runHelp(script, endpoint) {
  const scriptPath = path.join(root, 'scripts', script)
  const args = [
    scriptPath,
    '--help',
    '--input', inputPath,
    '--dir', protectedDir,
    '--out-dir', protectedDir,
    '--out', path.join(protectedDir, 'should-not-exist'),
    '--state', path.join(protectedDir, 'should-not-exist.json'),
    '--manifest', path.join(protectedDir, 'should-not-exist.manifest.json'),
    '--sidecars', path.join(protectedDir, 'should-not-exist.sidecars.json'),
    '--stream-id', 'help-safety',
    '--station-address', `0x${'2'.repeat(40)}`,
    '--build',
    '--dist',
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: tempRoot,
      env: sanitizedEnvironment(endpoint),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`${script} --help timed out`))
    }, 15_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status, signal) => {
      clearTimeout(timeout)
      resolve({ status, signal, stdout, stderr })
    })
  })
}

const server = http.createServer((_request, response) => {
  networkHits += 1
  response.writeHead(500)
  response.end('help must not make requests')
})
let networkHits = 0

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Help sentinel server did not expose a TCP port')
  const endpoint = `http://127.0.0.1:${address.port}`
  fs.writeFileSync(path.join(tempRoot, '.env'), [
    `ETH_RPC_URL=${endpoint}`,
    `BEACON_RPC_URL=${endpoint}`,
    `PRIVATE_KEY=0x${'3'.repeat(64)}`,
    'CHAIN=mainnet',
    'MAINNET_CONFIRM=not-confirmed',
  ].join('\n'))
  const before = directorySnapshot(tempRoot)

  for (const script of entrypoints) {
    const result = await runHelp(script, endpoint)
    assert.equal(result.signal, null, `${script} --help must terminate normally`)
    assert.equal(result.status, 0, `${script} --help must exit 0\n${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /Usage:/, `${script} --help must write usage to stdout`)
    assert.equal(result.stderr, '', `${script} --help must not write an operational error\n${result.stderr}`)
    assert.deepEqual(directorySnapshot(tempRoot), before, `${script} --help must not mutate the isolated filesystem`)
  }

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(networkHits, 0, '--help must not contact configured execution, beacon, or send endpoints')
  assert.equal(fs.readFileSync(path.join(protectedDir, 'sentinel.txt'), 'utf8'), 'must survive help\n')
  console.log(`CLI help safety ok: ${entrypoints.length} side-effect-free entrypoints`)
} finally {
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
