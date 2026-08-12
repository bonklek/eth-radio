import assert from 'node:assert/strict'
import { loadKZG } from 'kzg-wasm'
import { bytesToHex, hexToBytes, toBlobs } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { signedTransactionHash } from '../../../scripts/lib/publisher-safety.mjs'
import {
  ceilPercent,
  canonicalReceiptCostTransition,
  finalizedTagDecision,
  signerLiquidityDecision,
  lineageHealth,
  lineageReservedExposure,
  nextReplacementFees,
  pendingReservedExposure,
  reconcileAttemptReceipts,
  replacementBudgetDecision,
  replacementEligibility,
  startupNonceDecision,
} from '../lib/transaction-continuity.mjs'

const hash = (digit) => `0x${digit.repeat(64)}`
const attempt = (index, reservedCostWei, preparedAt = '2026-01-01T00:00:00.000Z') => ({
  index,
  txHash: hash(String(index + 1)),
  reservedCostWei: String(reservedCostWei),
  preparedAt,
  broadcastAt: preparedAt,
})
const item = {
  status: 'pending',
  attempts: [attempt(0, 100), attempt(1, 140)],
}

assert.equal(ceilPercent(100n, 15), 115n)
assert.equal(ceilPercent(101n, 10), 112n)
assert.equal(lineageReservedExposure(item), 140n, 'siblings with one nonce reserve only the maximum exposure')
assert.equal(pendingReservedExposure([item, { attempts: [attempt(0, 70)] }]), 210n)
assert.equal(lineageReservedExposure({
  reservations: [{ reservedExposureWei: '160' }],
  attempts: [attempt(0, 100)],
}), 160n, 'durable unsigned reservation exposure must count before a signed attempt exists')
assert.deepEqual(startupNonceDecision({ persistedNextNonce: null, observedPendingNonces: [7, 8] }), {
  allowed: true, nextNonce: 8, disposition: 'initialized',
})
assert.deepEqual(startupNonceDecision({ persistedNextNonce: 7, observedPendingNonces: [9], pendingItems: [] }), {
  allowed: true, nextNonce: 9, disposition: 'advanced-external',
})
assert.equal(startupNonceDecision({ persistedNextNonce: 9, observedPendingNonces: [8], pendingItems: [] }).allowed, false)
assert.deepEqual(startupNonceDecision({
  persistedNextNonce: 9,
  observedPendingNonces: [8],
  pendingItems: [{ nonce: 8 }],
}), { allowed: true, nextNonce: 9, disposition: 'lineages-pending' })
assert.equal(startupNonceDecision({
  persistedNextNonce: 9,
  observedPendingNonces: [10],
  pendingItems: [{ nonce: 8 }],
}).allowed, false)
assert.deepEqual(canonicalReceiptCostTransition({
  totalSpendWei: '100', observedCostWei: '20', canonical: true,
}), { totalSpendWei: 120n, recordedCostWei: 20n, deltaWei: 20n })
assert.deepEqual(canonicalReceiptCostTransition({
  totalSpendWei: '120', recordedCostWei: '20', observedCostWei: '20', canonical: true,
}), { totalSpendWei: 120n, recordedCostWei: 20n, deltaWei: 0n })
assert.deepEqual(canonicalReceiptCostTransition({
  totalSpendWei: '120', recordedCostWei: '20', canonical: false,
}), { totalSpendWei: 100n, recordedCostWei: null, deltaWei: -20n })
assert.throws(() => canonicalReceiptCostTransition({
  totalSpendWei: '120', recordedCostWei: '20', observedCostWei: '21', canonical: true,
}), /cost changed/)
const finalityMatch = {
  provider: 'RPC 1',
  finalizedHeadNumber: '200',
  finalizedHeadHash: hash('a'),
  observedBlockHash: hash('b'),
}
assert.equal(finalizedTagDecision({ expectedBlockHash: hash('b'), observations: [finalityMatch] }).status, 'finalized-tag-observed')
assert.equal(finalizedTagDecision({
  expectedBlockHash: hash('b'),
  observations: [finalityMatch, { ...finalityMatch, provider: 'RPC 2', observedBlockHash: hash('c') }],
}).status, 'provider-disagreement')
assert.equal(finalizedTagDecision({ expectedBlockHash: hash('b'), observations: [] }).status, 'pending')
assert.equal(signerLiquidityDecision({ observations: [], requiredWei: '10' }).allowed, false)
assert.deepEqual(signerLiquidityDecision({
  observations: [{ provider: 'RPC 1', balanceWei: '10' }],
  requiredWei: '10',
}), {
  allowed: true,
  reason: null,
  requiredWei: 10n,
  minimumBalanceWei: 10n,
  maximumBalanceWei: 10n,
  disagreement: false,
  observations: [{ provider: 'RPC 1', balanceWei: 10n }],
})
const liquidityDisagreement = signerLiquidityDecision({
  observations: [
    { provider: 'RPC 1', balanceWei: '9' },
    { provider: 'RPC 2', balanceWei: '100' },
  ],
  requiredWei: '10',
})
assert.equal(liquidityDisagreement.allowed, false)
assert.equal(liquidityDisagreement.disagreement, true)
assert.equal(liquidityDisagreement.minimumBalanceWei, 9n)

const fees = nextReplacementFees({
  current: { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n, maxFeePerBlobGas: 20n },
  suggested: { maxFeePerGas: 105n, maxPriorityFeePerGas: 11n },
  baseFeePerGas: 60n,
  blobBaseFee: 15n,
  bumpPercent: 15,
  ceilings: { maxFeePerGas: 200n, maxPriorityFeePerGas: 50n, maxFeePerBlobGas: 100n },
})
assert.equal(fees.allowed, true)
assert.deepEqual(fees.fees, { maxFeePerGas: 132n, maxPriorityFeePerGas: 12n, maxFeePerBlobGas: 30n })
assert.match(nextReplacementFees({
  current: { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n, maxFeePerBlobGas: 20n },
  suggested: {},
  bumpPercent: 15,
  ceilings: { maxFeePerGas: 110n },
}).reason, /execution fee/)

