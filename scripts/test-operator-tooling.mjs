import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { compileStation } from './compile-station.mjs'
import { assertRpcChain, chainEndpointsFromEnv, chainFromEnv, chains } from './chains.mjs'
import { blockTimestampMs, hydrateEventBlockTimestamps, latencySegmentStats, pruneEventBlockTimestamps } from './lib/latency-metrics.mjs'
import { makePublisherState, readPublisherState } from './lib/publisher-state.mjs'
import { stationAbi } from './lib/station-abi.mjs'
import { maxBlobsArg, segmentMsArg } from './lib/station-cli.mjs'
import { stationReadConfig } from './lib/station-deployment.mjs'

const root = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-operator-tooling-'))
const stationAddress = `0x${'3'.repeat(40)}`
const txHash = `0x${'4'.repeat(64)}`

function runNode(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CHAIN: 'sepolia',
      ETH_RPC_URL: 'http://127.0.0.1:1',
      BEACON_RPC_URL: 'http://127.0.0.1:1',
      PRIVATE_KEY: `0x${'1'.repeat(64)}`,
      STATION_ADDRESS: stationAddress,
      ...env,
    },
  })
  return { ...result, output: `${result.stdout || ''}${result.stderr || ''}` }
}

function runNodeAsync(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Timed out running ${args.join(' ')}`))
    }, 15_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status, signal) => {
      clearTimeout(timeout)
      resolve({ status, signal, stdout, stderr, output: `${stdout}${stderr}` })
    })
  })
}

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return callback()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function abiKey(entry) {
  const inputs = (entry.inputs || []).map((input) => `${input.type}:${Boolean(input.indexed)}`).join(',')
  const outputs = (entry.outputs || []).map((output) => output.type).join(',')
  return [entry.type, entry.name || '', inputs, outputs, entry.stateMutability || '', Boolean(entry.anonymous)].join('|')
}

function assertStationAbiAndCleanCloneConfig() {
  const compiledKeys = compileStation().abi.map(abiKey).sort()
  assert.deepEqual(stationAbi.map(abiKey).sort(), compiledKeys)

  const cleanRoot = path.join(tempRoot, 'clean-clone')
  fs.mkdirSync(cleanRoot, { recursive: true })
  const cleanConfig = stationReadConfig('sepolia', { root: cleanRoot, stationAddress })
  assert.equal(cleanConfig.stationAddress, stationAddress)
  assert.equal(cleanConfig.abi, stationAbi)
  assert.equal(cleanConfig.fromBlock, '0')
  assert.equal(cleanConfig.abiSource, 'tracked-station-abi')

  const deploymentDir = path.join(cleanRoot, 'work', 'blob-radio-testnet', 'contracts')
  fs.mkdirSync(deploymentDir, { recursive: true })
  fs.writeFileSync(path.join(deploymentDir, 'Station.sepolia.json'), `${JSON.stringify({
    address: `0x${'5'.repeat(40)}`,
    blockNumber: '99',
    abi: [{ type: 'event', name: 'WrongDeployment' }],
  })}\n`)
  const overrideConfig = stationReadConfig('sepolia', { root: cleanRoot, stationAddress })
  assert.equal(overrideConfig.abi, stationAbi)
  assert.equal(overrideConfig.fromBlock, '0')
  assert.equal(overrideConfig.abiSource, 'tracked-station-abi')
}

async function assertLatencyMetrics() {
  const calls = []
  const client = {
    async getBlock({ blockNumber }) {
      calls.push(blockNumber)
      return { timestamp: blockNumber === 10n ? 100n : 124n }
    },
  }
  const logs = [{ blockNumber: 10n }, { blockNumber: 10n }, { blockNumber: 11n }]
  const cache = await hydrateEventBlockTimestamps(client, logs)
  await hydrateEventBlockTimestamps(client, [...logs].reverse(), cache)
  assert.deepEqual(calls, [10n, 11n])
  assert.equal(cache.get('10'), 100_000)
  assert.equal(cache.get('11'), 124_000)
  assert.equal(blockTimestampMs(124n), 124_000)
  const stats = latencySegmentStats([
    { sequence: 1, blockTimestampMs: cache.get('11') },
    { sequence: 0, blockTimestampMs: cache.get('10') },
  ], 24_000)
  assert.equal(stats.avgGapSec, 24)
  assert.equal(stats.streamRatio, 1)
  cache.set('9', 90_000)
  pruneEventBlockTimestamps(cache, [{ blockNumber: 11n }])
  assert.deepEqual([...cache.keys()], ['11'], 'timestamp cache must retain only the active log window')

  let active = 0
  let maxActive = 0
  const concurrentClient = {
    async getBlock({ blockNumber }) {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
      return { timestamp: blockNumber }
    },
  }
  await hydrateEventBlockTimestamps(
    concurrentClient,
    Array.from({ length: 20 }, (_, index) => ({ blockNumber: BigInt(index + 20) })),
    new Map(),
    { concurrency: 3 },
  )
  assert.equal(maxActive, 3, 'timestamp hydration must enforce its concurrency ceiling')
}

async function assertSharedChains() {
  withEnvironment({
    CHAIN: 'mainnet',
    ETH_RPC_URL: 'generic-execution',
    BEACON_RPC_URL: 'generic-beacon',
    MAINNET_ETH_RPC_URL: 'mainnet-execution',
    MAINNET_BEACON_RPC_URL: 'mainnet-beacon',
    SEPOLIA_ETH_RPC_URL: 'sepolia-execution',
    SEPOLIA_BEACON_RPC_URL: 'sepolia-beacon',
  }, () => {
    assert.equal(chainFromEnv().chain.id, chains.mainnet.id)
    assert.deepEqual(chainEndpointsFromEnv('mainnet'), {
      executionRpcUrl: 'mainnet-execution',
      beaconRpcUrl: 'mainnet-beacon',
    })
    assert.deepEqual(chainEndpointsFromEnv('sepolia'), {
      executionRpcUrl: 'sepolia-execution',
      beaconRpcUrl: 'sepolia-beacon',
    })
  })
  withEnvironment({
    CHAIN: 'sepolia',
    ETH_RPC_URL: 'generic-execution',
    BEACON_RPC_URL: 'generic-beacon',
    SEPOLIA_ETH_RPC_URL: undefined,
    SEPOLIA_BEACON_RPC_URL: undefined,
  }, () => {
    assert.equal(chainFromEnv().chain.id, chains.sepolia.id)
    assert.deepEqual(chainEndpointsFromEnv('sepolia'), {
      executionRpcUrl: 'generic-execution',
      beaconRpcUrl: 'generic-beacon',
    })
  })
  await assertRpcChain({ getChainId: async () => chains.mainnet.id }, chains.mainnet)
  await assert.rejects(
    assertRpcChain({ getChainId: async () => chains.sepolia.id }, chains.mainnet),
    /RPC chain mismatch: expected 1 .* got 11155111/,
  )
}

function writeState(file, state) {
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
}

function assertInvalidState(defaults, label, state, pattern) {
  const file = path.join(tempRoot, `${label}.json`)
  writeState(file, state)
  assert.throws(() => readPublisherState(file, defaults, { submitted: true }), pattern)
}

function assertPublisherStateInvariants() {
  const zero = `0x${'0'.repeat(64)}`
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  const defaults = makePublisherState({
    streamId: 'stream',
    startSeq: 5,
    previousSegmentHash: zero,
    submitted: true,
  })
  const valid = {
    ...defaults,
    nextSequence: 7,
    previousSegmentHash: `0x${hashB}`,
    metrics: { ...defaults.metrics, latestPendingLimit: 2 },
    published: [{ sequence: 5, previousSegmentHash: zero, payloadSha256: hashA }],
    submitted: [{ sequence: 6, nonce: 10, previousSegmentHash: `0x${hashA}`, payloadSha256: hashB }],
  }
  const validFile = path.join(tempRoot, 'valid-state.json')
  writeState(validFile, valid)
  assert.equal(readPublisherState(validFile, defaults, { submitted: true }).nextSequence, 7)

  const compatibleFile = path.join(tempRoot, 'compatible-state.json')
  writeState(compatibleFile, {
    streamId: 'stream',
    nextSequence: 6,
    previousSegmentHash: zero,
    published: [{ sequence: 5 }],
  })
  const compatible = readPublisherState(compatibleFile, defaults, { submitted: true })
  assert.deepEqual(compatible.submitted, [])
  assert.equal(compatible.metrics.actualSpendWei, '0')

  assertInvalidState(defaults, 'duplicate-sequence', {
    ...valid,
    published: [valid.published[0], { ...valid.published[0] }],
    submitted: [],
    nextSequence: 6,
    previousSegmentHash: `0x${hashA}`,
  }, /published sequences must be unique and strictly increasing/)
  assertInvalidState(defaults, 'nonmonotonic-sequence', {
    ...valid,
    published: [{ sequence: 6 }, { sequence: 5 }],
    submitted: [],
  }, /published sequences must be unique and strictly increasing/)
  assertInvalidState(defaults, 'duplicate-nonce', {
    ...valid,
    nextSequence: 8,
    previousSegmentHash: `0x${'c'.repeat(64)}`,
    submitted: [
      valid.submitted[0],
      { sequence: 7, nonce: 10, previousSegmentHash: `0x${hashB}`, payloadSha256: 'c'.repeat(64) },
    ],
  }, /submitted nonces must be unique and strictly increasing/)
  assertInvalidState(defaults, 'overlapping-queues', {
    ...valid,
    nextSequence: 6,
    previousSegmentHash: `0x${hashA}`,
    submitted: [{ sequence: 5, nonce: 10 }],
  }, /appears in both published and submitted queues/)
  assertInvalidState(defaults, 'future-sequence', {
    ...defaults,
    nextSequence: 6,
    published: [{ sequence: 6 }],
  }, /sequence 6 must be less than nextSequence 6/)
  assertInvalidState(defaults, 'next-sequence-gap', {
    ...defaults,
    nextSequence: 7,
    published: [{ sequence: 5 }],
  }, /nextSequence 7 must follow latest history sequence 5/)
  assertInvalidState(defaults, 'history-gap', {
    ...defaults,
    nextSequence: 8,
    published: [{ sequence: 5 }, { sequence: 7 }],
  }, /history sequences must be contiguous/)
  assertInvalidState(defaults, 'predecessor-mismatch', {
    ...valid,
    submitted: [{ ...valid.submitted[0], previousSegmentHash: `0x${'c'.repeat(64)}` }],
  }, /previousSegmentHash does not match sequence 5 payloadSha256/)
  assertInvalidState(defaults, 'latest-predecessor-mismatch', {
    ...valid,
    previousSegmentHash: `0x${'c'.repeat(64)}`,
  }, /previousSegmentHash does not match latest history payloadSha256/)
}

function assertCliBounds() {
  assert.equal(segmentMsArg('24', ['node', 'script', '--segment-ms', '1']), 1)
  assert.equal(maxBlobsArg('6', ['node', 'script', '--max-blobs', '1']), 1)
  assert.equal(maxBlobsArg('1', ['node', 'script', '--max-blobs', '6']), 6)
  assert.throws(() => segmentMsArg('24', ['node', 'script', '--segment-ms', '1.5']), /expected an integer/)
  assert.throws(
    () => segmentMsArg('24', ['node', 'script', '--segment-ms', '9007199254740993']),
    /expected an integer within JavaScript safe range/,
  )
  assert.throws(() => maxBlobsArg('6', ['node', 'script', '--max-blobs', '7']), /expected <= 6/)

  const input = path.join(tempRoot, 'dummy-input.webm')
  const segmentDir = path.join(tempRoot, 'segments')
  fs.writeFileSync(input, 'not media')
  fs.mkdirSync(segmentDir, { recursive: true })
  fs.writeFileSync(path.join(segmentDir, 'stream-000000.webm'), 'segment')
  const tools = [
    {
      label: 'serial publisher',
      script: 'scripts/publish-live-segments.mjs',
      args: ['--dir', segmentDir, '--stream-id', 'stream', '--once'],
      maxBlobs: true,
      publisher: true,
    },
    {
      label: 'pipelined publisher',
      script: 'scripts/publish-live-segments-pipelined.mjs',
      args: ['--dir', segmentDir, '--stream-id', 'stream', '--once'],
      maxBlobs: true,
      publisher: true,
    },
    {
      label: 'live segment generator',
      script: 'scripts/live-segment-av1-webm.mjs',
      args: ['--input', input, '--stream-id', 'stream', '--out-dir', path.join(tempRoot, 'live-out'), '--allow-raw-test'],
      maxBlobs: true,
    },
    {
      label: 'proof composite generator',
      script: 'scripts/live-composite-rfe-segments.mjs',
      args: ['--input', input, '--stream-id', 'stream', '--out-dir', path.join(tempRoot, 'composite-out')],
      maxBlobs: true,
    },
    {
      label: 'live station orchestrator',
      script: 'scripts/run-live-station.mjs',
      args: ['--input', input, '--stream-id', 'stream', '--out-dir', path.join(tempRoot, 'station-out')],
      maxBlobs: true,
    },
    {
      label: 'one-shot segment generator',
      script: 'scripts/segment-av1-webm.mjs',
      args: ['--input', input, '--stream-id', 'stream', '--out-dir', path.join(tempRoot, 'one-shot-out')],
      maxBlobs: false,
    },
  ]

  for (const tool of tools) {
    const invalidDuration = runNode([tool.script, ...tool.args, '--segment-ms', '1.5'])
    assert.notEqual(invalidDuration.status, 0, `${tool.label} accepted fractional --segment-ms`)
    assert.match(invalidDuration.output, /Invalid --segment-ms: 1\.5; expected an integer/)
    if (tool.maxBlobs) {
      const excessiveBlobs = runNode([tool.script, ...tool.args, '--max-blobs', '7'])
      assert.notEqual(excessiveBlobs.status, 0, `${tool.label} accepted --max-blobs 7`)
      assert.match(excessiveBlobs.output, /Invalid --max-blobs: 7; expected <= 6/)
    }
    if (tool.publisher) {
      for (const flag of [[], ['--dry-run']]) {
        const liveInvalid = runNode([tool.script, ...tool.args, ...flag, '--max-blobs', '7'])
        assert.notEqual(liveInvalid.status, 0, `${tool.label} accepted invalid max blobs in ${flag.length ? 'dry' : 'live'} mode`)
        assert.match(liveInvalid.output, /Invalid --max-blobs: 7; expected <= 6/)
      }
      for (const boundary of ['1', '6']) {
        const validBoundary = runNode([
          tool.script,
          ...tool.args,
          '--dry-run',
          '--segment-ms',
          '1',
          '--max-blobs',
          boundary,
        ])
        assert.equal(validBoundary.status, 0, `${tool.label} rejected valid --max-blobs ${boundary}\n${validBoundary.output}`)
      }
    }
  }
}

function assertToolSourceBoundaries() {
  const expectations = new Map([
    ['scripts/fetch-blob-sidecars.mjs', ['chainFromEnv()', 'chainEndpointsFromEnv(chainName)', 'await assertRpcChain(publicClient, chain)']],
    ['scripts/blob-slot-metrics.mjs', ['chainFromEnv()', 'chainEndpointsFromEnv(chainName)', 'stationReadConfig(chainName', 'await assertRpcChain(client, chain)']],
    ['scripts/monitor-stream-latency.mjs', ['chainFromEnv()', 'chainEndpointsFromEnv(chainName)', 'stationReadConfig(chainName', 'await assertRpcChain(client, chain)', 'hydrateEventBlockTimestamps']],
    ['scripts/list-station-segments.mjs', ['chainFromEnv()', 'chainEndpointsFromEnv(chainName)', 'stationReadConfig(chainName', 'await assertRpcChain(client, chain)']],
  ])
  for (const [file, markers] of expectations) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    for (const marker of markers) assert.ok(source.includes(marker), `${file} missing ${marker}`)
    assert.ok(!source.includes('sepolia.drpc.org'), `${file} contains a hard-coded RPC endpoint`)
  }
}

function mockBlock() {
  const hash = `0x${'0'.repeat(64)}`
  return {
    number: '0xa',
    hash,
    parentHash: hash,
    nonce: `0x${'0'.repeat(16)}`,
    sha3Uncles: hash,
    logsBloom: `0x${'0'.repeat(512)}`,
    transactionsRoot: hash,
    stateRoot: hash,
    receiptsRoot: hash,
    miner: `0x${'0'.repeat(40)}`,
    difficulty: '0x0',
    totalDifficulty: '0x0',
    extraData: '0x',
    size: '0x1',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    timestamp: '0x78',
    transactions: [],
    uncles: [],
    baseFeePerGas: '0x1',
    mixHash: hash,
  }
}

async function assertUtilityCliMocks() {
  let rpcChainId = '0xaa36a7'
  let beaconRequests = 0
  const rpcMethods = []
  const server = http.createServer((request, response) => {
    if (request.method === 'GET') {
      beaconRequests += 1
      response.setHeader('content-type', 'application/json')
      if (request.url === '/eth/v1/beacon/genesis') {
        response.end(JSON.stringify({ data: { genesis_time: '0' } }))
      } else if (request.url === '/eth/v1/beacon/headers/head') {
        response.end(JSON.stringify({ data: { header: { message: { slot: '10' } } } }))
      } else if (request.url === '/eth/v1/beacon/blob_sidecars/10') {
        response.end(JSON.stringify({ data: [] }))
      } else {
        response.statusCode = 404
        response.end(JSON.stringify({ error: 'not found' }))
      }
      return
    }
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body)
      const requests = Array.isArray(payload) ? payload : [payload]
      const results = requests.map((entry) => {
        rpcMethods.push(entry.method)
        let result
        if (entry.method === 'eth_chainId') result = rpcChainId
        else if (entry.method === 'eth_blockNumber') result = '0xa'
        else if (entry.method === 'eth_getLogs') result = []
        else if (entry.method === 'eth_getBlockByNumber') result = mockBlock()
        else result = null
        return { jsonrpc: '2.0', id: entry.id, result }
      })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(Array.isArray(payload) ? results : results[0]))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const endpoint = `http://127.0.0.1:${address.port}`
  const env = {
    CHAIN: 'sepolia',
    ETH_RPC_URL: endpoint,
    BEACON_RPC_URL: endpoint,
    STATION_ADDRESS: stationAddress,
  }

  try {
    const listed = await runNodeAsync([
      'scripts/list-station-segments.mjs',
      '--station',
      stationAddress,
      '--from-block',
      '0',
    ], env)
    assert.equal(listed.status, 0, listed.output)
    assert.match(listed.output, /"count": 0/)

    const monitorOut = path.join(tempRoot, 'latency.jsonl')
    const monitored = await runNodeAsync([
      'scripts/monitor-stream-latency.mjs',
      '--station',
      stationAddress,
      '--stream-id',
      'stream',
      '--max-loops',
      '1',
      '--out',
      monitorOut,
    ], env)
    assert.equal(monitored.status, 0, monitored.output)
    const latencyRecord = JSON.parse(fs.readFileSync(monitorOut, 'utf8').trim())
    assert.equal(latencyRecord.error, undefined)
    assert.equal(latencyRecord.window.eventCount, 0)

    const metrics = await runNodeAsync([
      'scripts/blob-slot-metrics.mjs',
      '--station',
      stationAddress,
      '--slots',
      '1',
      '--from-block',
      '0',
    ], env)
    assert.equal(metrics.status, 0, metrics.output)
    assert.match(metrics.output, /"streamKnownBlobHashes": 0/)
    assert.ok(rpcMethods.includes('eth_getLogs'))
    assert.ok(beaconRequests >= 3)

    rpcChainId = '0x1'
    const mismatchCases = [
      ['scripts/fetch-blob-sidecars.mjs', '--tx', txHash],
      ['scripts/blob-slot-metrics.mjs', '--station', stationAddress, '--slots', '1'],
      ['scripts/monitor-stream-latency.mjs', '--station', stationAddress, '--max-loops', '1', '--out', path.join(tempRoot, 'mismatch-latency.jsonl')],
    ]
    const beaconBeforeMismatch = beaconRequests
    for (const args of mismatchCases) {
      const mismatch = await runNodeAsync(args, env)
      assert.notEqual(mismatch.status, 0, `${args[0]} accepted a mismatched RPC`)
      assert.match(mismatch.output, /RPC chain mismatch: expected 11155111 .* got 1/)
    }
    assert.equal(beaconRequests, beaconBeforeMismatch, 'mismatched RPC should fail before beacon analysis')
    assert.ok(!fs.existsSync(path.join(tempRoot, 'mismatch-latency.jsonl')))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

try {
  assertStationAbiAndCleanCloneConfig()
  await assertLatencyMetrics()
  await assertSharedChains()
  assertPublisherStateInvariants()
  assertCliBounds()
  assertToolSourceBoundaries()
  await assertUtilityCliMocks()
  console.log('operator tooling tests ok')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
