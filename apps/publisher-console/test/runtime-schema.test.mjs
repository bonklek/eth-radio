import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { streamFilesystemIdentity } from '../../../scripts/lib/filesystem-identity.mjs'
import { DEFAULT_CONFIG } from '../lib/config.mjs'
import { mediaJobProjection, transactionJobProjection } from '../lib/job-projections.mjs'
import { sealPublisherEngineState } from '../lib/engine-state-integrity.mjs'
import {
  MAX_ENGINE_ITEMS,
  MAX_MANIFEST_SEGMENTS,
  PUBLISHER_JOB_MAX_BYTES,
  readPublisherEngineState,
  readPublisherJobConfig,
  readPublisherProgress,
  readSegmentManifest,
  readSupervisorState,
  validateSegmentManifest,
} from '../lib/runtime-schema.mjs'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-runtime-schema-'))
const jobDir = path.join(temp, 'jobs', '2026-07-11T12-34-56-123Z-abcdef')
const segmentDir = path.join(jobDir, 'segments')
const configPath = path.join(jobDir, 'job.json')
const statePath = path.join(jobDir, 'publisher-state.json')
const progressPath = path.join(jobDir, 'publisher-progress.json')
const sourcePath = path.join(temp, 'source.mp4')
const manifestPath = path.join(segmentDir, 'manifest.json')
const privateKey = `0x${'1'.padStart(64, '0')}`
const stationAddress = '0x1111111111111111111111111111111111111111'
const publisher = '0x2222222222222222222222222222222222222222'
const streamId = 'runtime-schema-test'

fs.mkdirSync(segmentDir, { recursive: true })
fs.writeFileSync(sourcePath, 'media')

function writeJson(file, value) {
  const output = value?.engine === 'rfe-transaction-continuity'
    ? sealPublisherEngineState(value)
    : value
  fs.writeFileSync(file, `${JSON.stringify(output)}\n`)
}

const job = {
  ...DEFAULT_CONFIG,
  sourcePath,
  streamId,
  stationAddress,
  executionRpcUrl: 'https://rpc.example.test',
  segmentDir,
  publisherStatePath: statePath,
  startSequence: 0,
}
writeJson(configPath, job)
const loadedJob = readPublisherJobConfig(configPath, { env: { PRIVATE_KEY: privateKey } })
assert.equal(loadedJob.segmentDir, segmentDir)
assert.equal(loadedJob.publisherStatePath, statePath)

const projectionPaths = { segmentDir, publisherStatePath: statePath, publisherProgressPath: progressPath }
const mediaConfigPath = path.join(jobDir, 'media-job.json')
const publisherConfigPath = path.join(jobDir, 'publisher-job.json')
const normalizedForProjection = { ...job, sendRpcUrls: ['https://send-secret.example.test/key'] }
writeJson(mediaConfigPath, mediaJobProjection(normalizedForProjection, projectionPaths))
writeJson(publisherConfigPath, transactionJobProjection(normalizedForProjection, projectionPaths))
const mediaConfigText = fs.readFileSync(mediaConfigPath, 'utf8')
const publisherConfigText = fs.readFileSync(publisherConfigPath, 'utf8')
assert.equal(mediaConfigText.includes('send-secret'), false)
assert.equal(mediaConfigText.includes('maxStreamCostEth'), false)
assert.equal(publisherConfigText.includes(sourcePath), false)
assert.equal(publisherConfigText.includes('liveInputUrl'), false)
assert.equal(readPublisherJobConfig(mediaConfigPath, { role: 'media', env: {} }).publisherStatePath, undefined)
assert.equal(readPublisherJobConfig(publisherConfigPath, {
  role: 'publisher', env: { PRIVATE_KEY: privateKey },
}).publisherProgressPath, progressPath)
assert.throws(
  () => readPublisherJobConfig(configPath, { role: 'media', env: {} }),
  /unknown field beaconRpcUrl|must use rfe\/publisher-media-job@1/,
)

