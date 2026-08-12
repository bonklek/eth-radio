import fs from 'node:fs'
import path from 'node:path'
import { isAddress, keccak256, parseEther, parseTransaction, recoverTransactionAddress, serializeTransaction } from 'viem'
import { readBoundedJsonFileSync } from './bounded-files.mjs'

export const BLOB_GAS_PER_BLOB = 131_072n

const bytes32Hex = /^0x[0-9a-fA-F]{64}$/
const addressHex = /^0x[0-9a-fA-F]{40}$/
const decimalInteger = /^\d+$/
const serializedTransactionHex = /^0x[0-9a-fA-F]+$/

function nonNegativeWei(value, label) {
  const text = String(value ?? '')
  if (!decimalInteger.test(text)) throw new Error(`${label} must be a non-negative integer`)
  return BigInt(text)
}

function positiveWei(value, label) {
  const amount = nonNegativeWei(value, label)
  if (amount === 0n) throw new Error(`${label} must be greater than zero`)
  return amount
}

function nonNegativeSafeInteger(value, label) {
  let number
  if (typeof value === 'number') number = value
  else if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) number = Number(value)
  else if (typeof value === 'string' && decimalInteger.test(value)) number = Number(value)
  else throw new Error(`${label} must be a non-negative safe integer`)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return number
}

export function maybeInjectPublisherFault(point, env = process.env) {
  if (env.PUBLISHER_FAULT_INJECT !== point) return
  process.stderr.write(`publisher fault injection: ${point}\n`)
  process.exit(86)
}

function fsyncDirectory(directory) {
  let descriptor
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
    return true
  } catch (error) {
    void error
    return false
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

export function atomicWriteJson(filePath, value, { dryRun = false } = {}) {
  if (dryRun) return { fileSynced: false, directorySynced: false, dryRun: true }
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let descriptor
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    maybeInjectPublisherFault('atomic-before-rename')
    fs.renameSync(tempPath, filePath)
    const directorySynced = fsyncDirectory(directory)
    maybeInjectPublisherFault('atomic-after-rename')
    return { fileSynced: true, directorySynced, dryRun: false }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      fs.rmSync(tempPath, { force: true })
    } catch (error) {
      void error
    }
  }
}

export function savePublisherStateAtomic(statePath, state, options = {}) {
  atomicWriteJson(statePath, state, options)
}

export function transactionExposureWei(transaction, blobCount) {
  const gas = positiveWei(transaction?.gas, 'transaction gas limit')
  const executionFeePerGas = transaction?.maxFeePerGas ?? transaction?.gasPrice
  const maxFeePerGas = positiveWei(executionFeePerGas, 'transaction maximum fee per gas')
  const blobs = nonNegativeSafeInteger(blobCount, 'transaction blob count')
  if (Array.isArray(transaction?.blobVersionedHashes) && transaction.blobVersionedHashes.length !== blobs) {
    throw new Error('Prepared transaction blob count does not match reserved blob count')
  }
  const maxFeePerBlobGas = blobs
    ? positiveWei(transaction?.maxFeePerBlobGas, 'transaction maximum fee per blob gas')
    : 0n
  const value = nonNegativeWei(transaction?.value ?? 0n, 'transaction value')
  return value + gas * maxFeePerGas + BigInt(blobs) * BLOB_GAS_PER_BLOB * maxFeePerBlobGas
}

export function parseExposureCeilingEth(value, label = 'maximum transaction exposure') {
  const text = String(value ?? '')
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text)) {
    throw new Error(`${label} must be a positive ETH amount with at most 18 decimal places`)
  }
  const wei = parseEther(text)
  if (wei <= 0n) throw new Error(`${label} must be greater than zero`)
  return wei
}

export function assertTransactionExposureCeiling({ chainName, ceilingWei, exposureWei, action = 'transaction' }) {
  const exposure = positiveWei(exposureWei, `${action} maximum exposure`)
  if (ceilingWei === null || ceilingWei === undefined) {
    if (chainName === 'mainnet') throw new Error(`--max-exposure-eth is required for mainnet ${action}`)
    return { exposureWei: exposure, ceilingWei: null }
  }
  const ceiling = positiveWei(ceilingWei, `${action} maximum exposure ceiling`)
  if (exposure > ceiling) {
    throw new Error(`${action} maximum exposure ${exposure} wei exceeds ceiling ${ceiling} wei`)
  }
  return { exposureWei: exposure, ceilingWei: ceiling }
}

