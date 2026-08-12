import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { bytesToHex, toBlobs, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
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
  appendPublishedHistory,
  makePublisherState,
  publisherStateInteger,
  readPublisherStateWithRecovery,
  savePublisherState,
} from './lib/publisher-state.mjs'
import {
  maybeInjectPublisherFault,
  readSubmissionJournal,
  removeSubmissionJournal,
} from './lib/publisher-safety.mjs'
import { BLOB_DATA_BYTES, maxBlobsArg, segmentMsArg } from './lib/station-cli.mjs'
import { legacyFilesystemKey, resolveScopedJsonPath, resolveSegmentSet, scopedStreamFilesystemIdentity } from './lib/filesystem-identity.mjs'
import { installEndpointSafeProcessHandlers } from './lib/endpoint-privacy.mjs'
import { readBoundedFileSync, readBoundedJsonFileSync } from './lib/bounded-files.mjs'
import { segmentEntries, segmentEntry, waitForManifestSegment, waitForStableFile } from './lib/segment-input.mjs'

function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm live:publish -- --dir <segment-dir> --stream-id <id> [--segment-ms 12000] [--codec av1/webm]
                       [--start-seq 0] [--max-blobs 6] [--max-bytes 761856]
                       [--once] [--exit-when-caught-up] [--poll-ms 1000] [--pace]
                       [--publish-retries 5] [--retry-ms 12000] [--require-manifest]
                       [--state <state.json>] [--dry-run] [--recover-state]
                       [--max-cost-eth 0.1] [--stream-duration-ms 3600000] [--skip-wallet-balance-check]

Environment:
  ETH_RPC_URL, PRIVATE_KEY, STATION_ADDRESS, CHAIN=sepolia