writeJson(progressPath, {
  schema: 'rfe/publisher-progress@1',
  chain: 'sepolia',
  stationAddress,
  publisher,
  streamId,
  confirmedCount: 2,
  pendingCount: 1,
  updatedAt: new Date(0).toISOString(),
})
assert.equal(readPublisherProgress(progressPath, { chain: 'sepolia', stationAddress, streamId }).confirmedCount, 2)
writeJson(progressPath, {
  schema: 'rfe/publisher-progress@1',
  chain: 'sepolia',
  stationAddress,
  publisher,
  streamId: 'wrong-stream',
  confirmedCount: 2,
  pendingCount: 1,
  updatedAt: new Date(0).toISOString(),
})
assert.throws(() => readPublisherProgress(progressPath, { chain: 'sepolia', stationAddress, streamId }), /identity does not match/)

writeJson(configPath, { ...job, futureAuthority: true })
assert.throws(() => readPublisherJobConfig(configPath, { env: { PRIVATE_KEY: privateKey } }), /unknown field futureAuthority/)
writeJson(configPath, { ...job, segmentDir: path.join(temp, 'escape') })
assert.throws(() => readPublisherJobConfig(configPath, { env: { PRIVATE_KEY: privateKey } }), /does not match the job directory/)
fs.writeFileSync(configPath, ' '.repeat(PUBLISHER_JOB_MAX_BYTES + 1))
assert.throws(() => readPublisherJobConfig(configPath, { env: { PRIVATE_KEY: privateKey } }), /exceeds 65536 bytes/)
writeJson(configPath, job)

const segment = {
  sequence: 0,
  mediaIndex: 0,
  file: path.join(segmentDir, 'segment-000000.webm'),
  bytes: 100,
  estimatedBlobs: 1,
  payloadSha256: 'ab'.repeat(32),
  durationMs: 12_000,
  overlayBurnedIn: false,
  createdAt: new Date(0).toISOString(),
}
const manifest = {
  app: 'eth-radio-private-console',
  kind: 'publisher-console-segments',
  streamId,
  filePrefix: 'fixture',
  outDir: segmentDir,
  segmentMs: 12_000,
  codec: 'av1-opus/webm',
  configFingerprint: 'cd'.repeat(32),
  pipelineMode: 'rolling-parallel',
  overlayBurnedIn: false,
  createdAt: new Date(0).toISOString(),
  segments: [segment],
  filesystemIdentity: streamFilesystemIdentity(streamId),
}
writeJson(manifestPath, manifest)
assert.equal(readSegmentManifest(manifestPath, { streamId, segmentDir }).segments.length, 1)
assert.throws(
  () => validateSegmentManifest({ ...manifest, futureAuthority: true }, { streamId, segmentDir }),
  /unknown field futureAuthority/,
)
assert.throws(
  () => validateSegmentManifest({ ...manifest, filesystemIdentity: { ...manifest.filesystemIdentity, version: 2 } }, { streamId, segmentDir }),
  /filesystem identity does not match/,
)
assert.throws(
  () => validateSegmentManifest({ ...manifest, segments: [segment, { ...segment }] }, { streamId, segmentDir }),
  /unique and strictly increasing/,
)
assert.throws(
  () => validateSegmentManifest({ ...manifest, segments: [{ ...segment, file: path.join(temp, 'escape.webm') }] }, { streamId, segmentDir }),
  /escapes its job directory/,
)
assert.throws(
  () => validateSegmentManifest({ ...manifest, segments: Array(MAX_MANIFEST_SEGMENTS + 1).fill(segment) }, { streamId, segmentDir }),
  /at most 65536 entries/,
)

