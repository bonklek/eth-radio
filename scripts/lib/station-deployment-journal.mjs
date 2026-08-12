import fs from 'node:fs'
import path from 'node:path'
import {
  isAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem'
import { readBoundedJsonFileSync } from './bounded-files.mjs'
import {
  atomicWriteJson,
  signedTransactionHash,
  transactionExposureWei,
} from './publisher-safety.mjs'

const MAX_DEPLOYMENT_JOURNAL_BYTES = 16 * 1024 * 1024
const transactionHex = /^0x[0-9a-fA-F]+$/
const bytes32Hex = /^0x[0-9a-fA-F]{64}$/

function safeChainName(value) {
  const text = String(value || '')
  if (!/^[a-z0-9_-]+$/i.test(text)) throw new Error('Deployment journal chain name is invalid')
  return text
}

function positiveDecimal(value, label) {
  const text = String(value ?? '')
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${label} must be a positive decimal integer`)
  return BigInt(text)
}

function nonNegativeInteger(value, label) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return number
}

export function stationDeploymentJournalPath(chainName, root = process.cwd()) {
  const chain = safeChainName(chainName)
  return path.resolve(root, 'work', 'blob-radio-testnet', 'contracts', `Station.${chain}.submission.json`)
}

export function validateStationDeploymentJournal(journal, label = 'Station deployment journal') {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) throw new Error(`${label} must be an object`)
  if (journal.version !== 1 || journal.kind !== 'station-deployment') throw new Error(`${label} has an unsupported format`)
  safeChainName(journal.chain)
  positiveDecimal(journal.chainId, `${label} chainId`)
  if (!isAddress(journal.publisher)) throw new Error(`${label} publisher must be an address`)
  if (!bytes32Hex.test(String(journal.bytecodeHash || ''))) throw new Error(`${label} bytecodeHash must be bytes32`)
  if (!bytes32Hex.test(String(journal.txHash || ''))) throw new Error(`${label} txHash must be bytes32`)
  const serialized = String(journal.serializedTransaction || '')
  if (!transactionHex.test(serialized) || serialized.length > MAX_DEPLOYMENT_JOURNAL_BYTES * 2) {
    throw new Error(`${label} serialized transaction is invalid or oversized`)
  }
  positiveDecimal(journal.reservedCostWei, `${label} reservedCostWei`)
  nonNegativeInteger(journal.nonce, `${label} nonce`)
  if (!['prepared', 'broadcast', 'confirmed'].includes(journal.status)) throw new Error(`${label} status is invalid`)
  if (journal.contractAddress != null && !isAddress(journal.contractAddress)) throw new Error(`${label} contractAddress is invalid`)
  return journal
}

export function readStationDeploymentJournal(journalPath) {
  if (!fs.existsSync(journalPath)) return null
  return validateStationDeploymentJournal(readBoundedJsonFileSync(journalPath, {
    maxBytes: MAX_DEPLOYMENT_JOURNAL_BYTES,
    label: `Station deployment journal ${journalPath}`,
  }), journalPath)
}

export function writeStationDeploymentJournal(journalPath, journal) {
  validateStationDeploymentJournal(journal, journalPath)
  atomicWriteJson(journalPath, journal)
}

export function removeStationDeploymentJournal(journalPath) {
  fs.rmSync(journalPath, { force: true })
}

export function makeStationDeploymentJournal({
  chain,
  chainId,
  publisher,
  bytecode,
  serializedTransaction,
  reservedCostWei,
  nonce,
}) {
  return validateStationDeploymentJournal({
    version: 1,
    kind: 'station-deployment',
    status: 'prepared',
    chain,
    chainId: String(chainId),
    publisher,
    bytecodeHash: keccak256(bytecode),
    txHash: signedTransactionHash(serializedTransaction),
    serializedTransaction,
    reservedCostWei: String(reservedCostWei),
    nonce,
    preparedAt: new Date().toISOString(),
  })
}

export async function assertStationDeploymentJournalIntent(journal, {
  chain,
  chainId,
  publisher,
  bytecode,
}) {
  validateStationDeploymentJournal(journal)
  if (journal.chain !== chain || BigInt(journal.chainId) !== BigInt(chainId)) throw new Error('Deployment journal chain does not match')
  if (journal.publisher.toLowerCase() !== publisher.toLowerCase()) throw new Error('Deployment journal publisher does not match')
  if (journal.bytecodeHash.toLowerCase() !== keccak256(bytecode).toLowerCase()) throw new Error('Deployment journal bytecode does not match')
  if (signedTransactionHash(journal.serializedTransaction).toLowerCase() !== journal.txHash.toLowerCase()) {
    throw new Error('Deployment journal transaction hash does not match its signed transaction')
  }
  const transaction = parseTransaction(journal.serializedTransaction)
  if (transaction.to != null) throw new Error('Deployment journal transaction is not contract creation')
  if (BigInt(transaction.chainId ?? 0) !== BigInt(chainId)) throw new Error('Deployment journal signed transaction chain does not match')
  if (keccak256(transaction.data || '0x').toLowerCase() !== journal.bytecodeHash.toLowerCase()) {
    throw new Error('Deployment journal signed transaction bytecode does not match')
  }
  const recoveredPublisher = await recoverTransactionAddress({ serializedTransaction: journal.serializedTransaction })
  if (recoveredPublisher.toLowerCase() !== publisher.toLowerCase()) throw new Error('Deployment journal signer does not match publisher')
  if (Number(transaction.nonce) !== Number(journal.nonce)) throw new Error('Deployment journal nonce does not match signed transaction')
  const exposureWei = transactionExposureWei(transaction, 0)
  if (exposureWei !== BigInt(journal.reservedCostWei)) throw new Error('Deployment journal exposure does not match signed transaction')
  return { transaction, exposureWei }
}