const budgetAllowed = replacementBudgetDecision({
  item,
  nextReservedCostWei: 160n,
  pendingItems: [item, { attempts: [attempt(0, 40)] }],
  actualSpendWei: 200n,
  streamBudgetWei: 500n,
  segmentBudgetWei: 200n,
})
assert.equal(budgetAllowed.allowed, true)
assert.equal(budgetAllowed.totalExposureWei, 400n)
assert.match(replacementBudgetDecision({
  item,
  nextReservedCostWei: 210n,
  pendingItems: [item],
  actualSpendWei: 0n,
  streamBudgetWei: 500n,
  segmentBudgetWei: 200n,
}).reason, /per-segment budget/)
assert.match(replacementBudgetDecision({
  item,
  nextReservedCostWei: 180n,
  pendingItems: [item, { attempts: [attempt(0, 200)] }],
  actualSpendWei: 150n,
  streamBudgetWei: 500n,
  segmentBudgetWei: 300n,
}).reason, /stream budget/)

const now = Date.parse('2026-01-01T00:01:00.000Z')
assert.equal(replacementEligibility(item, { now, replaceAfterMs: 30_000, maxReplacements: 3 }).eligible, true)
assert.equal(replacementEligibility(item, { now, replaceAfterMs: 90_000, maxReplacements: 3 }).eligible, false)
assert.equal(replacementEligibility(item, { now, replaceAfterMs: 30_000, maxReplacements: 1 }).exhausted, true)
assert.equal(lineageHealth(item, { now, replaceAfterMs: 30_000, maxReplacements: 3 }), 'stale')

const oldReceipt = { status: 'success', blockNumber: 100n, blockHash: hash('a') }
const replacementReceipt = { status: 'success', blockNumber: 101n, blockHash: hash('b') }
const oldWins = reconcileAttemptReceipts(item, {
  receiptsByHash: { [item.attempts[0].txHash]: oldReceipt },
  canonicalBlockHashes: { '100': oldReceipt.blockHash },
  headBlockNumber: 102n,
  confirmationDepth: 2,
})
assert.equal(oldWins.status, 'operationally-confirmed')
assert.equal(oldWins.winnerHash, item.attempts[0].txHash)

const replacementWins = reconcileAttemptReceipts(item, {
  receiptsByHash: { [item.attempts[1].txHash]: replacementReceipt },
  canonicalBlockHashes: { '101': replacementReceipt.blockHash },
  headBlockNumber: 101n,
  confirmationDepth: 2,
})
assert.equal(replacementWins.status, 'confirming')
assert.equal(replacementWins.winnerHash, item.attempts[1].txHash)
assert.equal(replacementWins.confirmations, 1)

assert.equal(reconcileAttemptReceipts(
  { ...item, winnerHash: item.attempts[1].txHash },
  { receiptsByHash: {}, canonicalBlockHashes: {}, headBlockNumber: 102n, confirmationDepth: 2 },
).status, 'reorged')
assert.equal(reconcileAttemptReceipts(item, {
  receiptsByHash: { [item.attempts[0].txHash]: oldReceipt },
  canonicalBlockHashes: { '100': hash('c') },
  headBlockNumber: 102n,
  confirmationDepth: 2,
}).status, 'reorged')
assert.equal(reconcileAttemptReceipts(item, {
  receiptsByHash: { [item.attempts[0].txHash]: { ...oldReceipt, status: 'reverted' } },
  canonicalBlockHashes: { '100': oldReceipt.blockHash },
  headBlockNumber: 102n,
  confirmationDepth: 2,
}).status, 'failed')
assert.equal(reconcileAttemptReceipts(item, {
  receiptsByHash: { [item.attempts[0].txHash]: { ...oldReceipt, status: 'reverted' } },
  canonicalBlockHashes: { '100': hash('c') },
  headBlockNumber: 102n,
  confirmationDepth: 2,
}).status, 'reorged')

const wasmKzg = await loadKZG()
const kzg = {
  blobToKzgCommitment(blob) { return hexToBytes(wasmKzg.blobToKzgCommitment(bytesToHex(blob))) },
  computeBlobKzgProof(blob, commitment) { return hexToBytes(wasmKzg.computeBlobKZGProof(bytesToHex(blob), bytesToHex(commitment))) },
}
const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`)
const blobs = toBlobs({ data: bytesToHex(Buffer.from('rfe replacement signing fixture')) })
const baseTransaction = {
  type: 'eip4844',
  chainId: 11155111,
  nonce: 7,
  gas: 180000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerBlobGas: 2_000_000_000n,
  to: '0x1111111111111111111111111111111111111111',
  data: '0x1234',
  value: 0n,
  blobs,
  kzg,
}
const originalSigned = await account.signTransaction(baseTransaction)
const replacementSigned = await account.signTransaction({
  ...baseTransaction,
  maxFeePerGas: 2_300_000_000n,
  maxPriorityFeePerGas: 1_150_000_000n,
  maxFeePerBlobGas: 2_300_000_000n,
})
assert.notEqual(signedTransactionHash(originalSigned), signedTransactionHash(replacementSigned))
assert.equal(originalSigned.slice(0, 4), '0x03')
assert.equal(replacementSigned.slice(0, 4), '0x03')

console.log('transaction continuity policy tests ok')
