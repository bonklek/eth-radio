import 'dotenv/config'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadKZG } from 'kzg-wasm'
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  hexToBytes,
  http,
  keccak256,
  parseGwei,
  stringToBytes,
  toBlobs,
  zeroHash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { assertRpcChain, chainFromEnv, chainNames, requireMainnetConfirmation, requireSupportedChain } from './chains.mjs'
import {
  formatEth,
  hasCostBudget,
  parseEthToWei,
  readCostOptions,
  readSegmentFilesAsCostSegments,
  runCostPreflightOrExit,
} from './lib/cost-preflight.mjs'
function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm live:publish:pipelined -- --dir <segment-dir> --stream-id <id>
       [--segment-ms 24000] [--codec av1-opus/webm] [--start-seq 0]
       [--max-blobs 6] [--max-bytes 761856] [--poll-ms 1000]
       [--max-pending 2] [--max-pending-min 1] [--max-pending-max 4] [--adaptive-pending]
       [--send-retries 8] [--retry-ms 5000]
       [--require-manifest] [--state <state.json>]
       [--max-cost-eth 0.1] [--stream-duration-ms 3600000] [--skip-wallet-balance-check]

Environment:
  ETH_RPC_URL, PRIVATE_KEY, STATION_ADDRESS, CHAIN=${chainNames}
  optional ETH_SEND_RPC_URLS comma-separated fallback list