const engineState = {
  version: 8,
  engine: 'rfe-transaction-continuity',
  chain: 'sepolia',
  stationAddress,
  publisher,
  streamId,
  nextSequence: 0,
  nextNonce: null,
  previousSegmentHash: `0x${'00'.repeat(32)}`,
  items: [],
  published: [],
  actualSpendWei: '0',
  durabilityMode: 'file-sync-verified-readback',
  metrics: {},
}
writeJson(statePath, engineState)
assert.equal(readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId }).streamId, streamId)
writeJson(statePath, { ...engineState, version: 4 })
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId }),
  /unsupported version/,
)
writeJson(statePath, { ...engineState, items: Array(MAX_ENGINE_ITEMS + 1).fill({}) })
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId }),
  /at most 64 entries/,
)
writeJson(statePath, { ...engineState, actualSpendWei: '1' })
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId }),
  /does not equal success plus revert cost history/,
)
const attempt = {
  index: 0,
  intentDigest: '77'.repeat(32),
  txHash: `0x${'33'.repeat(32)}`,
  serializedTransaction: '0x01',
  reservedCostWei: '10',
  maxFeePerGas: '2',
  maxPriorityFeePerGas: '1',
  maxFeePerBlobGas: '2',
  preparedAt: new Date(0).toISOString(),
  broadcastAt: null,
  lastSendAttemptAt: null,
  sendCount: 0,
}
const reservation = {
  schema: 'rfe/publication-intent@1',
  publisher,
  chainId: 11155111,
  type: 'eip4844',
  to: stationAddress,
  nonce: 0,
  gas: '180000',
  value: '0',
  dataSha256: '88'.repeat(32),
  maxFeePerGas: '2',
  maxPriorityFeePerGas: '1',
  maxFeePerBlobGas: '2',
  blobVersionedHashes: [`0x01${'34'.repeat(31)}`],
  blobCount: 1,
  payloadSha256: `0x${'ab'.repeat(32)}`,
  reservedExposureWei: '10',
  intentDigest: '77'.repeat(32),
  index: 0,
  reservedAt: new Date(0).toISOString(),
}
const lineage = {
  sequence: 0,
  nonce: 0,
  file: path.join(segmentDir, 'segment-000000.webm'),
  durationMs: 12_000,
  codec: 'av1-opus/webm',
  payloadBytes: 100,
  payloadSha256: 'ab'.repeat(32),
  blobCount: 1,
  previousSegmentHash: `0x${'00'.repeat(32)}`,
  status: 'prepared',
  blockedReason: null,
  winnerHash: null,
  reservations: [reservation],
  attempts: [attempt],
  createdAt: new Date(0).toISOString(),
  liquidityEvidence: {
    requiredWei: '10',
    minimumBalanceWei: '10',
    maximumBalanceWei: '12',
    disagreement: true,
    observations: [
      { provider: 'RPC 1', balanceWei: '10' },
      { provider: 'RPC 2', balanceWei: '12' },
    ],
    observedAt: new Date(0).toISOString(),
  },
  gasPreflightEvidence: {
    floorGas: '100000',
    capGas: '500000',
    marginPercent: '25',
    gasLimit: '180000',
    maximumEstimateGas: '144000',
    disagreement: true,
    observations: [
      { provider: 'RPC 1', blockNumber: '10', blockHash: `0x${'bb'.repeat(32)}`, stationCodeHash: `0x${'cc'.repeat(32)}`, estimateGas: '100000' },
      { provider: 'RPC 2', blockNumber: '11', blockHash: `0x${'dd'.repeat(32)}`, stationCodeHash: `0x${'cc'.repeat(32)}`, estimateGas: '144000' },
    ],
    observedAt: new Date(0).toISOString(),
  },
}
writeJson(statePath, { ...engineState, nextSequence: 1, nextNonce: 1, items: [lineage] })
assert.equal(readPublisherEngineState(statePath, {
  chain: 'sepolia', stationAddress, publisher, streamId, segmentDir,
}).items.length, 1)
const linkedPrevious = sealPublisherEngineState({ ...engineState, nextSequence: 1, nextNonce: 1, items: [lineage] })
const linkedCurrent = sealPublisherEngineState({ ...linkedPrevious, updatedAt: new Date(1).toISOString() }, linkedPrevious)
fs.writeFileSync(`${statePath}.previous`, `${JSON.stringify(linkedPrevious)}\n`)
fs.writeFileSync(statePath, `${JSON.stringify(linkedCurrent)}\n`)
assert.equal(readPublisherEngineState(statePath, {
  chain: 'sepolia', stationAddress, publisher, streamId, segmentDir,
}).revision, 1)
fs.writeFileSync(statePath, '{"torn":')
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /JSON|publisher engine state/,
)
assert.equal(JSON.parse(fs.readFileSync(`${statePath}.previous`, 'utf8')).stateChecksum, linkedPrevious.stateChecksum)
fs.rmSync(`${statePath}.previous`, { force: true })
const { gasPreflightEvidence: omittedGasEvidence, ...lineageWithoutGasEvidence } = lineage
assert.ok(omittedGasEvidence)
writeJson(statePath, { ...engineState, nextSequence: 1, nextNonce: 1, items: [lineageWithoutGasEvidence] })
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /reservation requires gas preflight evidence/,
)
writeJson(statePath, { ...engineState, nextSequence: 1, nextNonce: 1, items: [{ ...lineage, file: path.join(temp, 'escape.webm') }] })
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /escapes its job directory/,
)
writeJson(statePath, {
  ...engineState,
  nextSequence: 1,
  nextNonce: 1,
  items: [{ ...lineage, attempts: [{ ...attempt, serializedTransaction: 'not-hex' }] }],
})
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /bounded transaction hex/,
)
writeJson(statePath, {
  ...engineState,
  nextSequence: 1,
  nextNonce: 1,
  items: [{ ...lineage, liquidityEvidence: { ...lineage.liquidityEvidence, minimumBalanceWei: '11' } }],
})
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /bounds do not match observations/,
)
writeJson(statePath, {
  ...engineState,
  nextSequence: 1,
  nextNonce: 1,
  items: [{ ...lineage, liquidityEvidence: { ...lineage.liquidityEvidence, disagreement: 'true' } }],
})
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /disagreement must be boolean/,
)
writeJson(statePath, {
  ...engineState,
  nextSequence: 1,
  nextNonce: 1,
  items: [{ ...lineage, gasPreflightEvidence: { ...lineage.gasPreflightEvidence, gasLimit: '149999' } }],
})
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /does not match its observations and policy/,
)
writeJson(statePath, {
  ...engineState,
  nextSequence: 2,
  nextNonce: 1,
  items: [lineage, {
    ...lineage,
    sequence: 1,
    attempts: [{ ...attempt, txHash: `0x${'44'.repeat(32)}` }],
  }],
})
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /nonce lineages must be unique/,
)
writeJson(statePath, {
  ...engineState,
  nextSequence: 1,
  nextNonce: 1,
  items: [{ ...lineage, winnerHash: `0x${'55'.repeat(32)}` }],
})
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /does not belong to its attempt lineage/,
)
const failedLineage = {
  ...lineage,
  status: 'failed',
  winnerHash: attempt.txHash,
  accountedCostWei: '10',
  accountedExecutionCostWei: '4',
  accountedBlobCostWei: '6',
  accountedAt: new Date(0).toISOString(),
}
writeJson(statePath, {
  ...engineState,
  nextSequence: 1,
  nextNonce: 1,
  items: [failedLineage],
  actualSpendWei: '10',
})
assert.equal(readPublisherEngineState(statePath, {
  chain: 'sepolia', stationAddress, publisher, streamId, segmentDir,
}).actualSpendWei, '10')
writeJson(statePath, {
  ...engineState,
  nextSequence: 1,
  nextNonce: 1,
  items: [{ ...failedLineage, accountedBlobCostWei: undefined }],
  actualSpendWei: '10',
})
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /accounting is incomplete/,
)
const published = {
  sequence: 0,
  nonce: 0,
  file: path.join(segmentDir, 'segment-000000.webm'),
  durationMs: 12_000,
  codec: 'av1-opus/webm',
  payloadBytes: 100,
  payloadSha256: 'ab'.repeat(32),
  blobCount: 1,
  previousSegmentHash: `0x${'00'.repeat(32)}`,
  txHash: `0x${'33'.repeat(32)}`,
  winningAttempt: 0,
  attemptCount: 1,
  attemptHashes: [`0x${'33'.repeat(32)}`],
  blockHash: `0x${'66'.repeat(32)}`,
  blockNumber: '1',
  blobVersionedHashes: [`0x${'01'.repeat(32)}`],
  costWei: '10',
  executionCostWei: '4',
  blobCostWei: '6',
  gasLimit: '180000',
  gasUsed: '120000',
  confirmedAt: new Date(0).toISOString(),
  finalityStatus: 'operationally-confirmed',
  finalityEvidence: null,
}
writeJson(statePath, { ...engineState, nextSequence: 1, nextNonce: 1, published: [published], actualSpendWei: '10' })
assert.equal(readPublisherEngineState(statePath, {
  chain: 'sepolia', stationAddress, publisher, streamId, segmentDir,
}).published.length, 1)
writeJson(statePath, {
  ...engineState,
  nextSequence: 1,
  nextNonce: 1,
  published: [{ ...published, gasUsed: '180001' }],
  actualSpendWei: '10',
})
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /gasUsed exceeds gasLimit/,
)
const finalizedPublished = {
  ...published,
  finalityStatus: 'finalized-tag-observed',
  finalityEvidence: {
    matches: [{ provider: 'RPC 1', finalizedHeadNumber: '100', finalizedHeadHash: `0x${'77'.repeat(32)}` }],
    conflicts: [],
    observedAt: new Date(1).toISOString(),
  },
}
writeJson(statePath, { ...engineState, nextSequence: 1, nextNonce: 1, published: [finalizedPublished], actualSpendWei: '10' })
assert.equal(readPublisherEngineState(statePath, {
  chain: 'sepolia', stationAddress, publisher, streamId, segmentDir,
}).published[0].finalityStatus, 'finalized-tag-observed')
writeJson(statePath, {
  ...engineState,
  nextSequence: 1,
  nextNonce: 1,
  published: [{ ...finalizedPublished, finalityEvidence: { ...finalizedPublished.finalityEvidence, matches: [] } }],
  actualSpendWei: '10',
})
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /requires matches and no conflicts/,
)
writeJson(statePath, {
  ...engineState,
  nextSequence: 1,
  nextNonce: 1,
  published: [{ ...published, costWei: '11' }],
  actualSpendWei: '11',
})
assert.throws(
  () => readPublisherEngineState(statePath, { chain: 'sepolia', stationAddress, publisher, streamId, segmentDir }),
  /does not conserve execution plus blob cost/,
)

