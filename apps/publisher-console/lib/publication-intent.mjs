import crypto from 'node:crypto'
import { parseTransaction, recoverTransactionAddress } from 'viem'
import { canonicalJson } from './arm-consent.mjs'

const hex = /^0x[0-9a-fA-F]*$/
const hash32 = /^0x[0-9a-fA-F]{64}$/
const address = /^0x[0-9a-fA-F]{40}$/

function lowerHex(value, label, pattern = hex) {
  const result = String(value ?? '')
  if (!pattern.test(result)) throw new Error(`${label} is invalid hex`)
  return result.toLowerCase()
}

function uint(value, label) {
  const result = BigInt(value)
  if (result < 0n) throw new Error(`${label} must be non-negative`)
  return result.toString()
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function dataDigest(data) {
  return digest(lowerHex(data || '0x', 'transaction data'))
}

export function publicationIntentFromPrepared(prepared, {
  publisher,
  reservedExposureWei,
  payloadSha256,
  blobCount,
}) {
  const hashes = [...(prepared.blobVersionedHashes || [])].map((value, index) => lowerHex(value, `blobVersionedHashes[${index}]`, hash32))
  if (hashes.length !== Number(blobCount)) throw new Error('prepared blob versioned hashes do not match blobCount')
  const intent = {
    schema: 'rfe/publication-intent@1',
    publisher: lowerHex(publisher, 'publisher', address),
    chainId: Number(prepared.chainId),
    type: 'eip4844',
    to: lowerHex(prepared.to, 'destination', address),
    nonce: Number(prepared.nonce),
    gas: uint(prepared.gas, 'gas'),
    value: uint(prepared.value || 0n, 'value'),
    dataSha256: dataDigest(prepared.data),
    maxFeePerGas: uint(prepared.maxFeePerGas, 'maxFeePerGas'),
    maxPriorityFeePerGas: uint(prepared.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
    maxFeePerBlobGas: uint(prepared.maxFeePerBlobGas, 'maxFeePerBlobGas'),
    blobVersionedHashes: hashes,
    blobCount: Number(blobCount),
    payloadSha256: lowerHex(`0x${String(payloadSha256).replace(/^0x/, '')}`, 'payloadSha256', hash32),
    reservedExposureWei: uint(reservedExposureWei, 'reservedExposureWei'),
  }
  if (!Number.isSafeInteger(intent.chainId) || intent.chainId <= 0) throw new Error('chainId must be a positive safe integer')
  if (!Number.isSafeInteger(intent.nonce) || intent.nonce < 0) throw new Error('nonce must be a non-negative safe integer')
  if (!Number.isSafeInteger(intent.blobCount) || intent.blobCount < 1 || intent.blobCount > 6) throw new Error('blobCount must be from 1 to 6')
  return { ...intent, intentDigest: digest(canonicalJson(intent)) }
}

function equal(actual, expected, label) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) throw new Error(`signed transaction ${label} does not match reserved intent`)
}

export async function verifySignedPublicationIntent(serializedTransaction, reservation) {
  const parsed = parseTransaction(serializedTransaction)
  equal(parsed.chainId, reservation.chainId, 'chainId')
  equal(parsed.to, reservation.to, 'destination')
  equal(parsed.nonce, reservation.nonce, 'nonce')
  equal(parsed.gas, reservation.gas, 'gas')
  equal(parsed.value || 0n, reservation.value, 'value')
  equal(dataDigest(parsed.data), reservation.dataSha256, 'calldata')
  equal(parsed.maxFeePerGas, reservation.maxFeePerGas, 'maxFeePerGas')
  equal(parsed.maxPriorityFeePerGas, reservation.maxPriorityFeePerGas, 'maxPriorityFeePerGas')
  equal(parsed.maxFeePerBlobGas, reservation.maxFeePerBlobGas, 'maxFeePerBlobGas')
  const actualHashes = [...(parsed.blobVersionedHashes || [])].map((value) => value.toLowerCase())
  if (canonicalJson(actualHashes) !== canonicalJson(reservation.blobVersionedHashes)) {
    throw new Error('signed transaction blobVersionedHashes do not match reserved intent')
  }
  const recovered = await recoverTransactionAddress({ serializedTransaction })
  equal(recovered, reservation.publisher, 'publisher')
  const { intentDigest, index: _index, reservedAt: _reservedAt, ...intent } = reservation
  equal(digest(canonicalJson(intent)), intentDigest, 'intent digest')
  return parsed
}
