import dotenv from 'dotenv'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadKZG } from 'kzg-wasm'
import {
  blobsToCommitments,
  bytesToHex,
  commitmentsToVersionedHashes,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  hexToBytes,
  http,
  keccak256,
  stringToBytes,
  toBlobs,
  zeroHash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { assertRpcChain, chainFromEnv, chainNames, requireMainnetConfirmation, requireSupportedChain } from './chains.mjs'
import { acquireAccountLease } from './lib/account-lease.mjs'
import { hasFlag, numberArg, readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import {
  formatEth,
  hasCostBudget,
  parseEthToWei,
  readCostOptions,
  readSegmentFilesAsCostSegments,
  runCostPreflightOrExit,
} from './lib/cost-preflight.mjs'
import {
  credentialSafeEndpointLabel,
  endpointSafeErrorMessage,
  installEndpointSafeProcessHandlers,
} from './lib/endpoint-privacy.mjs'
import {
  appendPublishedHistory,
  makePublisherState,
  MAX_SUBMITTED_HISTORY,
  publisherStateInteger,
  readPublisherStateWithRecovery,
  savePublisherState,
} from './lib/publisher-state.mjs'
import {
  assertRecoveredSignedTransactionIntent,
  assertRuntimeExposureBudget,
  atomicWriteJson,
  maybeInjectPublisherFault,
  pendingReservedExposure,
  receiptCostWei,
  runtimeExposureDecision,
  signedTransactionHash,
  transactionExposureWei,
} from './lib/publisher-safety.mjs'
import { BLOB_DATA_BYTES, maxBlobsArg, segmentMsArg } from './lib/station-cli.mjs'
import { gasLimitEnv, optionalGweiEnv } from './lib/tx-env.mjs'
import { legacyFilesystemKey, resolveScopedJsonPath, resolveSegmentSet, scopedStreamFilesystemIdentity, withFilesystemIdentity } from './lib/filesystem-identity.mjs'
import { segmentEntries, segmentEntry, waitForManifestSegment, waitForStableFile } from './lib/segment-input.mjs'
import { readBoundedFileSync } from './lib/bounded-files.mjs'
import { assertStationEventMetadata, manifestBlobVersionedHashes, stationEventSequenceMatches } from './lib/publisher-manifest.mjs'

function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm live:publish:pipelined -- --dir <segment-dir> --stream-id <id>
       [--segment-ms 24000] [--codec av1-opus/webm] [--start-seq 0]
       [--max-blobs 6] [--max-bytes 761856] [--poll-ms 1000]
       [--max-pending 2] [--max-pending-min 1] [--max-pending-max 4] [--adaptive-pending]
       [--send-retries 8] [--retry-ms 5000]
       [--require-manifest] [--state <state.json>] [--dry-run] [--recover-state]
       [--max-cost-eth 0.1] [--stream-duration-ms 3600000] [--skip-wallet-balance-check]

Environment:
  ETH_RPC_URL, PRIVATE_KEY, STATION_ADDRESS, CHAIN=${chainNames}
  optional ETH_SEND_RPC_URLS comma-separated fallback list
`)
  process.exit(exitCode)
}

if (helpRequested()) usage(0)
dotenv.config({ quiet: true })
installEndpointSafeProcessHandlers(rpcUrls)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function saveState(statePath, state, { dryRun = false } = {}) {
  savePublisherState(statePath, state, { dryRun })
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

function shortError(error, endpoints = []) {
  const cause = error?.cause || {}
  const status = error?.status || cause.status ? ` status ${error?.status || cause.status}` : ''
  const details = endpointSafeErrorMessage(error, endpoints)
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
  const pending = state.submitted
  if (!pending.length) return baseMaxPending
  const oldestMs = Math.max(...pending.map((item) => pendingAgeMs(item)))
  if (oldestMs > segmentMs * 4) return minPending
  if (pending.length >= baseMaxPending && oldestMs < segmentMs * 1.5) return Math.min(maxPending, baseMaxPending + 1)
  return baseMaxPending
}

function makeClients({ urls, account, chain }) {
  return urls.map((url, index) => {
    const transport = http(url, { timeout: 60_000 })
    return {
      url,
      label: credentialSafeEndpointLabel(url, `RPC endpoint ${index + 1}`),
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
  const dirArg = readArg('dir')
  const streamId = readArg('stream-id')
  if (!dirArg || !streamId) usage()
  const dryRun = hasFlag('dry-run')
  if (!dryRun && (!process.env.ETH_RPC_URL || !process.env.PRIVATE_KEY || !process.env.STATION_ADDRESS)) usage()

  let chainName = process.env.CHAIN || 'sepolia'
  let chain = null
  if (!dryRun) {
    const chainConfig = chainFromEnv()
    chainName = chainConfig.chainName
    chain = chainConfig.chain
    requireSupportedChain(chain)
    requireMainnetConfirmation(chainName, 'publish live blob transactions')
  }

  const dir = path.resolve(dirArg)
  const segmentMs = segmentMsArg('24000')
  const codec = readArg('codec', 'av1-opus/webm')
  const startSeq = numberArg('start-seq', '0', { integer: true, min: 0 })
const maxBlobs = maxBlobsArg('6')
const maxBytes = numberArg('max-bytes', String(maxBlobs * 126_976), { integer: true, min: 1 })
const maximumPayloadBytes = Math.min(maxBytes, maxBlobs * BLOB_DATA_BYTES)
  const baseMaxPending = numberArg('max-pending', '2', { integer: true, min: 1, max: MAX_SUBMITTED_HISTORY })
  const minPending = numberArg('max-pending-min', '1', { integer: true, min: 1, max: MAX_SUBMITTED_HISTORY })
  const hardMaxPending = numberArg('max-pending-max', String(Math.max(baseMaxPending, 4)), {
    integer: true,
    min: 1,
    max: MAX_SUBMITTED_HISTORY,
  })
  const pollMs = numberArg('poll-ms', '1000', { integer: true, min: 1 })
  const sendRetries = numberArg('send-retries', '8', { integer: true, min: 1 })
  const retryMs = numberArg('retry-ms', '5000', { integer: true, min: 0 })
  const requireManifest = hasFlag('require-manifest')
  const recoverState = hasFlag('recover-state')
  const stateArg = readArg('state')
  const once = hasFlag('once')
  const exitWhenCaughtUp = hasFlag('exit-when-caught-up')
  const adaptivePending = hasFlag('adaptive-pending')
  const costOptions = readCostOptions(process.argv)
  const requestedRuntimeBudgetWei = costOptions.maxCostEth ? parseEthToWei(costOptions.maxCostEth) : null
  const configuredRpcUrls = dryRun ? [] : rpcUrls()

  if (!fs.existsSync(dir)) throw new Error(`Segment directory not found: ${dir}`)
  const segmentSet = resolveSegmentSet({ directory: dir, streamId, migrate: !dryRun, allowUnmanifestedSafeLegacy: true, allowInvalidSafeLegacyManifest: !requireManifest })
  const filePrefix = segmentSet.filePrefix
  const publisherAddress = process.env.PRIVATE_KEY
    ? privateKeyToAccount(/** @type {`0x${string}`} */ (process.env.PRIVATE_KEY)).address
    : process.env.PUBLISHER_ADDRESS
  const publisherIdentity = scopedStreamFilesystemIdentity({ chain: chainName, station: process.env.STATION_ADDRESS, publisher: publisherAddress, streamId })
  const defaultStatePath = path.resolve(`work/blob-radio-testnet/live-state/${publisherIdentity.key}.pipelined.json`)
  const statePath = dryRun
    ? path.resolve(stateArg || defaultStatePath)
    : resolveScopedJsonPath({
        explicitPath: stateArg,
        targetPath: defaultStatePath,
        legacyPath: path.resolve(`work/blob-radio-testnet/live-state/${legacyFilesystemKey(streamId)}.pipelined.json`),
        streamId,
        identity: publisherIdentity,
        description: 'pipelined publisher state',
      })
  if (!Number.isInteger(baseMaxPending) || baseMaxPending < 1) throw new Error(`Invalid --max-pending ${baseMaxPending}`)
  if (!Number.isInteger(minPending) || minPending < 1) throw new Error(`Invalid --max-pending-min ${minPending}`)
  if (!Number.isInteger(hardMaxPending) || hardMaxPending < baseMaxPending) {
    throw new Error(`Invalid --max-pending-max ${hardMaxPending}; must be >= --max-pending`)
  }
  if (!dryRun) fs.mkdirSync(path.dirname(statePath), { recursive: true })

  let state = makePublisherState({
    streamId,
    startSeq,
    previousSegmentHash: zeroHash,
    submitted: true,
  })
  state.filesystemIdentity = publisherIdentity
  state.metrics.latestPendingLimit = baseMaxPending
  state.metrics.runtimeBudgetWei = requestedRuntimeBudgetWei?.toString() || null
  if (!dryRun && fs.existsSync(statePath) && !hasFlag('reset')) {
    const recoveredState = readPublisherStateWithRecovery(statePath, state, { submitted: true, recover: recoverState })
    state = recoveredState.state
    if (recoveredState.recovered) {
      console.warn(`Recovered from invalid publisher state: moved ${statePath} to ${recoveredState.quarantinePath}`)
      console.warn(`Recovery status written to ${recoveredState.statusPath}`)
    }
  }
  const runtimeBudgetWei = requestedRuntimeBudgetWei
    ?? (state.metrics.runtimeBudgetWei ? BigInt(state.metrics.runtimeBudgetWei) : null)
  if (!dryRun && chainName === 'mainnet' && runtimeBudgetWei === null) {
    throw new Error('--max-cost-eth is required for mainnet publishing')
  }
  if (runtimeBudgetWei !== null) state.metrics.runtimeBudgetWei = runtimeBudgetWei.toString()

  let account = null
  let clients = []
  let kzg = null
  let nextNonce = 0
  let accountLease = null
  if (!dryRun) {
    account = privateKeyToAccount(/** @type {`0x${string}`} */ (process.env.PRIVATE_KEY))
    clients = makeClients({ urls: configuredRpcUrls, account, chain })
    const publicClient = clients[0].publicClient
    await assertRpcChain(publicClient, chain)
    accountLease = acquireAccountLease({ chainId: chain.id, account: account.address })
    const wasmKzg = await loadKZG()
    kzg = {
      /** @param {Uint8Array} blob */
      blobToKzgCommitment(blob) {
        const blobHex = /** @type {`0x${string}`} */ (bytesToHex(blob))
        const commitmentHex = /** @type {`0x${string}`} */ (wasmKzg.blobToKzgCommitment(blobHex))
        return hexToBytes(commitmentHex)
      },
      /** @param {Uint8Array} blob @param {Uint8Array} commitment */
      computeBlobKzgProof(blob, commitment) {
        const blobHex = /** @type {`0x${string}`} */ (bytesToHex(blob))
        const commitmentHex = /** @type {`0x${string}`} */ (bytesToHex(commitment))
        const proofHex = /** @type {`0x${string}`} */ (wasmKzg.computeBlobKZGProof(blobHex, commitmentHex))
        return hexToBytes(proofHex)
      },
    }
    nextNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
  }
  const maxSubmittedNonce = state.submitted.reduce((max, item) => {
    if (item.nonce === undefined || item.nonce === null || item.nonce === '') return max
    return Math.max(max, publisherStateInteger(item.nonce, 'submitted nonce'))
  }, -1)
  nextNonce = Math.max(nextNonce, maxSubmittedNonce + 1)

  function currentExposure(nextReservedWei = 0n) {
    const pending = pendingReservedExposure(state.submitted)
    const confirmedSpendWei = BigInt(state.metrics.actualSpendWei)
    const decision = runtimeExposureDecision({
      budgetWei: runtimeBudgetWei,
      confirmedSpendWei,
      pendingReservedWei: pending.totalWei,
      nextReservedWei,
    })
    state.metrics.reservedPendingWei = pending.totalWei.toString()
    state.metrics.totalExposureWei = (confirmedSpendWei + pending.totalWei).toString()
    state.metrics.pendingCount = state.submitted.length
    return { ...decision, unknownPendingReservations: pending.unknown }
  }

  currentExposure()

  console.log(`pipelined publisher watching ${dir}`)
  console.log(`stream: ${streamId}`)
  console.log(`next sequence: ${state.nextSequence}`)
  console.log(`max pending: ${baseMaxPending}${adaptivePending ? ` adaptive ${minPending}-${hardMaxPending}` : ''}`)
  console.log(`send retries: ${sendRetries}, retry ms: ${retryMs}`)
  console.log(`next nonce: ${nextNonce}`)
  if (dryRun) {
    console.log('dry run: validating local segment discovery and guardrails without publishing')
  } else {
    console.log(`rpc read: ${clients[0].label}`)
    console.log(`rpc send order: ${clients.map((client) => client.label).join(', ')}`)
  }

  if (!dryRun && hasCostBudget()) {
    await runCostPreflightOrExit({
      segments: readSegmentFilesAsCostSegments(
        segmentEntries(dir, filePrefix)
          .filter((entry) => entry.sequence >= state.nextSequence)
          .map((entry) => entry.file),
      ),
      segmentMs,
    })
  }

  async function sendTransactionWithFallback(serializedTransaction, expectedHash) {
    if (signedTransactionHash(serializedTransaction).toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error('Serialized transaction does not match its durable transaction hash')
    }
    let lastError = null
    for (let attempt = 1; attempt <= sendRetries; attempt += 1) {
      for (const client of clients) {
        try {
          if (attempt > 1) console.log(`send retry ${attempt}/${sendRetries} via ${client.label}`)
          const hash = await client.walletClient.sendRawTransaction({ serializedTransaction })
          if (hash.toLowerCase() !== expectedHash.toLowerCase()) {
            throw new Error(`RPC returned unexpected transaction hash ${hash}`)
          }
          return hash
        } catch (error) {
          lastError = error
          console.warn(`send via ${client.label} failed: ${shortError(error, configuredRpcUrls)}`)
          if (await getReceipt(expectedHash) || await getTransaction(expectedHash)) return expectedHash
        }
      }
      if (attempt < sendRetries) await sleep(retryMs)
    }
    throw new Error(`Unable to send blob transaction after ${sendRetries} attempt(s): ${shortError(lastError, configuredRpcUrls)}`)
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
          stationEventSequenceMatches(log.args.sequence, item.sequence)
        )
      })
    if (!stationEvent) {
      throw new Error(`Transaction ${item.txHash} did not emit Station SegmentPublished for ${streamId} seq ${item.sequence}`)
    }
    return assertStationEventMetadata(stationEvent, {
      streamId,
      durationMs: segmentMs,
      payloadBytes: item.payloadBytes,
      payloadSha256: item.payloadSha256,
      codec,
      previousSegmentHash: item.previousSegmentHash,
    })
  }

  async function confirmSubmitted() {
    const remaining = []
    for (const item of state.submitted) {
      let receipt = await getReceipt(item.txHash)
      if (!receipt && item.serializedTransaction) {
        const recoveryData = buildStationData({
          streamId,
          sequence: item.sequence,
          durationMs: segmentMs,
          payloadBytes: item.payloadBytes,
          payloadSha256: item.payloadSha256,
          codec,
          previousSegmentHash: item.previousSegmentHash,
          blobCount: item.blobCount,
        })
        await assertRecoveredSignedTransactionIntent(item.serializedTransaction, {
          txHash: item.txHash,
          chainId: chain.id,
          publisher: account.address,
          destination: process.env.STATION_ADDRESS,
          nonce: item.nonce,
          data: recoveryData,
          blobVersionedHashes: item.blobVersionedHashes,
          blobCount: item.blobCount,
          reservedCostWei: item.reservedCostWei,
        })
        console.log(`rebroadcasting prepared seq ${item.sequence}: ${item.txHash}`)
        await sendTransactionWithFallback(item.serializedTransaction, item.txHash)
        maybeInjectPublisherFault('pipelined-after-broadcast')
        item.submissionStatus = 'broadcast'
        item.broadcastAt ||= new Date().toISOString()
        saveState(statePath, state, { dryRun })
        receipt = await getReceipt(item.txHash)
      }
      if (!receipt) {
        remaining.push(item)
        continue
      }
      maybeInjectPublisherFault('pipelined-after-confirmation')
      const stationEvent = verifyStationEvent(receipt, item)
      const transaction = await getTransaction(item.txHash)
      const manifest = withFilesystemIdentity({
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
        publisher: account.address,
        txHash: item.txHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber.toString(),
        transactionIndex: receipt.transactionIndex,
        blobVersionedHashes: manifestBlobVersionedHashes(transaction, stationEvent),
        createdAt: new Date().toISOString(),
      }, publisherIdentity)
      fs.mkdirSync('work/blob-radio-testnet/manifests', { recursive: true })
      const manifestPath = path.resolve(`work/blob-radio-testnet/manifests/${publisherIdentity.key}-${item.sequence}.json`)
      atomicWriteJson(manifestPath, manifest)

      const itemSequence = publisherStateInteger(item.sequence, 'submitted sequence')
      if (!state.published.some((published) => publisherStateInteger(published.sequence, 'published sequence') === itemSequence)) {
        const costs = receiptCostWei(receipt, { expectedBlobCount: item.blobCount })
        if (item.reservedCostWei && costs.totalWei > BigInt(item.reservedCostWei)) {
          throw new Error(`Confirmed transaction ${item.txHash} cost exceeds its reserved exposure`)
        }
        const includedAt = manifest.createdAt
        const timings = {
          generatedToSubmitMs: timingMs(item.generatedAt, item.submittedAt),
          submitToIncludedMs: timingMs(item.submittedAt, includedAt),
          generatedToIncludedMs: timingMs(item.generatedAt, includedAt),
          firstSeenToIncludedMs: timingMs(item.firstSeenAt, includedAt),
        }
        appendPublishedHistory(state, {
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
        state.metrics.confirmedCount = publisherStateInteger(state.metrics.confirmedCount, 'metrics.confirmedCount') + 1
        state.metrics.latestTimings = timings
        state.metrics.actualSpendWei = (BigInt(state.metrics.actualSpendWei) + costs.totalWei).toString()
        state.metrics.actualExecutionSpendWei = (
          BigInt(state.metrics.actualExecutionSpendWei) + costs.executionWei
        ).toString()
        state.metrics.actualBlobSpendWei = (BigInt(state.metrics.actualBlobSpendWei) + costs.blobWei).toString()
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
    currentExposure()
    saveState(statePath, state, { dryRun })
  }

  let budgetBlocked

  async function submitNext() {
    const entry = segmentEntry(dir, filePrefix, state.nextSequence)
    if (!entry) return false

    const firstSeenAt = new Date().toISOString()
    const manifestSegment = await waitForManifestSegment(dir, filePrefix, state.nextSequence, pollMs, requireManifest)
    const file = manifestSegment?.file || entry.file
    const stat = manifestSegment ? fs.statSync(file) : await waitForStableFile(file, pollMs)
    const generatedAt = new Date(stat.mtimeMs).toISOString()
    const payload = readBoundedFileSync(file, {
      maxBytes: maximumPayloadBytes,
      label: `segment ${state.nextSequence} payload`,
    })
    const blobs = toBlobs({ data: bytesToHex(payload) })
    const blobVersionedHashes = dryRun ? [] : commitmentsToVersionedHashes({
      commitments: blobsToCommitments({ blobs, kzg, to: 'hex' }),
      to: 'hex',
    })
    const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex')
    if (payload.length > maxBytes || blobs.length > maxBlobs) {
      throw new Error(
        `Segment ${state.nextSequence} exceeds guardrails: ${payload.length} bytes, ${blobs.length} blobs; limits ${maxBytes} bytes, ${maxBlobs} blobs`,
      )
    }

    const sequence = state.nextSequence
    const previousSegmentHash = state.previousSegmentHash
    if (dryRun) {
      console.log(`would submit seq ${sequence}: ${payload.length} bytes, ${blobs.length} blob(s), previous ${previousSegmentHash}`)
      state.metrics.submittedCount = publisherStateInteger(state.metrics.submittedCount, 'metrics.submittedCount') + 1
      state.nextSequence += 1
      state.previousSegmentHash = `0x${payloadSha256}`
      return true
    }

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
    const maxFeePerBlobGas = optionalGweiEnv('MAX_FEE_PER_BLOB_GAS_GWEI')
    const maxFeePerGas = optionalGweiEnv('MAX_FEE_PER_GAS_GWEI')
    const maxPriorityFeePerGas = optionalGweiEnv('MAX_PRIORITY_FEE_PER_GAS_GWEI')
    const gas = gasLimitEnv('GAS_LIMIT', 180000n)
    if (maxFeePerBlobGas !== undefined) tx.maxFeePerBlobGas = maxFeePerBlobGas
    if (maxFeePerGas !== undefined) tx.maxFeePerGas = maxFeePerGas
    if (maxPriorityFeePerGas !== undefined) tx.maxPriorityFeePerGas = maxPriorityFeePerGas
    if (gas !== undefined) tx.gas = gas

    const preparedTransaction = await clients[0].walletClient.prepareTransactionRequest(tx)
    const reservedCostWei = transactionExposureWei(preparedTransaction, blobs.length)
    const exposure = currentExposure(reservedCostWei)
    if (exposure.unknownPendingReservations) {
      budgetBlocked = true
      state.metrics.runtimeBudgetExhausted = true
      state.metrics.runtimeBudgetExhaustedAt ||= new Date().toISOString()
      saveState(statePath, state, { dryRun })
      console.log('runtime budget paused: recovered pending transactions lack durable exposure reservations')
      return false
    }
    try {
      assertRuntimeExposureBudget({
        budgetWei: runtimeBudgetWei,
        confirmedSpendWei: exposure.confirmedSpendWei,
        pendingReservedWei: exposure.pendingReservedWei,
        nextReservedWei: reservedCostWei,
      })
    } catch (error) {
      budgetBlocked = true
      state.metrics.runtimeBudgetExhausted = true
      state.metrics.runtimeBudgetExhaustedAt ||= new Date().toISOString()
      saveState(statePath, state, { dryRun })
      console.log(shortError(error))
      return false
    }
    const serializedTransaction = await clients[0].walletClient.signTransaction(preparedTransaction)
    const txHash = signedTransactionHash(serializedTransaction)

    const submittedAt = new Date().toISOString()
    const submittedItem = {
      sequence,
      file,
      payloadBytes: payload.length,
      payloadSha256,
      blobCount: blobs.length,
      blobVersionedHashes,
      previousSegmentHash,
      txHash,
      serializedTransaction,
      reservedCostWei: reservedCostWei.toString(),
      submissionStatus: 'prepared',
      nonce: nextNonce,
      firstSeenAt,
      generatedAt,
      submittedAt,
    }
    state.submitted.push(submittedItem)
    state.metrics.submittedCount = publisherStateInteger(state.metrics.submittedCount, 'metrics.submittedCount') + 1
    state.nextSequence += 1
    state.previousSegmentHash = `0x${payloadSha256}`
    nextNonce += 1
    currentExposure()
    saveState(statePath, state, { dryRun })
    maybeInjectPublisherFault('pipelined-after-prepared')

    console.log(`submitting seq ${sequence}: ${payload.length} bytes, ${blobs.length} blob(s), nonce ${submittedItem.nonce}, reserved ${reservedCostWei} wei`)
    await sendTransactionWithFallback(serializedTransaction, txHash)
    maybeInjectPublisherFault('pipelined-after-broadcast')
    submittedItem.submissionStatus = 'broadcast'
    submittedItem.broadcastAt = new Date().toISOString()
    saveState(statePath, state, { dryRun })
    console.log(`submitted seq ${sequence}: ${txHash}`)
    return true
  }

  while (true) {
    budgetBlocked = false
    if (!dryRun) await confirmSubmitted()
    const exposure = currentExposure()
    if (runtimeBudgetWei !== null && (exposure.unknownPendingReservations || exposure.totalExposureWei >= runtimeBudgetWei)) {
      state.metrics.runtimeBudgetExhausted = true
      state.metrics.runtimeBudgetExhaustedAt ||= new Date().toISOString()
      saveState(statePath, state, { dryRun })
      console.log(
        `runtime budget fully reserved: confirmed ${formatEth(BigInt(state.metrics.actualSpendWei))} ETH + pending ${formatEth(exposure.pendingReservedWei)} ETH / ${formatEth(runtimeBudgetWei)} ETH`,
      )
      if (!state.submitted.length) break
      await sleep(pollMs)
      continue
    }

    let submittedAny = false
    const pendingLimit = adaptivePending
      ? adaptivePendingLimit({ state, baseMaxPending, minPending, maxPending: hardMaxPending, segmentMs })
      : baseMaxPending
    state.metrics.latestPendingLimit = pendingLimit
    state.metrics.pendingCount = state.submitted.length
    saveState(statePath, state, { dryRun })

    while (state.submitted.length < pendingLimit) {
      const didSubmit = await submitNext()
      if (!didSubmit) break
      submittedAny = true
      if (once) break
    }

    if (budgetBlocked) {
      if (!state.submitted.length) break
      await sleep(pollMs)
      continue
    }

    if ((once || exitWhenCaughtUp) && !submittedAny && state.submitted.length === 0) break
    await sleep(pollMs)
  }

  if (!dryRun) await confirmSubmitted()
  saveState(statePath, state, { dryRun })
  accountLease?.release()
  console.log(dryRun ? 'dry run complete: no state written' : `state: ${statePath}`)
}

main().catch((error) => {
  console.error(shortError(error, rpcUrls()))
  process.exit(1)
})