const supervisorPath = path.join(temp, 'supervisor-state.json')
const supervisor = {
  version: 3,
  jobId: path.basename(jobDir),
  phase: 'running',
  desired: 'running',
  startedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  encoderComplete: false,
  encoderFailures: 0,
  publisherRestarts: 0,
  publisherRestartHistory: [],
  recoveryRequired: false,
  recoveryPreviousDesired: null,
  lastError: null,
  metrics: {},
}
writeJson(supervisorPath, supervisor)
assert.equal(readSupervisorState(supervisorPath).phase, 'running')
writeJson(supervisorPath, { ...supervisor, desired: 'teleporting' })
assert.throws(() => readSupervisorState(supervisorPath), /invalid phase/)
writeJson(supervisorPath, {
  ...supervisor,
  publisherRestarts: 6,
  publisherRestartHistory: Array.from({ length: 6 }, (_, index) => ({ cause: 'exit:1', at: new Date(index).toISOString() })),
})
assert.throws(() => readSupervisorState(supervisorPath), /at most 5 entries/)
writeJson(supervisorPath, {
  ...supervisor,
  publisherRestarts: 1,
  publisherRestartHistory: [],
})
assert.throws(() => readSupervisorState(supervisorPath), /does not match publisherRestartHistory/)
writeJson(supervisorPath, {
  ...supervisor,
  phase: 'recovery-required',
  desired: 'recovery-required',
  recoveryRequired: true,
  recoveryPreviousDesired: 'running',
})
assert.equal(readSupervisorState(supervisorPath).recoveryPreviousDesired, 'running')
writeJson(supervisorPath, { ...supervisor, recoveryRequired: true, recoveryPreviousDesired: null })
assert.throws(() => readSupervisorState(supervisorPath), /must preserve its prior desired mode/)

fs.rmSync(temp, { recursive: true, force: true })
console.log('publisher runtime schema hostile tests ok')
