const decimal = /^\d+$/

function wei(value, label) {
  const text = String(value ?? '')
  if (!decimal.test(text)) throw new Error(`${label} must be a non-negative integer`)
  return BigInt(text)
}

function positiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`)
  return number
}

export function ceilPercent(value, percent) {
  const amount = wei(value, 'fee')
  const rate = positiveInteger(percent, 'bump percent')
  return (amount * BigInt(100 + rate) + 99n) / 100n
}

function boundedFee({ current, suggested = 0n, baseRequirement = 0n, percent, ceiling, label }) {
  const bumped = ceilPercent(current, percent)
  const next = [bumped, BigInt(suggested), BigInt(baseRequirement)].reduce((max, value) => value > max ? value : max, 0n)
  const cap = ceiling === null || ceiling === undefined || ceiling === '' ? null : wei(ceiling, `${label} ceiling`)
  if (cap !== null && next > cap) {
    return { allowed: false, value: next, ceiling: cap, reason: `${label} requires ${next} wei but its ceiling is ${cap} wei` }
  }
  return { allowed: true, value: next, ceiling: cap }
}

export function nextReplacementFees({
  current,
  suggested,
  baseFeePerGas = 0n,
  blobBaseFee = 0n,
  bumpPercent,
  ceilings = {},
}) {
  const priority = boundedFee({
    current: current.maxPriorityFeePerGas,
    suggested: suggested?.maxPriorityFeePerGas || 0n,
    percent: bumpPercent,
    ceiling: ceilings.maxPriorityFeePerGas,
    label: 'priority fee',
  })
  if (!priority.allowed) return priority
  const execution = boundedFee({
    current: current.maxFeePerGas,
    suggested: suggested?.maxFeePerGas || 0n,
    baseRequirement: BigInt(baseFeePerGas) * 2n + priority.value,
    percent: bumpPercent,
    ceiling: ceilings.maxFeePerGas,
    label: 'execution fee',
  })
  if (!execution.allowed) return execution
  const blob = boundedFee({
    current: current.maxFeePerBlobGas,
    suggested: suggested?.maxFeePerBlobGas || 0n,
    baseRequirement: BigInt(blobBaseFee) * 2n,
    percent: bumpPercent,
    ceiling: ceilings.maxFeePerBlobGas,
    label: 'blob fee',
  })
  if (!blob.allowed) return blob
  return {
    allowed: true,
    fees: {
      maxPriorityFeePerGas: priority.value,
      maxFeePerGas: execution.value,
      maxFeePerBlobGas: blob.value,
    },
  }
}

export function lineageReservedExposure(item) {
  const exposures = [
    ...(Array.isArray(item?.reservations) ? item.reservations.map((reservation) => reservation.reservedExposureWei) : []),
    ...(Array.isArray(item?.attempts) ? item.attempts.map((attempt) => attempt.reservedCostWei) : []),
  ]
  return exposures.reduce((max, value) => {
    const exposure = wei(value, 'lineage reserved cost')
    return exposure > max ? exposure : max
  }, 0n)
}

export function pendingReservedExposure(items) {
  return (items || []).reduce((total, item) => total + lineageReservedExposure(item), 0n)
}

export function startupNonceDecision({ persistedNextNonce, pendingItems = [], observedPendingNonces }) {
  const observed = (observedPendingNonces || []).map((value) => {
    const nonce = Number(value)
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('observed pending nonce must be a non-negative safe integer')
    return nonce
  })
  if (!observed.length) return { allowed: false, reason: 'no execution endpoint supplied a pending nonce' }
  const networkNextNonce = Math.max(...observed)
  if (persistedNextNonce === null || persistedNextNonce === undefined) {
    return { allowed: true, nextNonce: networkNextNonce, disposition: 'initialized' }
  }
  const persisted = Number(persistedNextNonce)
  if (!Number.isSafeInteger(persisted) || persisted < 0) throw new Error('persisted next nonce must be a non-negative safe integer')
  const items = pendingItems || []
  if (!items.length) {
    if (networkNextNonce < persisted) {
      return { allowed: false, reason: `network pending nonce ${networkNextNonce} is behind persisted next nonce ${persisted}` }
    }
    return {
      allowed: true,
      nextNonce: networkNextNonce,
      disposition: networkNextNonce > persisted ? 'advanced-external' : 'unchanged',
    }
  }
  const lowest = Math.min(...items.map((item) => Number(item.nonce)))
  if (!Number.isSafeInteger(lowest) || lowest < 0) throw new Error('pending lineage nonce is invalid')
  if (networkNextNonce < lowest || networkNextNonce > persisted) {
    return {
      allowed: false,
      reason: `network pending nonce ${networkNextNonce} is outside durable lineage range ${lowest}..${persisted}`,
    }
  }
  return { allowed: true, nextNonce: persisted, disposition: 'lineages-pending' }
}

export function canonicalReceiptCostTransition({
  totalSpendWei,
  recordedCostWei = null,
  observedCostWei = null,
  canonical,
}) {
  const total = wei(totalSpendWei, 'total spend')
  const recorded = recordedCostWei === null || recordedCostWei === undefined
    ? null
    : wei(recordedCostWei, 'recorded receipt cost')
  if (canonical) {
    const observed = wei(observedCostWei, 'observed receipt cost')
    if (recorded !== null && recorded !== observed) throw new Error('canonical receipt cost changed after accounting')
    return {
      totalSpendWei: recorded === null ? total + observed : total,
      recordedCostWei: observed,
      deltaWei: recorded === null ? observed : 0n,
    }
  }
  if (recorded === null) return { totalSpendWei: total, recordedCostWei: null, deltaWei: 0n }
  if (recorded > total) throw new Error('recorded receipt cost exceeds total spend')
  return { totalSpendWei: total - recorded, recordedCostWei: null, deltaWei: -recorded }
}

export function finalizedTagDecision({ expectedBlockHash, observations = [] }) {
  const expected = String(expectedBlockHash || '').toLowerCase()
  const matches = []
  const conflicts = []
  for (const observation of observations) {
    if (!observation?.observedBlockHash) continue
    const { observedBlockHash, ...evidence } = observation
    if (String(observedBlockHash).toLowerCase() === expected) matches.push(evidence)
    else conflicts.push({ ...evidence, observedBlockHash })
  }
  if (conflicts.length) return { status: 'provider-disagreement', matches, conflicts }
  if (matches.length) return { status: 'finalized-tag-observed', matches, conflicts: [] }
  return { status: 'pending', matches: [], conflicts: [] }
}

export function signerLiquidityDecision({ observations = [], requiredWei }) {
  const required = wei(requiredWei, 'required liquidity')
  const balances = observations.map((observation) => ({
    provider: String(observation.provider),
    balanceWei: wei(observation.balanceWei, 'observed pending balance'),
  }))
  if (!balances.length) return { allowed: false, reason: 'no provider supplied pending balance evidence', requiredWei: required }
  const values = balances.map((item) => item.balanceWei)
  const minimumBalanceWei = values.reduce((minimum, value) => value < minimum ? value : minimum)
  const maximumBalanceWei = values.reduce((maximum, value) => value > maximum ? value : maximum)
  return {
    allowed: minimumBalanceWei >= required,
    reason: minimumBalanceWei >= required
      ? null
      : `minimum observed pending balance ${minimumBalanceWei} wei is below required pending exposure ${required} wei`,
    requiredWei: required,
    minimumBalanceWei,
    maximumBalanceWei,
    disagreement: minimumBalanceWei !== maximumBalanceWei,
    observations: balances,
  }
}

export function replacementBudgetDecision({
  item,
  nextReservedCostWei,
  pendingItems,
  actualSpendWei,
  streamBudgetWei,
  segmentBudgetWei,
}) {
  const next = wei(nextReservedCostWei, 'replacement reserved cost')
  const segmentBudget = wei(segmentBudgetWei, 'segment budget')
  if (next > segmentBudget) {
    return { allowed: false, reason: `replacement exposure ${next} wei exceeds per-segment budget ${segmentBudget} wei` }
  }
  const currentItem = lineageReservedExposure(item)
  const currentPending = pendingReservedExposure(pendingItems)
  const proposedPending = currentPending - currentItem + (next > currentItem ? next : currentItem)
  const confirmed = wei(actualSpendWei, 'actual spend')
  const streamBudget = wei(streamBudgetWei, 'stream budget')
  const totalExposureWei = confirmed + proposedPending
  if (totalExposureWei > streamBudget) {
    return { allowed: false, reason: `replacement would raise total exposure to ${totalExposureWei} wei above stream budget ${streamBudget} wei`, totalExposureWei }
  }
  return { allowed: true, totalExposureWei, proposedPendingWei: proposedPending }
}

export function attemptAgeMs(item, now = Date.now()) {
  const latest = item?.attempts?.at(-1)
  const timestamp = Date.parse(latest?.broadcastAt || latest?.preparedAt || '')
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : 0
}

export function replacementEligibility(item, { now = Date.now(), replaceAfterMs, maxReplacements }) {
  if (!item || !['prepared', 'pending', 'replacing'].includes(item.status)) return { eligible: false, reason: 'lineage is not pending' }
  const attempts = Array.isArray(item.attempts) ? item.attempts : []
  if (!attempts.length) return { eligible: false, reason: 'lineage has no durable attempt' }
  const replacements = Math.max(0, attempts.length - 1)
  if (replacements >= maxReplacements) return { eligible: false, exhausted: true, reason: `maximum ${maxReplacements} replacement(s) reached` }
  const ageMs = attemptAgeMs(item, now)
  if (ageMs < replaceAfterMs) return { eligible: false, ageMs, remainingMs: replaceAfterMs - ageMs, reason: 'replacement timer has not elapsed' }
  return { eligible: true, ageMs, replacements }
}

function receiptFor(receiptsByHash, hash) {
  if (receiptsByHash instanceof Map) return receiptsByHash.get(hash) || null
  return receiptsByHash?.[hash] || null
}

function canonicalHashFor(canonicalBlockHashes, blockNumber) {
  const key = String(blockNumber)
  if (canonicalBlockHashes instanceof Map) return canonicalBlockHashes.get(key) || canonicalBlockHashes.get(BigInt(blockNumber)) || null
  return canonicalBlockHashes?.[key] || null
}

export function reconcileAttemptReceipts(item, {
  receiptsByHash = {},
  canonicalBlockHashes = {},
  headBlockNumber,
  confirmationDepth,
}) {
  const attempts = item?.attempts || []
  const receipts = attempts
    .map((attempt) => ({ attempt, receipt: receiptFor(receiptsByHash, attempt.txHash) }))
    .filter((entry) => entry.receipt)
  if (!receipts.length) {
    if (item?.winnerHash) return { status: 'reorged', winnerHash: null, reason: 'winning receipt disappeared before finalization' }
    return { status: 'pending', winnerHash: null }
  }
  for (const { receipt } of receipts) {
    const canonicalHash = canonicalHashFor(canonicalBlockHashes, receipt.blockNumber)
    if (canonicalHash && String(canonicalHash).toLowerCase() !== String(receipt.blockHash).toLowerCase()) {
      return { status: 'reorged', winnerHash: null, reason: 'receipt block is no longer canonical' }
    }
  }
  const failed = receipts.find(({ receipt }) => receipt.status !== 'success')
  if (failed) return { status: 'failed', winnerHash: failed.attempt.txHash, receipt: failed.receipt, reason: 'nonce was consumed by a reverted attempt' }
  receipts.sort((left, right) => Number(left.attempt.index) - Number(right.attempt.index))
  const winner = receipts[0]
  const depth = positiveInteger(confirmationDepth, 'confirmation depth')
  const confirmations = BigInt(headBlockNumber) - BigInt(winner.receipt.blockNumber) + 1n
  if (confirmations < BigInt(depth)) {
    return {
      status: 'confirming',
      winnerHash: winner.attempt.txHash,
      receipt: winner.receipt,
      confirmations: Number(confirmations < 0n ? 0n : confirmations),
      requiredConfirmations: depth,
    }
  }
  return {
    status: 'operationally-confirmed',
    winnerHash: winner.attempt.txHash,
    receipt: winner.receipt,
    confirmations: Number(confirmations),
    requiredConfirmations: depth,
  }
}

export function lineageHealth(item, { now = Date.now(), replaceAfterMs, maxReplacements } = {}) {
  if (!item) return 'idle'
  if (item.status === 'blocked' || item.status === 'failed') return item.status
  if (item.status === 'confirming') return 'confirming'
  if (item.status === 'replacing') return 'replacing'
  const eligibility = replacementEligibility(item, { now, replaceAfterMs, maxReplacements })
  if (eligibility.exhausted) return 'replacement-exhausted'
  if (eligibility.eligible) return 'stale'
  return 'pending'
}

export function serializeBigints(value) {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
}