`)
  process.exit(exitCode)
}

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return process.argv[idx + 1]
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

if (hasFlag('help')) usage(0)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function segmentFiles(dir, streamId) {
  const prefix = `${streamId}-`
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.webm'))
    .sort()
    .map((name) => path.join(dir, name))
}

async function waitForStableFile(file, pollMs) {
  let previous = null
  while (true) {
    const current = fs.statSync(file)
    if (current.size > 0 && previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
      return current
    }
    previous = { size: current.size, mtimeMs: current.mtimeMs }
    await sleep(Math.min(1000, Math.max(250, pollMs)))
  }
}

async function waitForManifestSegment(dir, streamId, sequence, pollMs, required) {
  const manifestPath = path.join(dir, `${streamId}.segments.json`)
  while (required || fs.existsSync(manifestPath)) {
    try {
      if (fs.existsSync(manifestPath)) {
        const manifest = readJson(manifestPath)
        const segment = (manifest.segments || []).find((entry) => Number(entry.sequence) === sequence)
        if (segment && segment.bytes > 0 && fs.existsSync(segment.file)) {
          const stat = fs.statSync(segment.file)
          if (stat.size === segment.bytes) return segment
        }
      }
    } catch {
      // Generator may be rewriting the manifest while we poll.
    }
    await sleep(Math.min(1000, Math.max(250, pollMs)))
  }
  return null
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

function rpcUrls() {
  return [
    ...(process.env.ETH_SEND_RPC_URLS || '')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
    process.env.ETH_RPC_URL,
  ].filter((url, index, urls) => url && urls.indexOf(url) === index)
}

function shortError(error) {
  const cause = error?.cause || {}
  const status = error?.status || cause.status ? ` status ${error?.status || cause.status}` : ''
  const details = error?.shortMessage || cause.shortMessage || cause.details || error?.message || String(error)
  return `${details}${status}`.split('\n')[0]
}

function timingMs(start, end) {
  if (!start || !end) return null
  return Date.parse(end) - Date.parse(start)
}

function pendingAgeMs(item, now = Date.now()) {
  const submittedAt = Date.parse(item.submittedAt || item.startedAt || '')
  return Number.isFinite(submittedAt) ? now - submittedAt : 0
}

function adaptivePendingLimit({ state, baseMaxPending, minPending, maxPending, segmentMs }) {
  const pending = state.submitted || []
  if (!pending.length) return baseMaxPending
  const oldestMs = Math.max(...pending.map((item) => pendingAgeMs(item)))
  if (oldestMs > segmentMs * 4) return minPending
  if (pending.length >= baseMaxPending && oldestMs < segmentMs * 1.5) return Math.min(maxPending, baseMaxPending + 1)
  return baseMaxPending
}

function receiptCostWei(receipt) {
  const executionWei = receipt.gasUsed * receipt.effectiveGasPrice
  const blobWei = receipt.blobGasUsed && receipt.blobGasPrice ? receipt.blobGasUsed * receipt.blobGasPrice : 0n
  return { executionWei, blobWei, totalWei: executionWei + blobWei }
}

function makeClients({ urls, account, chain }) {
  return urls.map((url) => {
    const transport = http(url, { timeout: 60_000 })
    return {
      url,
      publicClient: createPublicClient({ chain, transport }),
      walletClient: createWalletClient({ account, chain, transport }),
    }
  })
}

const segmentPublishedEvent = {
  type: 'event',
  name: 'SegmentPublished',
  inputs: [
    { name: 'publisher', type: 'address', indexed: true },
    { name: 'streamIdHash', type: 'bytes32', indexed: true },
    { name: 'sequence', type: 'uint256', indexed: true },
    { name: 'streamId', type: 'string', indexed: false },
    { name: 'durationMs', type: 'uint64', indexed: false },
    { name: 'payloadBytes', type: 'uint32', indexed: false },
    { name: 'payloadSha256', type: 'bytes32', indexed: false },
    { name: 'codec', type: 'string', indexed: false },
    { name: 'previousSegmentHash', type: 'bytes32', indexed: false },
    { name: 'blobVersionedHashes', type: 'bytes32[]', indexed: false },
  ],
}

function buildStationData({ streamId, sequence, durationMs, payloadBytes, payloadSha256, codec, previousSegmentHash, blobCount }) {
  const stationAbi = [
    {
      type: 'function',
      name: 'publishSegment',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'streamId', type: 'string' },
        { name: 'sequence', type: 'uint256' },
        { name: 'durationMs', type: 'uint64' },
        { name: 'payloadBytes', type: 'uint32' },
        { name: 'payloadSha256', type: 'bytes32' },
        { name: 'codec', type: 'string' },
        { name: 'previousSegmentHash', type: 'bytes32' },
        { name: 'blobCount', type: 'uint8' },
      ],
      outputs: [],
    },
  ]
  return encodeFunctionData({
    abi: stationAbi,
    functionName: 'publishSegment',
    args: [
      streamId,
      BigInt(sequence),
      BigInt(durationMs),
      payloadBytes,
      `0x${payloadSha256}`,
      codec,
      previousSegmentHash,
      blobCount,
    ],
  })
}

async function main() {
  const dirArg = arg('dir')
  const streamId = arg('stream-id')
  if (!dirArg || !streamId) usage()
  if (!process.env.ETH_RPC_URL || !process.env.PRIVATE_KEY || !process.env.STATION_ADDRESS) usage()

  const { chainName, chain } = chainFromEnv()
  requireSupportedChain(chain)
  requireMainnetConfirmation(chainName, 'publish live blob transactions')

  const dir = path.resolve(dirArg)
  const segmentMs = Number(arg('segment-ms', '24000'))
  const codec = arg('codec', 'av1-opus/webm')
  const startSeq = Number(arg('start-seq', '0'))
  const maxBlobs = Number(arg('max-blobs', '6'))
  const maxBytes = Number(arg('max-bytes', String(maxBlobs * 126_976)))
  const baseMaxPending = Number(arg('max-pending', '2'))
  const minPending = Number(arg('max-pending-min', '1'))
  const hardMaxPending = Number(arg('max-pending-max', String(Math.max(baseMaxPending, 4))))
  const pollMs = Number(arg('poll-ms', '1000'))
  const sendRetries = Number(arg('send-retries', '8'))
  const retryMs = Number(arg('retry-ms', '5000'))
  const requireManifest = hasFlag('require-manifest')
  const statePath = path.resolve(arg('state', `work/blob-radio-testnet/live-state/${sanitize(streamId)}.pipelined.json`))
  const once = hasFlag('once')
  const exitWhenCaughtUp = hasFlag('exit-when-caught-up')
  const adaptivePending = hasFlag('adaptive-pending')
  const costOptions = readCostOptions(process.argv)
  const runtimeBudgetWei = costOptions.maxCostEth ? parseEthToWei(costOptions.maxCostEth) : null

  if (!fs.existsSync(dir)) throw new Error(`Segment directory not found: ${dir}`)
  if (!Number.isInteger(baseMaxPending) || baseMaxPending < 1) throw new Error(`Invalid --max-pending ${baseMaxPending}`)
  if (!Number.isInteger(minPending) || minPending < 1) throw new Error(`Invalid --max-pending-min ${minPending}`)
  if (!Number.isInteger(hardMaxPending) || hardMaxPending < baseMaxPending) {
    throw new Error(`Invalid --max-pending-max ${hardMaxPending}; must be >= --max-pending`)
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true })

  let state = {
    streamId,
    nextSequence: startSeq,
    previousSegmentHash: zeroHash,
    submitted: [],
    published: [],
    metrics: {
      submittedCount: 0,
      confirmedCount: 0,
      latestPendingLimit: baseMaxPending,
      latestTimings: null,
      actualSpendWei: '0',
      actualExecutionSpendWei: '0',
      actualBlobSpendWei: '0',
      runtimeBudgetWei: runtimeBudgetWei?.toString() || null,
      runtimeBudgetExhausted: false,
    },
  }
  if (fs.existsSync(statePath) && !hasFlag('reset')) {
    state = readJson(statePath)
    state.submitted ||= []
    state.published ||= []
    state.metrics ||= {}
    state.metrics.actualSpendWei ||= '0'
    state.metrics.actualExecutionSpendWei ||= '0'
    state.metrics.actualBlobSpendWei ||= '0'
  }
  if (runtimeBudgetWei) state.metrics.runtimeBudgetWei = runtimeBudgetWei.toString()

  const account = privateKeyToAccount(process.env.PRIVATE_KEY)
  const clients = makeClients({ urls: rpcUrls(), account, chain })
  const publicClient = clients[0].publicClient
  await assertRpcChain(publicClient, chain)
  const wasmKzg = await loadKZG()
  const kzg = {
    blobToKzgCommitment(blob) {
      return hexToBytes(wasmKzg.blobToKzgCommitment(bytesToHex(blob)))
    },
    computeBlobKzgProof(blob, commitment) {
      return hexToBytes(wasmKzg.computeBlobKZGProof(bytesToHex(blob), bytesToHex(commitment)))
    },
  }

  let nextNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
  const maxSubmittedNonce = state.submitted.reduce((max, item) => Math.max(max, Number(item.nonce ?? -1)), -1)
  nextNonce = Math.max(nextNonce, maxSubmittedNonce + 1)

  console.log(`pipelined publisher watching ${dir}`)
  console.log(`stream: ${streamId}`)
  console.log(`next sequence: ${state.nextSequence}`)
  console.log(`max pending: ${baseMaxPending}${adaptivePending ? ` adaptive ${minPending}-${hardMaxPending}` : ''}`)
  console.log(`send retries: ${sendRetries}, retry ms: ${retryMs}`)
  console.log(`next nonce: ${nextNonce}`)
  console.log(`rpc read: ${clients[0].url}`)
  console.log(`rpc send order: ${clients.map((client) => client.url).join(', ')}`)

  if (hasCostBudget()) {
    await runCostPreflightOrExit({
      segments: readSegmentFilesAsCostSegments(segmentFiles(dir, streamId).slice(state.nextSequence)),
      segmentMs,
    })
  }

  async function sendTransactionWithFallback(tx) {
    let lastError = null
    for (let attempt = 1; attempt <= sendRetries; attempt += 1) {
      for (const client of clients) {
        try {
          if (attempt > 1) console.log(`send retry ${attempt}/${sendRetries} via ${client.url}`)
          return await client.walletClient.sendTransaction(tx)
        } catch (error) {
          lastError = error
          console.warn(`send via ${client.url} failed: ${shortError(error)}`)
        }
      }
      if (attempt < sendRetries) await sleep(retryMs)
    }
    throw new Error(`Unable to send blob transaction after ${sendRetries} attempt(s): ${shortError(lastError)}`)
  }

  async function getReceipt(hash) {
    for (const client of clients) {
      const receipt = await client.publicClient.getTransactionReceipt({ hash }).catch(() => null)
      if (receipt) return receipt
    }
    return null
  }

  async function getTransaction(hash) {
    for (const client of clients) {
      const transaction = await client.publicClient.getTransaction({ hash }).catch(() => null)
      if (transaction) return transaction
    }
    return null
  }

  function verifyStationEvent(receipt, item) {
    if (receipt.status !== 'success') {
      throw new Error(`Transaction ${item.txHash} was included but failed with status ${receipt.status}`)
    }
    const streamIdHash = keccak256(stringToBytes(streamId))
    const stationEvent = receipt.logs
      .filter((log) => log.address.toLowerCase() === process.env.STATION_ADDRESS.toLowerCase())
      .map((log) => {
        try {
          return decodeEventLog({ abi: [segmentPublishedEvent], data: log.data, topics: log.topics })
        } catch {
          return null
        }
      })
      .find((log) => {
        if (!log || log.eventName !== 'SegmentPublished') return false
        return (
          log.args.publisher.toLowerCase() === account.address.toLowerCase() &&
          log.args.streamIdHash === streamIdHash &&
          Number(log.args.sequence) === Number(item.sequence)
        )
      })
    if (!stationEvent) {
      throw new Error(`Transaction ${item.txHash} did not emit Station SegmentPublished for ${streamId} seq ${item.sequence}`)
    }
    return stationEvent
  }

  async function confirmSubmitted() {
    const remaining = []
    for (const item of state.submitted) {
      const receipt = await getReceipt(item.txHash)
      if (!receipt) {
        remaining.push(item)
        continue
      }
      const stationEvent = verifyStationEvent(receipt, item)
      const transaction = await getTransaction(item.txHash)
      const manifest = {
        app: 'eth-radio',
        version: 1,
        chain: chainName,
        streamId,
        sequence: item.sequence,
        durationMs: segmentMs,
        codec,
        input: item.file,
        payloadBytes: item.payloadBytes,
        payloadSha256: item.payloadSha256,
        previousSegmentHash: item.previousSegmentHash,
        blobCount: item.blobCount,
        stationAddress: process.env.STATION_ADDRESS,
        txHash: item.txHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber.toString(),
        transactionIndex: receipt.transactionIndex,
        blobVersionedHashes: transaction?.blobVersionedHashes || stationEvent.args.blobVersionedHashes || [],
        createdAt: new Date().toISOString(),
      }
      fs.mkdirSync('work/blob-radio-testnet/manifests', { recursive: true })
      const manifestPath = path.resolve(`work/blob-radio-testnet/manifests/${sanitize(streamId)}-${item.sequence}.json`)
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      if (!state.published.some((published) => Number(published.sequence) === Number(item.sequence))) {
        const costs = receiptCostWei(receipt)
        const includedAt = manifest.createdAt
        const timings = {
          generatedToSubmitMs: timingMs(item.generatedAt, item.submittedAt),
          submitToIncludedMs: timingMs(item.submittedAt, includedAt),
          generatedToIncludedMs: timingMs(item.generatedAt, includedAt),
          firstSeenToIncludedMs: timingMs(item.firstSeenAt, includedAt),
        }
        state.published.push({
          sequence: item.sequence,
          file: item.file,
          payloadBytes: item.payloadBytes,
          payloadSha256: item.payloadSha256,
          blobCount: item.blobCount,
          previousSegmentHash: item.previousSegmentHash,
          txHash: item.txHash,
          blockNumber: receipt.blockNumber.toString(),
          transactionIndex: receipt.transactionIndex,
          firstSeenAt: item.firstSeenAt,
          generatedAt: item.generatedAt,
          submittedAt: item.submittedAt,
          includedAt,
          timings,
          costWei: costs.totalWei.toString(),
          executionCostWei: costs.executionWei.toString(),
          blobCostWei: costs.blobWei.toString(),
          costEth: formatEth(costs.totalWei),
        })
        state.published.sort((a, b) => Number(a.sequence) - Number(b.sequence))
        state.metrics.confirmedCount = Number(state.metrics.confirmedCount || 0) + 1
        state.metrics.latestTimings = timings
        state.metrics.actualSpendWei = (BigInt(state.metrics.actualSpendWei || '0') + costs.totalWei).toString()
        state.metrics.actualExecutionSpendWei = (
          BigInt(state.metrics.actualExecutionSpendWei || '0') + costs.executionWei
        ).toString()
        state.metrics.actualBlobSpendWei = (BigInt(state.metrics.actualBlobSpendWei || '0') + costs.blobWei).toString()
        state.metrics.actualSpendEth = formatEth(BigInt(state.metrics.actualSpendWei))
        state.metrics.actualExecutionSpendEth = formatEth(BigInt(state.metrics.actualExecutionSpendWei))
        state.metrics.actualBlobSpendEth = formatEth(BigInt(state.metrics.actualBlobSpendWei))
        if (runtimeBudgetWei && BigInt(state.metrics.actualSpendWei) >= runtimeBudgetWei) {
          state.metrics.runtimeBudgetExhausted = true
          state.metrics.runtimeBudgetExhaustedAt = new Date().toISOString()
        }
        const recent = state.published.slice(-20)
        state.metrics.recentAverageSubmitToIncludedMs = Math.round(
          recent.reduce((sum, segment) => sum + Number(segment.timings?.submitToIncludedMs || 0), 0) / recent.length,
        )
        state.metrics.recentAverageGeneratedToIncludedMs = Math.round(
          recent.reduce((sum, segment) => sum + Number(segment.timings?.generatedToIncludedMs || 0), 0) / recent.length,
        )
      }
      console.log(`confirmed seq ${item.sequence}: ${item.txHash} block ${receipt.blockNumber}`)
    }
    state.submitted = remaining
    saveState(statePath, state)
  }

  async function submitNext() {
    const files = segmentFiles(dir, streamId)
    const file = files[state.nextSequence]
    if (!file) return false

    const firstSeenAt = new Date().toISOString()
    const manifestSegment = await waitForManifestSegment(dir, streamId, state.nextSequence, pollMs, requireManifest)
    const stat = manifestSegment ? fs.statSync(manifestSegment.file) : await waitForStableFile(file, pollMs)
    const generatedAt = new Date(stat.mtimeMs).toISOString()
    const payload = fs.readFileSync(file)
    const blobs = toBlobs({ data: bytesToHex(payload) })
    const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex')
    if (payload.length > maxBytes || blobs.length > maxBlobs) {
      throw new Error(
        `Segment ${state.nextSequence} exceeds guardrails: ${payload.length} bytes, ${blobs.length} blobs; limits ${maxBytes} bytes, ${maxBlobs} blobs`,
      )
    }

    const sequence = state.nextSequence
    const previousSegmentHash = state.previousSegmentHash
    const data = buildStationData({
      streamId,
      sequence,
      durationMs: segmentMs,
      payloadBytes: payload.length,
      payloadSha256,
      codec,
      previousSegmentHash,
      blobCount: blobs.length,
    })
    const tx = {
      account,
      blobs,
      kzg,
      to: process.env.STATION_ADDRESS,
      data,
      nonce: nextNonce,
    }
    if (process.env.MAX_FEE_PER_BLOB_GAS_GWEI) tx.maxFeePerBlobGas = parseGwei(process.env.MAX_FEE_PER_BLOB_GAS_GWEI)
    if (process.env.MAX_FEE_PER_GAS_GWEI) tx.maxFeePerGas = parseGwei(process.env.MAX_FEE_PER_GAS_GWEI)
    if (process.env.MAX_PRIORITY_FEE_PER_GAS_GWEI) {
      tx.maxPriorityFeePerGas = parseGwei(process.env.MAX_PRIORITY_FEE_PER_GAS_GWEI)
    }
    if (process.env.GAS_LIMIT) tx.gas = BigInt(process.env.GAS_LIMIT)
    else tx.gas = 180000n

    const submittedAt = new Date().toISOString()
    console.log(`submitting seq ${sequence}: ${payload.length} bytes, ${blobs.length} blob(s), nonce ${nextNonce}`)
    const txHash = await sendTransactionWithFallback(tx)
    console.log(`submitted seq ${sequence}: ${txHash}`)
    state.submitted.push({
      sequence,
      file,
      payloadBytes: payload.length,
      payloadSha256,
      blobCount: blobs.length,
      previousSegmentHash,
      txHash,
      nonce: nextNonce,
      firstSeenAt,
      generatedAt,
      submittedAt,
    })
    state.metrics.submittedCount = Number(state.metrics.submittedCount || 0) + 1
    state.nextSequence += 1
    state.previousSegmentHash = `0x${payloadSha256}`
    nextNonce += 1
    saveState(statePath, state)
    return true
  }

  while (true) {
    await confirmSubmitted()
    if (runtimeBudgetWei && BigInt(state.metrics.actualSpendWei || '0') >= runtimeBudgetWei) {
      state.metrics.runtimeBudgetExhausted = true
      state.metrics.runtimeBudgetExhaustedAt ||= new Date().toISOString()
      saveState(statePath, state)
      console.log(
        `runtime budget exhausted: spent ${formatEth(BigInt(state.metrics.actualSpendWei || '0'))} ETH / ${formatEth(runtimeBudgetWei)} ETH`,
      )
      break
    }

    let submittedAny = false
    const pendingLimit = adaptivePending
      ? adaptivePendingLimit({ state, baseMaxPending, minPending, maxPending: hardMaxPending, segmentMs })
      : baseMaxPending
    state.metrics.latestPendingLimit = pendingLimit
    state.metrics.pendingCount = state.submitted.length
    saveState(statePath, state)

    while (state.submitted.length < pendingLimit) {
      const didSubmit = await submitNext()
      if (!didSubmit) break
      submittedAny = true
      if (once) break
    }

    if ((once || exitWhenCaughtUp) && !submittedAny && state.submitted.length === 0) break
    await sleep(pollMs)
  }

  await confirmSubmitted()
  saveState(statePath, state)
  console.log(`state: ${statePath}`)
}

main().catch((error) => {
  console.error(shortError(error))
  process.exit(1)
})
