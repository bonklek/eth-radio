import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { keccak256, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { makePublisherState, readPublisherState } from './lib/publisher-state.mjs'
import { acquireAccountLease } from './lib/account-lease.mjs'
import {
  atomicWriteJson,
  assertRecoveredSignedTransactionIntent,
  assertRuntimeExposureBudget,
  assertTransactionExposureCeiling,
  defaultSubmissionJournalPath,
  maybeInjectPublisherFault,
  parseExposureCeilingEth,
  pendingReservedExposure,
  readSubmissionJournal,
  receiptCostWei,
  runtimeExposureDecision,
  savePublisherStateAtomic,
  signedTransactionHash,
  transactionExposureWei,
  writeSubmissionJournal,
} from './lib/publisher-safety.mjs'
import {
  assertStationDeploymentJournalIntent,
  makeStationDeploymentJournal,
  readStationDeploymentJournal,
  writeStationDeploymentJournal,
} from './lib/station-deployment-journal.mjs'

const mode = process.argv[2]
const childPath = process.argv[3]
const txHash = `0x${'11'.repeat(32)}`
const payloadHash = `0x${'22'.repeat(32)}`

if (mode === 'atomic-child') {
  savePublisherStateAtomic(childPath, { generation: 'new' })
  process.exit(0)
}

if (mode === 'serial-prepared-child') {
  writeSubmissionJournal(childPath, {
    version: 2,
    status: 'prepared',
    chain: 'sepolia',
    publisher: `0x${'33'.repeat(20)}`,
    destination: `0x${'44'.repeat(20)}`,
    streamId: 'fault-stream',
    sequence: 0,
    input: 'segment.webm',
    payloadBytes: 4,
    payloadSha256: payloadHash,
    nonce: 7,
    blobCount: 1,
    blobVersionedHashes: [payloadHash],
    previousSegmentHash: zeroHash,
    txHash,
    serializedTransaction: '0x01',
    reservedCostWei: '99',
    preparedAt: new Date(0).toISOString(),
  })
  maybeInjectPublisherFault('serial-after-prepared')
  process.exit(0)
}

if (mode === 'pipelined-prepared-child') {
  const state = makePublisherState({
    streamId: 'fault-stream',
    startSeq: 0,
    previousSegmentHash: zeroHash,
    submitted: true,
  })
  state.submitted.push({
    sequence: 0,
    nonce: 7,
    txHash,
    blobCount: 1,
    blobVersionedHashes: [payloadHash],
    payloadSha256: payloadHash,
    previousSegmentHash: zeroHash,
    serializedTransaction: '0x01',
    reservedCostWei: '99',
    submissionStatus: 'prepared',
  })
  state.nextSequence = 1
  state.previousSegmentHash = payloadHash
  state.metrics.submittedCount = 1
  state.metrics.reservedPendingWei = '99'
  state.metrics.totalExposureWei = '99'
  savePublisherStateAtomic(childPath, state)
  maybeInjectPublisherFault('pipelined-after-prepared')
  process.exit(0)
}

if (mode === 'deploy-journal-child') {
  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
  const bytecode = '0x60006000f3'
  const serializedTransaction = await account.signTransaction({
    chainId: 11_155_111,
    data: bytecode,
    gas: 100_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    nonce: 4,
    type: 'eip1559',
    value: 0n,
  })
  const journal = makeStationDeploymentJournal({
    chain: 'sepolia',
    chainId: 11_155_111,
    publisher: account.address,
    bytecode,
    serializedTransaction,
    reservedCostWei: 200_000n,
    nonce: 4,
  })
  writeStationDeploymentJournal(childPath, journal)
  maybeInjectPublisherFault('deploy-after-prepared')
  journal.status = 'broadcast'
  journal.broadcastAt = new Date(1).toISOString()
  writeStationDeploymentJournal(childPath, journal)
  maybeInjectPublisherFault('deploy-after-broadcast')
  journal.status = 'confirmed'
  journal.contractAddress = `0x${'77'.repeat(20)}`
  journal.confirmedAt = new Date(2).toISOString()
  writeStationDeploymentJournal(childPath, journal)
  maybeInjectPublisherFault('deploy-after-confirmation')
  atomicWriteJson(`${childPath}.metadata`, { txHash: journal.txHash, address: journal.contractAddress })
  maybeInjectPublisherFault('deploy-after-metadata')
  fs.rmSync(childPath, { force: true })
  process.exit(0)
}

if (mode === 'lease-hold-child') {
  const readyPath = process.argv[4]
  const releasePath = process.argv[5]
  const chainId = process.argv[6]
  const account = process.argv[7]
  const lease = acquireAccountLease({ chainId, account, root: childPath, staleMs: 20, heartbeatMs: 60_000 })
  fs.writeFileSync(readyPath, lease.lockPath)
  while (!fs.existsSync(releasePath)) await new Promise((resolve) => setTimeout(resolve, 5))
  lease.release()
  process.exit(0)
}

if (mode === 'lease-acquire-child') {
  try {
    const lease = acquireAccountLease({
      chainId: process.argv[4],
      account: process.argv[5],
      root: childPath,
      staleMs: Number(process.argv[6] || 20),
      heartbeatMs: 60_000,
    })
    process.stdout.write(`acquired:${lease.token}\n`)
    lease.release()
    process.exit(0)
  } catch (error) {
    process.stderr.write(`${error.code || 'ERROR'}:${error.message}\n`)
    process.exit(73)
  }
}

const root = process.cwd()
const scriptPath = path.join(root, 'scripts', 'test-publisher-safety.mjs')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-publisher-safety-'))
const sanitizedChildEnv = {
  PATH: process.env.PATH || '',
  SystemRoot: process.env.SystemRoot || '',
  TEMP: process.env.TEMP || os.tmpdir(),
  TMP: process.env.TMP || os.tmpdir(),
  DOTENV_CONFIG_PATH: 'NUL',
}

function runChild(childMode, filePath, fault) {
  return spawnSync(process.execPath, [scriptPath, childMode, filePath], {
    cwd: root,
    env: { ...sanitizedChildEnv, ...(fault ? { PUBLISHER_FAULT_INJECT: fault } : {}) },
    encoding: 'utf8',
  })
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

try {
  const exactBoundary = runtimeExposureDecision({
    budgetWei: 100n,
    confirmedSpendWei: 40n,
    pendingReservedWei: 30n,
    nextReservedWei: 30n,
  })
  assert.equal(exactBoundary.allowed, true)
  assert.equal(exactBoundary.totalExposureWei, 100n)
  assert.throws(() => assertRuntimeExposureBudget({
    budgetWei: 100n,
    confirmedSpendWei: 40n,
    pendingReservedWei: 30n,
    nextReservedWei: 31n,
  }), /Runtime budget would be exceeded/)
  assert.throws(() => assertRuntimeExposureBudget({
    budgetWei: 100n,
    confirmedSpendWei: 10n,
    pendingReservedWei: 80n,
    nextReservedWei: 11n,
  }), /Runtime budget would be exceeded/, 'delayed pending receipts must remain fully reserved')
  assert.throws(() => assertRuntimeExposureBudget({
    budgetWei: 100n,
    confirmedSpendWei: 100n,
    pendingReservedWei: 0n,
    nextReservedWei: 1n,
  }), /Runtime budget would be exceeded/, 'zero remaining budget must block before submission')

  const lowerFeeExposure = transactionExposureWei({
    gas: 10n,
    maxFeePerGas: 3n,
    maxFeePerBlobGas: 5n,
  }, 2)
  const increasedFeeExposure = transactionExposureWei({
    gas: 10n,
    maxFeePerGas: 4n,
    maxFeePerBlobGas: 6n,
  }, 2)
  assert.equal(lowerFeeExposure, 10n * 3n + 2n * 131_072n * 5n)
  assert(increasedFeeExposure > lowerFeeExposure, 'fee increases must increase the next reservation')
  assert.equal(transactionExposureWei({ gas: 10n, maxFeePerGas: 3n, value: 7n }, 0), 37n)
  assert.throws(() => assertRuntimeExposureBudget({
    budgetWei: lowerFeeExposure,
    nextReservedWei: increasedFeeExposure,
  }), /Runtime budget would be exceeded/)
  assert.deepEqual(pendingReservedExposure([{ reservedCostWei: '12' }, {}]), { totalWei: 12n, unknown: 1 })
  const validReceiptCost = receiptCostWei({
    gasUsed: 2n,
    effectiveGasPrice: 3n,
    blobGasUsed: 2n * 131_072n,
    blobGasPrice: 5n,
  }, { expectedBlobCount: 2 })
  assert.deepEqual(validReceiptCost, {
    executionWei: 6n,
    blobWei: 2n * 131_072n * 5n,
    totalWei: 6n + 2n * 131_072n * 5n,
  })
  for (const receipt of [
    { gasUsed: 1n, effectiveGasPrice: 1n },
    { gasUsed: 1n, effectiveGasPrice: 1n, blobGasUsed: 131_072n },
    { gasUsed: 1n, effectiveGasPrice: 1n, blobGasPrice: 1n },
  ]) {
    assert.throws(() => receiptCostWei(receipt, { expectedBlobCount: 1 }), /must include both blobGasUsed and blobGasPrice/)
  }
  assert.throws(() => receiptCostWei({
    gasUsed: 1n,
    effectiveGasPrice: 1n,
    blobGasUsed: 131_071n,
    blobGasPrice: 1n,
  }, { expectedBlobCount: 1 }), /does not match 1 expected blobs/)

  assert.equal(parseExposureCeilingEth('0.000000000000000001'), 1n)
  assert.throws(() => parseExposureCeilingEth('0'), /greater than zero/)
  assert.throws(() => assertTransactionExposureCeiling({
    chainName: 'mainnet',
    ceilingWei: null,
    exposureWei: 10n,
    action: 'blob publish',
  }), /--max-exposure-eth is required for mainnet blob publish/)
  assert.throws(() => assertTransactionExposureCeiling({
    chainName: 'mainnet',
    ceilingWei: 9n,
    exposureWei: 10n,
    action: 'Station deploy',
  }), /maximum exposure 10 wei exceeds ceiling 9 wei/)
  assert.deepEqual(assertTransactionExposureCeiling({
    chainName: 'mainnet',
    ceilingWei: 10n,
    exposureWei: 10n,
    action: 'Station deploy',
  }), { ceilingWei: 10n, exposureWei: 10n })

  const journalRoot = path.join(tempRoot, 'default-journals')
  const defaultJournal = defaultSubmissionJournalPath({ publisherKey: 'safe--1234', sequence: 7, root: journalRoot })
  assert.equal(defaultJournal, path.join(journalRoot, 'safe--1234-7.json'))
  assert.throws(() => defaultSubmissionJournalPath({ publisherKey: '../escape', sequence: 7, root: journalRoot }), /unsafe path characters/)

  const account = privateKeyToAccount(`0x${'01'.repeat(32)}`)
  const signedTransaction = await account.signTransaction({
    chainId: 1,
    gas: 21_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    nonce: 0,
    to: `0x${'33'.repeat(20)}`,
    type: 'eip1559',
    value: 0n,
  })
  assert.equal(signedTransactionHash(signedTransaction), keccak256(signedTransaction))
  const signedRecoveryPath = path.join(tempRoot, 'signed-recovery.json')
  const signedRecoveryHash = signedTransactionHash(signedTransaction)
  writeSubmissionJournal(signedRecoveryPath, {
    version: 2,
    status: 'prepared',
    chain: 'mainnet',
    publisher: account.address,
    destination: `0x${'33'.repeat(20)}`,
    streamId: 'signed-recovery',
    sequence: 9,
    input: 'segment.webm',
    payloadBytes: 1,
    payloadSha256: payloadHash,
    nonce: 0,
    blobCount: 0,
    blobVersionedHashes: [],
    previousSegmentHash: zeroHash,
    txHash: signedRecoveryHash,
    serializedTransaction: signedTransaction,
    reservedCostWei: '42000',
    preparedAt: new Date(0).toISOString(),
  })
  const recoveredSignedTransaction = readSubmissionJournal(signedRecoveryPath)
  assert.equal(recoveredSignedTransaction.serializedTransaction, signedTransaction)
  assert.equal(signedTransactionHash(recoveredSignedTransaction.serializedTransaction), recoveredSignedTransaction.txHash)
  const recoveryIntent = {
    txHash: signedRecoveryHash,
    chainId: 1,
    publisher: account.address,
    destination: `0x${'33'.repeat(20)}`,
    nonce: 0,
    data: '0x',
    blobVersionedHashes: [],
    blobCount: 0,
    reservedCostWei: 42_000n,
  }
  const exactRecovery = await assertRecoveredSignedTransactionIntent(signedTransaction, recoveryIntent)
  assert.equal(exactRecovery.publisher.toLowerCase(), account.address.toLowerCase())
  let sendReached = 0
  const tamperedIntents = [
    [{ ...recoveryIntent, chainId: 11_155_111 }, /chain/],
    [{ ...recoveryIntent, txHash: payloadHash }, /hash/],
    [{ ...recoveryIntent, publisher: `0x${'44'.repeat(20)}` }, /signer/],
    [{ ...recoveryIntent, destination: `0x${'44'.repeat(20)}` }, /destination/],
    [{ ...recoveryIntent, nonce: 1 }, /nonce/],
    [{ ...recoveryIntent, data: '0x00' }, /calldata/],
    [{ ...recoveryIntent, valueWei: 1n }, /value/],
    [{ ...recoveryIntent, blobCount: 1, blobVersionedHashes: [payloadHash] }, /blob hashes\/count/],
    [{ ...recoveryIntent, reservedCostWei: 41_999n }, /exposure/],
  ]
  for (const [intent, expected] of tamperedIntents) {
    await assert.rejects(async () => {
      await assertRecoveredSignedTransactionIntent(signedTransaction, intent)
      sendReached += 1
    }, expected)
  }
  assert.equal(sendReached, 0, 'recovered intent mismatches must reject before any send boundary')

  const blobVersionedHash = `0x01${'55'.repeat(31)}`
  const signedBlobTransaction = await account.signTransaction({
    blobVersionedHashes: [blobVersionedHash],
    chainId: 1,
    data: '0x1234',
    gas: 100_000n,
    maxFeePerBlobGas: 3n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    nonce: 2,
    to: `0x${'33'.repeat(20)}`,
    type: 'eip4844',
    value: 0n,
  })
  const blobRecoveryIntent = {
    txHash: signedTransactionHash(signedBlobTransaction),
    chainId: 1,
    publisher: account.address,
    destination: `0x${'33'.repeat(20)}`,
    nonce: 2,
    data: '0x1234',
    blobVersionedHashes: [blobVersionedHash],
    blobCount: 1,
    reservedCostWei: 100_000n * 2n + 131_072n * 3n,
  }
  const exactBlobRecovery = await assertRecoveredSignedTransactionIntent(signedBlobTransaction, blobRecoveryIntent)
  assert.equal(exactBlobRecovery.exposureWei, blobRecoveryIntent.reservedCostWei)
  await assert.rejects(
    assertRecoveredSignedTransactionIntent(signedBlobTransaction, {
      ...blobRecoveryIntent,
      blobVersionedHashes: [`0x01${'66'.repeat(31)}`],
    }),
    /blob hashes\/count/,
  )

  const deploymentBytecode = '0x60006000f3'
  const signedDeployment = await account.signTransaction({
    chainId: 11_155_111,
    data: deploymentBytecode,
    gas: 100_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    nonce: 4,
    type: 'eip1559',
    value: 0n,
  })
  const deploymentJournal = makeStationDeploymentJournal({
    chain: 'sepolia',
    chainId: 11_155_111,
    publisher: account.address,
    bytecode: deploymentBytecode,
    serializedTransaction: signedDeployment,
    reservedCostWei: 200_000n,
    nonce: 4,
  })
  const deploymentJournalPath = path.join(tempRoot, 'Station.sepolia.submission.json')
  writeStationDeploymentJournal(deploymentJournalPath, deploymentJournal)
  const recoveredDeployment = readStationDeploymentJournal(deploymentJournalPath)
  const deploymentIntent = await assertStationDeploymentJournalIntent(recoveredDeployment, {
    chain: 'sepolia',
    chainId: 11_155_111,
    publisher: account.address,
    bytecode: deploymentBytecode,
  })
  assert.equal(deploymentIntent.exposureWei, 200_000n)
  await assert.rejects(
    assertStationDeploymentJournalIntent(recoveredDeployment, {
      chain: 'sepolia',
      chainId: 11_155_111,
      publisher: account.address,
      bytecode: '0x60016000f3',
    }),
    /bytecode does not match/,
  )
  for (const [fault, expectedStatus, metadataExpected] of [
    ['deploy-after-prepared', 'prepared', false],
    ['deploy-after-broadcast', 'broadcast', false],
    ['deploy-after-confirmation', 'confirmed', false],
    ['deploy-after-metadata', 'confirmed', true],
  ]) {
    const faultPath = path.join(tempRoot, `${fault}.json`)
    const result = runChild('deploy-journal-child', faultPath, fault)
    assert.equal(result.status, 86, `${fault} should stop at its durable boundary: ${result.stderr}`)
    assert.equal(readStationDeploymentJournal(faultPath).status, expectedStatus)
    assert.equal(fs.existsSync(`${faultPath}.metadata`), metadataExpected)
  }
  const completedDeploymentPath = path.join(tempRoot, 'deploy-complete.json')
  const completedDeployment = runChild('deploy-journal-child', completedDeploymentPath)
  assert.equal(completedDeployment.status, 0, completedDeployment.stderr)
  assert.equal(fs.existsSync(completedDeploymentPath), false, 'journal removal must be last')
  assert.equal(fs.existsSync(`${completedDeploymentPath}.metadata`), true)

  const atomicPath = path.join(tempRoot, 'atomic-state.json')
  fs.writeFileSync(atomicPath, '{"generation":"old"}\n')
  const torn = runChild('atomic-child', atomicPath, 'atomic-before-rename')
  assert.equal(torn.status, 86, `atomic fault child should stop at the injected boundary: ${torn.stderr}`)
  assert.deepEqual(JSON.parse(fs.readFileSync(atomicPath, 'utf8')), { generation: 'old' }, 'a torn replacement must preserve the prior valid state')
  const replaced = runChild('atomic-child', atomicPath)
  assert.equal(replaced.status, 0, replaced.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(atomicPath, 'utf8')), { generation: 'new' })

  const journalPath = path.join(tempRoot, 'serial.submission.json')
  const serialFault = runChild('serial-prepared-child', journalPath, 'serial-after-prepared')
  assert.equal(serialFault.status, 86, serialFault.stderr)
  const durableJournal = readSubmissionJournal(journalPath)
  assert.equal(durableJournal.txHash, txHash)
  assert.equal(durableJournal.status, 'prepared')
  assert.equal(durableJournal.reservedCostWei, '99')

  const pipelinePath = path.join(tempRoot, 'pipeline-state.json')
  const pipelineFault = runChild('pipelined-prepared-child', pipelinePath, 'pipelined-after-prepared')
  assert.equal(pipelineFault.status, 86, pipelineFault.stderr)
  const defaults = makePublisherState({ streamId: 'fault-stream', startSeq: 0, previousSegmentHash: zeroHash, submitted: true })
  const durablePipelineState = readPublisherState(pipelinePath, defaults, { submitted: true })
  assert.equal(durablePipelineState.submitted[0].txHash, txHash)
  assert.equal(durablePipelineState.submitted[0].submissionStatus, 'prepared')
  assert.equal(durablePipelineState.nextSequence, 1)

  const leaseRoot = path.join(tempRoot, 'account-leases')
  const readyPath = path.join(tempRoot, 'lease-ready')
  const releasePath = path.join(tempRoot, 'lease-release')
  const leaseAccount = `0x${'44'.repeat(20)}`
  const holder = spawn(process.execPath, [scriptPath, 'lease-hold-child', leaseRoot, readyPath, releasePath, '1', leaseAccount], {
    cwd: root,
    env: sanitizedChildEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForFile(readyPath)
  const heldLockPath = fs.readFileSync(readyPath, 'utf8')
  const contended = spawnSync(process.execPath, [scriptPath, 'lease-acquire-child', leaseRoot, '1', leaseAccount, '20'], {
    cwd: root,
    env: sanitizedChildEnv,
    encoding: 'utf8',
  })
  assert.equal(contended.status, 73, `same-account lease unexpectedly overlapped: ${contended.stdout}${contended.stderr}`)
  assert.match(contended.stderr, /ACCOUNT_LEASE_CONTENDED/)

  const oldOwner = JSON.parse(fs.readFileSync(path.join(heldLockPath, 'owner.json'), 'utf8'))
  oldOwner.heartbeatAt = new Date(0).toISOString()
  fs.writeFileSync(path.join(heldLockPath, 'owner.json'), `${JSON.stringify(oldOwner)}\n`)
  const staleButLive = spawnSync(process.execPath, [scriptPath, 'lease-acquire-child', leaseRoot, '1', leaseAccount, '1'], {
    cwd: root,
    env: sanitizedChildEnv,
    encoding: 'utf8',
  })
  assert.equal(staleButLive.status, 73, `stale timestamp evicted a live owner: ${staleButLive.stdout}${staleButLive.stderr}`)

  const otherAccountLease = acquireAccountLease({ chainId: 1, account: `0x${'55'.repeat(20)}`, root: leaseRoot })
  const otherChainLease = acquireAccountLease({ chainId: 11_155_111, account: leaseAccount, root: leaseRoot })
  assert.notEqual(otherAccountLease.lockPath, heldLockPath)
  assert.notEqual(otherChainLease.lockPath, heldLockPath)
  otherAccountLease.release()
  otherChainLease.release()

  holder.kill('SIGKILL')
  await once(holder, 'exit')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const recovered = spawnSync(process.execPath, [scriptPath, 'lease-acquire-child', leaseRoot, '1', leaseAccount, '20'], {
    cwd: root,
    env: sanitizedChildEnv,
    encoding: 'utf8',
  })
  assert.equal(recovered.status, 0, `dead account lease was not recovered: ${recovered.stdout}${recovered.stderr}`)

  // Normalize source text before checking safety-critical ordering. Git may
  // materialize CRLF files on Windows, while the ordering assertions below are
  // intentionally expressed with LF separators.
  const sourceText = (file) => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  const serialSource = sourceText(path.join(root, 'scripts', 'publish-live-segments.mjs'))
  const childSource = sourceText(path.join(root, 'scripts', 'publish-blob-chunk.mjs'))
  const pipelineSource = sourceText(path.join(root, 'scripts', 'publish-live-segments-pipelined.mjs'))
  const deploySource = sourceText(path.join(root, 'scripts', 'deploy-station.mjs'))
  assert(serialSource.includes("'--submission-journal'"))
  assert(serialSource.includes("throw new Error('--max-cost-eth is required for mainnet publishing')"))
  assert(pipelineSource.includes("throw new Error('--max-cost-eth is required for mainnet publishing')"))
  const serialStateBoundary = serialSource.search(/saveState\(\)\s*maybeInjectPublisherFault\('serial-after-state'\)/)
  const serialJournalRemoval = serialSource.lastIndexOf('removeSubmissionJournal(submissionJournalPath)')
  assert(serialStateBoundary >= 0 && serialStateBoundary < serialJournalRemoval)
  assert(childSource.indexOf('writeSubmissionJournal(submissionJournalPath, journal)') < childSource.indexOf("maybeInjectPublisherFault('serial-after-prepared')"))
  assert(childSource.indexOf("maybeInjectPublisherFault('serial-after-prepared')") < childSource.indexOf('sendRawTransaction({ serializedTransaction })'))
  assert(childSource.indexOf('await assertRecoveredSignedTransactionIntent(serializedTransaction') < childSource.indexOf('sendRawTransaction({ serializedTransaction })'))
  assert(childSource.indexOf('assertRuntimeExposureBudget({') < childSource.indexOf('sendRawTransaction({ serializedTransaction })'))
  assert(pipelineSource.indexOf("maybeInjectPublisherFault('pipelined-after-prepared')") < pipelineSource.lastIndexOf('sendTransactionWithFallback(serializedTransaction, txHash)'))
  assert(pipelineSource.lastIndexOf('assertRuntimeExposureBudget({') < pipelineSource.lastIndexOf('sendTransactionWithFallback(serializedTransaction, txHash)'))
  assert(pipelineSource.indexOf('await assertRecoveredSignedTransactionIntent(item.serializedTransaction') < pipelineSource.indexOf('await sendTransactionWithFallback(item.serializedTransaction, item.txHash)'))
  assert(!pipelineSource.includes('walletClient.sendTransaction(tx)'))
  assert(childSource.includes('defaultSubmissionJournalPath({ publisherKey: publisherIdentity.key, sequence })'))
  assert(childSource.includes("hasFlag('unsafe-no-submission-journal')"))
  assert(childSource.includes("const streamId = requestedStreamId || `eth-radio-${payloadSha256.slice(0, 16)}`"), 'standalone default stream/journal identity must survive restart')
  assert(childSource.indexOf('writeSubmissionJournal(submissionJournalPath, journal)') < childSource.indexOf('sendRawTransaction({ serializedTransaction })'))
  assert(childSource.indexOf('assertTransactionExposureCeiling({') < childSource.indexOf('signTransaction({ ...preparedTransaction'))
  assert(childSource.indexOf('acquireAccountLease({') < childSource.indexOf('prepareTransactionRequest(tx)'))
  assert(pipelineSource.indexOf('acquireAccountLease({') < pipelineSource.indexOf("getTransactionCount({ address: account.address, blockTag: 'pending' })"))
  assert(pipelineSource.lastIndexOf('assertRuntimeExposureBudget({') < pipelineSource.lastIndexOf('signTransaction(preparedTransaction)'))
  assert(deploySource.indexOf('assertTransactionExposureCeiling({') < deploySource.indexOf('signTransaction({ ...preparedTransaction'))
  assert(deploySource.indexOf('acquireAccountLease({') < deploySource.indexOf('prepareTransactionRequest(request)'))
  assert(deploySource.indexOf('writeStationDeploymentJournal(journalPath, journal)') < deploySource.indexOf('sendRawTransaction({ serializedTransaction })'))
  assert(deploySource.indexOf("maybeInjectPublisherFault('deploy-after-prepared')") < deploySource.indexOf('sendRawTransaction({ serializedTransaction })'))
  assert(deploySource.indexOf('atomicWriteJson(out, deployment)') < deploySource.indexOf('removeStationDeploymentJournal(journalPath)'))
  assert(deploySource.includes("maybeInjectPublisherFault('deploy-after-broadcast')"))
  assert(deploySource.includes("maybeInjectPublisherFault('deploy-after-confirmation')"))
  assert(deploySource.includes("maybeInjectPublisherFault('deploy-after-metadata')"))
  assert(!deploySource.includes('deployContract('))

  console.log('publisher safety tests ok')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