export function defaultSubmissionJournalPath({
  publisherKey,
  sequence,
  root = path.resolve('work/blob-radio-testnet/submission-journals'),
}) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(String(publisherKey || ''))) {
    throw new Error('Submission journal publisher key contains unsafe path characters')
  }
  const normalizedSequence = nonNegativeSafeInteger(sequence, 'submission journal sequence')
  const resolvedRoot = path.resolve(root)
  const journalPath = path.resolve(resolvedRoot, `${publisherKey}-${normalizedSequence}.json`)
  if (path.dirname(journalPath) !== resolvedRoot) throw new Error('Submission journal path escapes its root')
  return journalPath
}

export function signedTransactionHash(serializedTransaction) {
  const transaction = { ...parseTransaction(serializedTransaction) }
  Reflect.deleteProperty(transaction, 'sidecars')
  return keccak256(serializeTransaction(transaction))
}

function normalizedHex(value, label) {
  const text = String(value || '')
  if (!/^0x[0-9a-fA-F]*$/.test(text)) throw new Error(`${label} must be 0x-prefixed hex`)
  return text.toLowerCase()
}

/**
 * Fail-closed validation for a durable, recovered signed transaction. Durable
 * metadata is not authoritative on its own: every security-relevant field is
 * rebound to the signed bytes before those bytes may be rebroadcast.
 * @param {`0x${string}`} serializedTransaction
 * @param {{txHash: string, chainId: string | number | bigint, publisher: string, destination: string, nonce: string | number | bigint, data: string, blobVersionedHashes: readonly string[], blobCount: number, reservedCostWei: string | number | bigint, valueWei?: string | number | bigint}} intent
 */
export async function assertRecoveredSignedTransactionIntent(serializedTransaction, intent) {
  if (!isAddress(intent.publisher) || !isAddress(intent.destination)) {
    throw new Error('Recovered transaction intent requires valid publisher and destination addresses')
  }
  const serialized = /** @type {Parameters<typeof parseTransaction>[0]} */ (serializedTransaction)
  const transaction = parseTransaction(serialized)
  if (signedTransactionHash(serializedTransaction).toLowerCase() !== String(intent.txHash || '').toLowerCase()) {
    throw new Error('Recovered signed transaction hash does not match durable intent')
  }
  const expectedChainId = BigInt(intent.chainId)
  if (BigInt(transaction.chainId ?? 0) !== expectedChainId) {
    throw new Error('Recovered signed transaction chain does not match durable intent')
  }
  const recoveredPublisher = await recoverTransactionAddress({
    serializedTransaction: /** @type {Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction']} */ (serializedTransaction),
  })
  if (recoveredPublisher.toLowerCase() !== intent.publisher.toLowerCase()) {
    throw new Error('Recovered signed transaction signer does not match durable intent')
  }
  if (!transaction.to || transaction.to.toLowerCase() !== intent.destination.toLowerCase()) {
    throw new Error('Recovered signed transaction destination does not match durable intent')
  }
  const expectedNonce = nonNegativeSafeInteger(intent.nonce, 'recovered transaction intent nonce')
  if (transaction.nonce !== expectedNonce) {
    throw new Error('Recovered signed transaction nonce does not match durable intent')
  }
  if (normalizedHex(transaction.data || '0x', 'recovered signed transaction data') !== normalizedHex(intent.data, 'recovered transaction intent data')) {
    throw new Error('Recovered signed transaction calldata does not match durable intent')
  }
  if (nonNegativeWei(transaction.value ?? 0n, 'recovered signed transaction value')
    !== nonNegativeWei(intent.valueWei ?? 0n, 'recovered transaction intent value')) {
    throw new Error('Recovered signed transaction value does not match durable intent')
  }
  const expectedBlobCount = nonNegativeSafeInteger(intent.blobCount, 'recovered transaction intent blob count')
  const expectedHashes = Array.isArray(intent.blobVersionedHashes)
    ? intent.blobVersionedHashes.map((hash, index) => normalizedHex(hash, `recovered transaction intent blob hash ${index}`))
    : []
  const transactionBlobVersionedHashes = Reflect.get(transaction, 'blobVersionedHashes')
  const signedHashes = Array.isArray(transactionBlobVersionedHashes)
    ? transactionBlobVersionedHashes.map((hash, index) => normalizedHex(hash, `recovered signed transaction blob hash ${index}`))
    : []
  if (expectedHashes.length !== expectedBlobCount || signedHashes.length !== expectedBlobCount
    || signedHashes.some((hash, index) => hash !== expectedHashes[index])) {
    throw new Error('Recovered signed transaction blob hashes/count do not match durable intent')
  }
  const exposureWei = transactionExposureWei(transaction, expectedBlobCount)
  if (exposureWei !== positiveWei(intent.reservedCostWei, 'recovered transaction intent reserved exposure')) {
    throw new Error('Recovered signed transaction exposure does not match durable intent')
  }
  return { transaction, publisher: recoveredPublisher, exposureWei }
}

