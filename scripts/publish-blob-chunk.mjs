import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
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
  isAddress,
  keccak256,
  stringToBytes,
  zeroHash,
  toBlobs,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { assertRpcChain, chainFromEnv, chainNames, requireMainnetConfirmation, requireSupportedChain } from './chains.mjs'
import { hasFlag, numberArg, readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import { acquireAccountLease } from './lib/account-lease.mjs'
import { readBoundedFileSync } from './lib/bounded-files.mjs'
import {
  assertRecoveredSignedTransactionIntent,
  assertRuntimeExposureBudget,
  assertTransactionExposureCeiling,
  atomicWriteJson,
  defaultSubmissionJournalPath,
  maybeInjectPublisherFault,
  parseExposureCeilingEth,
  readSubmissionJournal,
  receiptCostWei,
  signedTransactionHash,
  transactionExposureWei,
  writeSubmissionJournal,
} from './lib/publisher-safety.mjs'
import { gasLimitEnv, optionalGweiEnv } from './lib/tx-env.mjs'
import { scopedStreamFilesystemIdentity, withFilesystemIdentity } from './lib/filesystem-identity.mjs'
import { endpointSafeErrorMessage, installEndpointSafeProcessHandlers } from './lib/endpoint-privacy.mjs'
import { assertStationEventMetadata, manifestBlobVersionedHashes, stationEventSequenceMatches } from './lib/publisher-manifest.mjs'
import { MAX_BLOBS_PER_SEGMENT } from './lib/station-abi.mjs'
import { BLOB_DATA_BYTES } from './lib/station-cli.mjs'

function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm blob:publish -- --input <file> [--stream-id demo] [--seq 0] [--duration-ms 6000] [--codec av1/webm]
                       [--max-exposure-eth 0.01] [--submission-journal <file>]

Environment:
  ETH_RPC_URL, PRIVATE_KEY, CHAIN=${chainNames}, optional TO_ADDRESS, STATION_ADDRESS, GAS_LIMIT

Recovery:
  A scoped durable submission journal is used by default. Disabling it requires
  the explicit unsafe flag --unsafe-no-submission-journal.
`)
  process.exit(exitCode)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getTransactionWithRetry(hash, attempts = 8, retryMs = 3000) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await publicClient.getTransaction({ hash })
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      console.warn(`getTransaction retry ${attempt}/${attempts} for ${hash}: ${endpointSafeErrorMessage(error, [rpcUrl])}`)
      await sleep(retryMs)
    }
  }
  throw lastError
}

function assertBytes32Hex(value, name) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Invalid --${name}: expected 32-byte hex`)
}

if (helpRequested()) usage(0)
dotenv.config({ quiet: true })

const input = readArg('input')
if (!input) usage()

const inputPath = path.resolve(input)
const requestedStreamId = readArg('stream-id')
const sequence = numberArg('seq', '0', { integer: true, min: 0 })
const durationMs = numberArg('duration-ms', '0', { integer: true, min: 0 })
const codec = readArg('codec', 'av1/webm')
const previousSegmentHash = readArg('previous-hash', zeroHash)
const stationAddress = readArg('station-address', process.env.STATION_ADDRESS)
const explicitSubmissionJournalPath = readArg('submission-journal')
const unsafeNoSubmissionJournal = hasFlag('unsafe-no-submission-journal')
if (explicitSubmissionJournalPath && unsafeNoSubmissionJournal) {
  throw new Error('--submission-journal and --unsafe-no-submission-journal cannot be combined')
}
const remainingBudgetWeiText = readArg('remaining-budget-wei')
const remainingBudgetWei = remainingBudgetWeiText === undefined ? null : BigInt(remainingBudgetWeiText)
const maximumExposureEth = readArg('max-exposure-eth')
const explicitExposureCeilingWei = maximumExposureEth === undefined
  ? null
  : parseExposureCeilingEth(maximumExposureEth, '--max-exposure-eth')