`)
  process.exit(exitCode)
}

if (helpRequested()) usage(0)
dotenv.config({ quiet: true })
installEndpointSafeProcessHandlers(() => [process.env.ETH_RPC_URL].filter(Boolean))

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runPublisher(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/publish-blob-chunk.mjs', ...args], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else {
        const error = /** @type {Error & {exitCode: number | null}} */ (new Error(`publisher exited with code ${code}`))
        error.exitCode = code
        reject(error)
      }
    })
  })
}

async function runPublisherWithRetry(args, env, retries, retryMs) {
  let lastError = null
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      if (attempt > 1) console.log(`publisher retry ${attempt}/${retries}`)
      return await runPublisher(args, env)
    } catch (error) {
      lastError = error
      if (error.exitCode === 86) throw error
      if (attempt === retries) break
      console.warn(`publisher attempt ${attempt}/${retries} failed: ${error.message}`)
      await sleep(retryMs)
    }
  }
  throw lastError
}

const dirArg = readArg('dir')
const streamId = readArg('stream-id')
if (!dirArg || !streamId) usage()
const dir = path.resolve(dirArg)
const segmentMs = segmentMsArg('12000')
const codec = readArg('codec', 'av1-opus/webm')
const startSeq = numberArg('start-seq', '0', { integer: true, min: 0 })
const maxBlobs = maxBlobsArg('6')
const maxBytes = numberArg('max-bytes', String(maxBlobs * 126_976), { integer: true, min: 1 })
const maximumPayloadBytes = Math.min(maxBytes, maxBlobs * BLOB_DATA_BYTES)
const pollMs = numberArg('poll-ms', '1000', { integer: true, min: 1 })
const publishRetries = numberArg('publish-retries', '5', { integer: true, min: 1 })
const retryMs = numberArg('retry-ms', '12000', { integer: true, min: 0 })
const once = hasFlag('once')
const exitWhenCaughtUp = hasFlag('exit-when-caught-up')
const pace = hasFlag('pace')
const requireManifest = hasFlag('require-manifest')
const dryRun = hasFlag('dry-run')
const recoverState = hasFlag('recover-state')
const stateArg = readArg('state')
const costOptions = readCostOptions(process.argv)
const requestedRuntimeBudgetWei = costOptions.maxCostEth ? parseEthToWei(costOptions.maxCostEth) : null
const chainName = process.env.CHAIN || 'sepolia'

if (!fs.existsSync(dir)) throw new Error(`Segment directory not found: ${dir}`)
if (!dryRun && !process.env.STATION_ADDRESS) throw new Error('STATION_ADDRESS is required for live publish discovery')

const segmentSet = resolveSegmentSet({ directory: dir, streamId, migrate: !dryRun, allowUnmanifestedSafeLegacy: true, allowInvalidSafeLegacyManifest: !requireManifest })
const filePrefix = segmentSet.filePrefix
const publisher = process.env.PRIVATE_KEY
  ? privateKeyToAccount(/** @type {`0x${string}`} */ (process.env.PRIVATE_KEY)).address
  : process.env.PUBLISHER_ADDRESS
const publisherIdentity = scopedStreamFilesystemIdentity({ chain: chainName, station: process.env.STATION_ADDRESS, publisher, streamId })
const defaultStatePath = path.resolve(`work/blob-radio-testnet/live-state/${publisherIdentity.key}.json`)
const statePath = dryRun
  ? path.resolve(stateArg || defaultStatePath)
  : resolveScopedJsonPath({
      explicitPath: stateArg,
      targetPath: defaultStatePath,
      legacyPath: path.resolve(`work/blob-radio-testnet/live-state/${legacyFilesystemKey(streamId)}.json`),
      streamId,
      identity: publisherIdentity,
      description: 'serial publisher state',
      companionSuffixes: ['.submission.json'],
    })
const submissionJournalPath = `${statePath}.submission.json`

if (!dryRun) fs.mkdirSync(path.dirname(statePath), { recursive: true })

let state = makePublisherState({
  streamId,
  startSeq,
  previousSegmentHash: zeroHash,
  submitted: true,
})
state.filesystemIdentity = publisherIdentity
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

function saveState() {
  savePublisherState(statePath, state, { dryRun })
}

let submissionJournal = dryRun ? null : readSubmissionJournal(submissionJournalPath)
if (submissionJournal) {
  if (submissionJournal.streamId !== streamId) throw new Error('Submission journal streamId does not match publisher state')
  const journalSequence = Number(submissionJournal.sequence)
  if (journalSequence < state.nextSequence) {
    const published = state.published.find((item) => Number(item.sequence) === journalSequence)
    if (!published || String(published.txHash).toLowerCase() !== submissionJournal.txHash.toLowerCase()) {
      throw new Error('Submission journal is older than publisher state but is not represented in published history')
    }
    removeSubmissionJournal(submissionJournalPath)
    submissionJournal = null
  } else if (journalSequence > state.nextSequence) {
    throw new Error('Submission journal sequence is ahead of publisher state')
  }
}

function syncExposureMetrics() {
  const confirmedSpendWei = BigInt(state.metrics.actualSpendWei)
  const reservedPendingWei = submissionJournal
    ? BigInt(submissionJournal.status === 'confirmed' && submissionJournal.actualCostWei !== undefined
      ? submissionJournal.actualCostWei
      : submissionJournal.reservedCostWei)
    : 0n
  state.metrics.reservedPendingWei = reservedPendingWei.toString()
  state.metrics.totalExposureWei = (confirmedSpendWei + reservedPendingWei).toString()
  state.metrics.pendingCount = submissionJournal ? 1 : 0
  return { confirmedSpendWei, reservedPendingWei, totalExposureWei: confirmedSpendWei + reservedPendingWei }
}

let exposure = syncExposureMetrics()
if (runtimeBudgetWei !== null && exposure.totalExposureWei > runtimeBudgetWei) {
  throw new Error('Recovered publisher exposure exceeds the configured runtime budget')
}
saveState()

console.log(`live publisher watching ${dir}`)
console.log(`stream: ${streamId}`)
console.log(`next sequence: ${state.nextSequence}`)
console.log(`max blobs: ${maxBlobs}, max bytes: ${maxBytes}`)
console.log(`publish retries: ${publishRetries}, retry ms: ${retryMs}`)
console.log(`require manifest: ${requireManifest}`)
if (dryRun) console.log('dry run: validating local segment discovery and guardrails without publishing')

if (!dryRun && hasCostBudget()) {
  await runCostPreflightOrExit({
    segments: readSegmentFilesAsCostSegments(
      segmentEntries(dir, filePrefix)
        .filter((entry) => entry.sequence >= startSeq)
        .map((entry) => entry.file),
    ),
    segmentMs,
  })
}

while (true) {
  exposure = syncExposureMetrics()
  if (runtimeBudgetWei !== null && exposure.confirmedSpendWei >= runtimeBudgetWei && !submissionJournal) {
    state.metrics.runtimeBudgetExhausted = true
    state.metrics.runtimeBudgetExhaustedAt ||= new Date().toISOString()
    saveState()
    console.log(`runtime budget exhausted: spent ${formatEth(exposure.confirmedSpendWei)} ETH / ${formatEth(runtimeBudgetWei)} ETH`)
    break
  }
  const entry = segmentEntry(dir, filePrefix, state.nextSequence)
    || (submissionJournal && Number(submissionJournal.sequence) === state.nextSequence && submissionJournal.input
      ? { sequence: state.nextSequence, file: submissionJournal.input }
      : null)
  if (!entry) {
    if (once || exitWhenCaughtUp) break
    await sleep(pollMs)
    continue
  }

  const manifestSegment = submissionJournal
    ? null
    : await waitForManifestSegment(dir, filePrefix, state.nextSequence, pollMs, requireManifest)
  const file = manifestSegment?.file || entry.file
  if (!submissionJournal && !manifestSegment) await waitForStableFile(file, pollMs)
  if (!fs.existsSync(file)) throw new Error(`Submission journal source payload is missing: ${file}`)
  const payload = readBoundedFileSync(file, {
    maxBytes: maximumPayloadBytes,
    label: `segment ${state.nextSequence} payload`,
  })
  const blobs = toBlobs({ data: bytesToHex(payload) })
  const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex')

  if (payload.length > maxBytes || blobs.length > maxBlobs) {
    throw new Error(
      `Segment ${state.nextSequence} exceeds guardrails: ${payload.length} bytes, ${blobs.length} blobs; limits ${maxBytes} bytes, ${maxBlobs} blobs`,
    )
  }

  const startedAt = new Date()
  const sequence = state.nextSequence
  console.log(`${dryRun ? 'would publish' : 'publishing'} seq ${sequence}: ${payload.length} bytes, ${blobs.length} blob(s), previous ${state.previousSegmentHash}`)

  if (dryRun) {
    state.previousSegmentHash = `0x${payloadSha256}`
    state.nextSequence += 1
    if (pace) await sleep(segmentMs)
    if (once) break
    continue
  }

  const env = {
    ...process.env,
    GAS_LIMIT: process.env.GAS_LIMIT || '180000',
  }
  const publisherArgs = [
      '--input',
      file,
      '--stream-id',
      streamId,
      '--seq',
      String(state.nextSequence),
      '--duration-ms',
      String(segmentMs),
      '--codec',
      codec,
      '--previous-hash',
      state.previousSegmentHash,
      '--submission-journal',
      submissionJournalPath,
    ]
  if (runtimeBudgetWei !== null) {
    publisherArgs.push('--remaining-budget-wei', (runtimeBudgetWei - exposure.confirmedSpendWei).toString())
  }
  await runPublisherWithRetry(
    publisherArgs,
    env,
    publishRetries,
    retryMs,
  )
  maybeInjectPublisherFault('serial-after-child')

  submissionJournal = readSubmissionJournal(submissionJournalPath)
  if (!submissionJournal || submissionJournal.status !== 'confirmed') {
    throw new Error('Publisher child exited without a confirmed durable submission journal')
  }

  const manifestPath = path.resolve(
    `work/blob-radio-testnet/manifests/${publisherIdentity.key}-${state.nextSequence}.json`,
  )
  const manifest = readBoundedJsonFileSync(manifestPath, {
    maxBytes: 1024 * 1024,
    label: `publisher manifest ${manifestPath}`,
  })

  appendPublishedHistory(state, {
    sequence: state.nextSequence,
    file,
    payloadBytes: payload.length,
    payloadSha256,
    blobCount: blobs.length,
    previousSegmentHash: state.previousSegmentHash,
    txHash: manifest.txHash,
    blockNumber: manifest.blockNumber,
    startedAt: startedAt.toISOString(),
    includedAt: manifest.createdAt,
    costWei: manifest.costWei,
    executionCostWei: manifest.executionCostWei,
    blobCostWei: manifest.blobCostWei,
  })
  const actualCostWei = BigInt(manifest.costWei)
  if (actualCostWei > BigInt(submissionJournal.reservedCostWei)) {
    throw new Error('Confirmed serial transaction cost exceeds its reserved exposure')
  }
  state.metrics.submittedCount = publisherStateInteger(state.metrics.submittedCount, 'metrics.submittedCount') + 1
  state.metrics.confirmedCount = publisherStateInteger(state.metrics.confirmedCount, 'metrics.confirmedCount') + 1
  state.metrics.actualSpendWei = (BigInt(state.metrics.actualSpendWei) + actualCostWei).toString()
  state.metrics.actualExecutionSpendWei = (
    BigInt(state.metrics.actualExecutionSpendWei) + BigInt(manifest.executionCostWei)
  ).toString()
  state.metrics.actualBlobSpendWei = (
    BigInt(state.metrics.actualBlobSpendWei) + BigInt(manifest.blobCostWei)
  ).toString()
  state.previousSegmentHash = `0x${payloadSha256}`
  state.nextSequence += 1
  submissionJournal = null
  syncExposureMetrics()
  saveState()
  maybeInjectPublisherFault('serial-after-state')
  removeSubmissionJournal(submissionJournalPath)

  if (pace) await sleep(segmentMs)
  if (once) break
}

saveState()
console.log(dryRun ? 'dry run complete: no state written' : `state: ${statePath}`)