/**
 * @param {Record<string, unknown>} receipt
 * @param {{ expectedBlobCount: number }} options
 */
export function receiptCostWei(receipt, { expectedBlobCount }) {
  const executionWei = nonNegativeWei(receipt?.gasUsed, 'receipt gas used')
    * nonNegativeWei(receipt?.effectiveGasPrice, 'receipt effective gas price')
  const blobs = nonNegativeSafeInteger(expectedBlobCount, 'expected receipt blob count')
  const expectedBlobGasUsed = BigInt(blobs) * BLOB_GAS_PER_BLOB
  const hasBlobGasUsed = receipt?.blobGasUsed != null
  const hasBlobGasPrice = receipt?.blobGasPrice != null
  if (hasBlobGasUsed !== hasBlobGasPrice || (blobs > 0 && !hasBlobGasUsed)) {
    throw new Error('Blob-bearing receipt must include both blobGasUsed and blobGasPrice')
  }
  const blobGasUsed = hasBlobGasUsed ? nonNegativeWei(receipt.blobGasUsed, 'receipt blob gas used') : 0n
  if (blobGasUsed !== expectedBlobGasUsed) {
    throw new Error(`Receipt blob gas used ${blobGasUsed} does not match ${blobs} expected blobs`)
  }
  const blobGasPrice = hasBlobGasPrice ? positiveWei(receipt.blobGasPrice, 'receipt blob gas price') : 0n
  const blobWei = blobGasUsed * blobGasPrice
  return { executionWei, blobWei, totalWei: executionWei + blobWei }
}

export function pendingReservedExposure(submitted = []) {
  let totalWei = 0n
  let unknown = 0
  for (const item of submitted) {
    if (item?.reservedCostWei === undefined || item.reservedCostWei === null || item.reservedCostWei === '') {
      unknown += 1
      continue
    }
    totalWei += nonNegativeWei(item.reservedCostWei, 'pending reservedCostWei')
  }
  return { totalWei, unknown }
}

export function runtimeExposureDecision({
  budgetWei,
  confirmedSpendWei = 0n,
  pendingReservedWei = 0n,
  nextReservedWei = 0n,
}) {
  const confirmed = nonNegativeWei(confirmedSpendWei, 'confirmed spend')
  const pending = nonNegativeWei(pendingReservedWei, 'pending reserved exposure')
  const next = nonNegativeWei(nextReservedWei, 'next reserved exposure')
  if (budgetWei === null || budgetWei === undefined) {
    return { allowed: true, budgetWei: null, confirmedSpendWei: confirmed, pendingReservedWei: pending, nextReservedWei: next, totalExposureWei: confirmed + pending + next }
  }
  const budget = nonNegativeWei(budgetWei, 'runtime budget')
  const totalExposureWei = confirmed + pending + next
  return {
    allowed: totalExposureWei <= budget,
    budgetWei: budget,
    confirmedSpendWei: confirmed,
    pendingReservedWei: pending,
    nextReservedWei: next,
    totalExposureWei,
    remainingWei: budget >= confirmed + pending ? budget - confirmed - pending : 0n,
  }
}