const hardExposureCeilingWei = explicitExposureCeilingWei === null
  ? remainingBudgetWei
  : remainingBudgetWei === null
    ? explicitExposureCeilingWei
    : explicitExposureCeilingWei < remainingBudgetWei ? explicitExposureCeilingWei : remainingBudgetWei
assertBytes32Hex(previousSegmentHash, 'previous-hash')
if (stationAddress && !isAddress(stationAddress)) throw new Error(`Invalid --station-address: ${stationAddress}`)
if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`)

const rpcUrl = process.env.ETH_RPC_URL
installEndpointSafeProcessHandlers(() => [rpcUrl].filter(Boolean))
const privateKey = process.env.PRIVATE_KEY
const { chainName, chain } = chainFromEnv()

if (!rpcUrl || !privateKey) usage()
requireSupportedChain(chain)
requireMainnetConfirmation(chainName, 'publish blob transaction')

const maxFeePerBlobGas = optionalGweiEnv('MAX_FEE_PER_BLOB_GAS_GWEI')
const maxFeePerGas = optionalGweiEnv('MAX_FEE_PER_GAS_GWEI')
const maxPriorityFeePerGas = optionalGweiEnv('MAX_PRIORITY_FEE_PER_GAS_GWEI')
const gas = gasLimitEnv()

const maximumPayloadBytes = MAX_BLOBS_PER_SEGMENT * BLOB_DATA_BYTES
const payload = readBoundedFileSync(inputPath, {
  maxBytes: maximumPayloadBytes,
  label: `publish input ${inputPath}`,
})
const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex')
// A content-derived default keeps the logical identity and journal path stable
// across a crash/restart even when the caller omitted --stream-id.
const streamId = requestedStreamId || `eth-radio-${payloadSha256.slice(0, 16)}`

const account = privateKeyToAccount(/** @type {`0x${string}`} */ (privateKey))
const publisherIdentity = scopedStreamFilesystemIdentity({ chain: chainName, station: stationAddress, publisher: account.address, streamId })
const submissionJournalPath = unsafeNoSubmissionJournal
  ? null
  : explicitSubmissionJournalPath
    ? path.resolve(explicitSubmissionJournalPath)
    : defaultSubmissionJournalPath({ publisherKey: publisherIdentity.key, sequence })
if (unsafeNoSubmissionJournal) {
  console.warn('UNSAFE: standalone transaction recovery is disabled by --unsafe-no-submission-journal')
}
const to = process.env.TO_ADDRESS || account.address
const wasmKzg = await loadKZG()
const kzg = {
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

const transport = http(rpcUrl, { timeout: 60_000 })
const publicClient = createPublicClient({ chain, transport })
const walletClient = createWalletClient({
  account,
  chain,
  transport,
})
await assertRpcChain(publicClient, chain)
const accountLease = acquireAccountLease({ chainId: chain.id, account: account.address })

const blobs = toBlobs({ data: bytesToHex(payload) })
if (blobs.length > 6) {
  throw new Error(`Input needs ${blobs.length} blobs. Start with <= 6 blobs per tx for the prototype.`)
}
const blobVersionedHashes = commitmentsToVersionedHashes({
  commitments: blobsToCommitments({ blobs, kzg, to: 'hex' }),
  to: 'hex',
})

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

const data = stationAddress
  ? encodeFunctionData({
      abi: stationAbi,
      functionName: 'publishSegment',
      args: [
        streamId,
        BigInt(sequence),
        BigInt(durationMs),
        payload.length,
        `0x${payloadSha256}`,
        codec,
        previousSegmentHash,
        blobs.length,
      ],
    })
  : bytesToHex(
      Buffer.from(
        JSON.stringify({
          app: 'eth-radio',
          version: 1,
          streamId,
          sequence,
          durationMs,
          payloadBytes: payload.length,
          sha256: payloadSha256,
          codec,
          previousSegmentHash,
        }),
      ),
    )

const tx = {
  account,
  chain,
  blobs,
  kzg,
  to: stationAddress || to,
  data,
}

if (maxFeePerBlobGas !== undefined) tx.maxFeePerBlobGas = maxFeePerBlobGas
if (maxFeePerGas !== undefined) tx.maxFeePerGas = maxFeePerGas
if (maxPriorityFeePerGas !== undefined) tx.maxPriorityFeePerGas = maxPriorityFeePerGas
if (gas !== undefined) tx.gas = gas

console.log(`Publishing ${payload.length} bytes as ${blobs.length} blob(s) on ${chain.name}...`)
let journal = submissionJournalPath ? readSubmissionJournal(submissionJournalPath) : null
let serializedTransaction
let hash
let reservedCostWei
if (journal) {
  const matches = journal.streamId === streamId
    && Number(journal.sequence) === sequence
    && journal.chain === chainName
    && journal.publisher.toLowerCase() === account.address.toLowerCase()
    && journal.destination.toLowerCase() === String(stationAddress || to).toLowerCase()
    && Number(journal.durationMs) === durationMs
    && journal.codec === codec
    && String(journal.stationAddress || '').toLowerCase() === String(stationAddress || '').toLowerCase()
    && Number(journal.payloadBytes) === payload.length
    && Number(journal.blobCount) === blobs.length
    && Array.isArray(journal.blobVersionedHashes)
    && journal.blobVersionedHashes.length === blobVersionedHashes.length
    && journal.blobVersionedHashes.every((value, index) => value.toLowerCase() === blobVersionedHashes[index].toLowerCase())
    && journal.payloadSha256.toLowerCase() === `0x${payloadSha256}`
    && journal.previousSegmentHash.toLowerCase() === previousSegmentHash.toLowerCase()
  if (!matches) throw new Error('Submission journal does not match the requested segment')
  serializedTransaction = journal.serializedTransaction
  hash = journal.txHash
  reservedCostWei = BigInt(journal.reservedCostWei)
  if (signedTransactionHash(serializedTransaction).toLowerCase() !== hash.toLowerCase()) {
    throw new Error('Submission journal serialized transaction does not match its transaction hash')
  }
  await assertRecoveredSignedTransactionIntent(serializedTransaction, {
    txHash: hash,
    chainId: chain.id,
    publisher: account.address,
    destination: stationAddress || to,
    nonce: journal.nonce,
    data,
    blobVersionedHashes,
    blobCount: blobs.length,
    reservedCostWei,
  })
} else {
  const preparedTransaction = await walletClient.prepareTransactionRequest(tx)
  reservedCostWei = transactionExposureWei(preparedTransaction, blobs.length)
  assertTransactionExposureCeiling({
    chainName,
    ceilingWei: hardExposureCeilingWei,
    exposureWei: reservedCostWei,
    action: 'blob publish',
  })
  serializedTransaction = await walletClient.signTransaction({ ...preparedTransaction, account, chain, kzg })
  hash = signedTransactionHash(serializedTransaction)
  assertRuntimeExposureBudget({
    budgetWei: remainingBudgetWei,
    nextReservedWei: reservedCostWei,
  })
  if (submissionJournalPath) {
    journal = {
      version: 2,
      status: 'prepared',
      streamId,
      sequence,
      chain: chainName,
      publisher: account.address,
      destination: stationAddress || to,
      durationMs,
      codec,
      stationAddress: stationAddress || null,
      nonce: preparedTransaction.nonce,
      input: inputPath,
      payloadBytes: payload.length,
      payloadSha256: `0x${payloadSha256}`,
      blobCount: blobs.length,
      blobVersionedHashes,
      previousSegmentHash,
      txHash: hash,
      serializedTransaction,
      reservedCostWei: reservedCostWei.toString(),
      preparedAt: new Date().toISOString(),
    }
    writeSubmissionJournal(submissionJournalPath, journal)
    maybeInjectPublisherFault('serial-after-prepared')
  }
}
assertTransactionExposureCeiling({
  chainName,
  ceilingWei: hardExposureCeilingWei,
  exposureWei: reservedCostWei,
  action: 'blob publish',
})
const journalExposureWei = journal?.status === 'confirmed' && journal.actualCostWei !== undefined
  ? BigInt(journal.actualCostWei)
  : reservedCostWei
assertRuntimeExposureBudget({
  budgetWei: remainingBudgetWei,
  nextReservedWei: journalExposureWei,
})

if (journal?.status !== 'confirmed') {
  try {
    const submittedHash = await walletClient.sendRawTransaction({ serializedTransaction })
    if (submittedHash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(`RPC returned unexpected transaction hash ${submittedHash}`)
    }
  } catch (error) {
    const knownReceipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null)
    const knownTransaction = await publicClient.getTransaction({ hash }).catch(() => null)
    if (!knownReceipt && !knownTransaction) throw error
  }
  maybeInjectPublisherFault('serial-after-broadcast')
  if (journal && submissionJournalPath) {
    journal.status = 'broadcast'
    journal.broadcastAt ||= new Date().toISOString()
    writeSubmissionJournal(submissionJournalPath, journal)
  }
}
console.log(`tx: ${hash}`)

const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') {
  throw new Error(`Transaction ${hash} was included but failed with status ${receipt.status}`)
}
const transaction = await getTransactionWithRetry(hash)
const streamIdHash = keccak256(stringToBytes(streamId))
let stationEvent = null
if (stationAddress) {
  stationEvent = receipt.logs
    .filter((log) => log.address.toLowerCase() === stationAddress.toLowerCase())
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
        stationEventSequenceMatches(log.args.sequence, sequence)
      )
    })
  if (!stationEvent) {
    throw new Error(`Transaction ${hash} did not emit Station SegmentPublished for ${streamId} seq ${sequence}`)
  }
  assertStationEventMetadata(stationEvent, {
    streamId,
    durationMs,
    payloadBytes: payload.length,
    payloadSha256,
    codec,
    previousSegmentHash,
  })
}

const costs = receiptCostWei(receipt, { expectedBlobCount: blobs.length })
if (costs.totalWei > reservedCostWei) {
  throw new Error(`Confirmed transaction ${hash} cost exceeds its reserved exposure`)
}
if (journal && submissionJournalPath) {
  journal.status = 'confirmed'
  journal.confirmedAt = new Date().toISOString()
  journal.actualCostWei = costs.totalWei.toString()
  journal.executionCostWei = costs.executionWei.toString()
  journal.blobCostWei = costs.blobWei.toString()
  writeSubmissionJournal(submissionJournalPath, journal)
  maybeInjectPublisherFault('serial-after-confirmation')
}

const manifest = withFilesystemIdentity({
  app: 'eth-radio',
  version: 1,
  chain: chainName,
  streamId,
  sequence,
  durationMs,
  codec,
  input: inputPath,
  payloadBytes: payload.length,
  payloadSha256,
  previousSegmentHash,
  blobCount: blobs.length,
  stationAddress: stationAddress || null,
  publisher: account.address,
  txHash: hash,
  blockHash: receipt.blockHash,
  blockNumber: receipt.blockNumber.toString(),
  costWei: costs.totalWei.toString(),
  executionCostWei: costs.executionWei.toString(),
  blobCostWei: costs.blobWei.toString(),
  blobVersionedHashes: manifestBlobVersionedHashes(transaction, stationEvent),
  createdAt: new Date().toISOString(),
}, publisherIdentity)

fs.mkdirSync('work/blob-radio-testnet/manifests', { recursive: true })
const out = path.resolve(
  `work/blob-radio-testnet/manifests/${publisherIdentity.key}-${sequence}.json`,
)
atomicWriteJson(out, manifest)

console.log(`manifest: ${out}`)
accountLease.release()