export function assertRuntimeExposureBudget(values) {
  const decision = runtimeExposureDecision(values)
  if (!decision.allowed) {
    throw new Error(
      `Runtime budget would be exceeded: confirmed ${decision.confirmedSpendWei} + pending ${decision.pendingReservedWei} + next ${decision.nextReservedWei} = ${decision.totalExposureWei} wei, budget ${decision.budgetWei} wei`,
    )
  }
  return decision
}

export function validateSubmissionJournal(journal, journalPath = 'submission journal') {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) throw new Error(`Invalid ${journalPath}: expected an object`)
  if (journal.version !== 2) throw new Error(`Invalid ${journalPath}: unsupported version`)
  if (typeof journal.chain !== 'string' || !journal.chain) throw new Error(`Invalid ${journalPath}: chain is required`)
  if (!addressHex.test(String(journal.publisher || ''))) throw new Error(`Invalid ${journalPath}: publisher must be an address`)
  if (!addressHex.test(String(journal.destination || ''))) throw new Error(`Invalid ${journalPath}: destination must be an address`)
  if (typeof journal.streamId !== 'string' || !journal.streamId) throw new Error(`Invalid ${journalPath}: streamId is required`)
  if (typeof journal.input !== 'string' || !journal.input) throw new Error(`Invalid ${journalPath}: input is required`)
  nonNegativeSafeInteger(journal.sequence, `${journalPath} sequence`)
  nonNegativeSafeInteger(journal.nonce, `${journalPath} nonce`)
  nonNegativeSafeInteger(journal.payloadBytes, `${journalPath} payloadBytes`)
  const blobCount = nonNegativeSafeInteger(journal.blobCount, `${journalPath} blobCount`)
  if (!Array.isArray(journal.blobVersionedHashes) || journal.blobVersionedHashes.length !== blobCount
    || journal.blobVersionedHashes.some((hash) => !bytes32Hex.test(String(hash)))) {
    throw new Error(`Invalid ${journalPath}: blobVersionedHashes must contain exactly blobCount bytes32 values`)
  }
  if (!bytes32Hex.test(String(journal.payloadSha256 || ''))) throw new Error(`Invalid ${journalPath}: payloadSha256 must be bytes32`)
  if (!bytes32Hex.test(String(journal.previousSegmentHash || ''))) throw new Error(`Invalid ${journalPath}: previousSegmentHash must be bytes32`)
  if (!bytes32Hex.test(String(journal.txHash || ''))) throw new Error(`Invalid ${journalPath}: txHash must be a transaction hash`)
  const serialized = String(journal.serializedTransaction || '')
  if (!serializedTransactionHex.test(serialized) || serialized.length > 32 * 1024 * 1024) {
    throw new Error(`Invalid ${journalPath}: serializedTransaction must be bounded hex`)
  }
  positiveWei(journal.reservedCostWei, `${journalPath} reservedCostWei`)
  if (!['prepared', 'broadcast', 'confirmed'].includes(journal.status)) throw new Error(`Invalid ${journalPath}: unsupported status`)
  if (journal.actualCostWei !== undefined) nonNegativeWei(journal.actualCostWei, `${journalPath} actualCostWei`)
  return journal
}

export function readSubmissionJournal(journalPath) {
  if (!fs.existsSync(journalPath)) return null
  let journal
  try {
    journal = readBoundedJsonFileSync(journalPath, {
      maxBytes: 16 * 1024 * 1024,
      label: `submission journal ${journalPath}`,
    })
  } catch (error) {
    throw new Error(`Unreadable submission journal ${journalPath}: ${error.message}`, { cause: error })
  }
  return validateSubmissionJournal(journal, journalPath)
}

export function writeSubmissionJournal(journalPath, journal) {
  validateSubmissionJournal(journal, journalPath)
  atomicWriteJson(journalPath, journal)
}

export function removeSubmissionJournal(journalPath) {
  fs.rmSync(journalPath, { force: true })
}
