import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Common, Hardfork, Mainnet } from '@ethereumjs/common'
import { createEVM } from '@ethereumjs/evm'
import { createAddressFromString } from '@ethereumjs/util'
import {
  bytesToHex,
  decodeFunctionResult,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  stringToHex,
  toEventSelector,
  toFunctionSelector,
} from 'viem'
import solc from 'solc'
import {
  assetId,
  blockRange,
  channelId,
  lotId,
  lotIndexAtBlock,
  lotRangeToBlockRange,
  normalizeAssetManifestV2,
  normalizeSegmentRecordV2,
  programId,
  rangeContainsBlock,
  rangesOverlap,
  reservationId,
  seasonId,
  segmentId,
  stationId,
  UINT32_MAX,
  UINT64_MAX,
  v1SyntheticChannelId,
} from '../packages/protocol/index.mjs'
import {
  canonicalStreamIdHash as browserCanonicalStreamIdHash,
  v1SyntheticChannelId as browserV1SyntheticChannelId,
} from '../packages/protocol/browser-kernel.js'
import { stationAbi, MAX_BLOBS_PER_SEGMENT } from './lib/station-abi.mjs'

function fixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`../test/fixtures/protocol/${name}`, import.meta.url), 'utf8'))
}

const idFixture = fixture('ids-v2.json')
const v1Fixture = fixture('station-v1.json')
const input = idFixture.input

const actualIds = {}
actualIds.stationId = stationId(input.chainId, input.stationCore)
actualIds.channelId = channelId(actualIds.stationId, input.channelKey)
actualIds.seasonId = seasonId(actualIds.channelId, input.seasonNumber)
actualIds.lotId = lotId(actualIds.seasonId, input.lotIndex)
actualIds.reservationId = reservationId(actualIds.lotId, input.winner, input.allocationNonce)
actualIds.programId = programId(actualIds.reservationId, input.programNonce)
actualIds.assetId = assetId(input.manifestRoot, input.codecProfileHash, input.totalDurationMs)
actualIds.segmentId = segmentId(actualIds.assetId, input.sequence)
actualIds.v1SyntheticChannelId = v1SyntheticChannelId(
  input.chainId,
  input.stationCore,
  input.publisher,
  input.streamIdHash,
)
assert.deepEqual(actualIds, idFixture.expected, 'JavaScript canonical IDs must match the reviewed golden vector')
assert.equal(browserCanonicalStreamIdHash(v1Fixture.sampleStreamId), v1Fixture.sampleStreamIdHash, 'browser V1 stream hashing must match the frozen V1 vector')
assert.equal(
  browserV1SyntheticChannelId(input.chainId, input.stationCore, input.publisher, input.streamIdHash),
  idFixture.expected.v1SyntheticChannelId,
  'dependency-free browser V1 identity must match the canonical ABI encoding',
)
assert.notEqual(
  browserV1SyntheticChannelId('1', input.stationCore, input.publisher, input.streamIdHash),
  idFixture.expected.v1SyntheticChannelId,
  'V1 synthetic identity must bind chainId',
)
assert.notEqual(
  browserV1SyntheticChannelId(input.chainId, input.winner, input.publisher, input.streamIdHash),
  idFixture.expected.v1SyntheticChannelId,
  'V1 synthetic identity must bind Station address',
)
assert.notEqual(
  browserV1SyntheticChannelId(input.chainId, input.stationCore, input.winner, input.streamIdHash),
  idFixture.expected.v1SyntheticChannelId,
  'V1 synthetic identity must bind publisher',
)

assert.equal(toFunctionSelector(v1Fixture.publishSegmentSignature), v1Fixture.publishSegmentSelector)
assert.equal(toEventSelector(v1Fixture.segmentPublishedSignature), v1Fixture.segmentPublishedTopic)
for (const [signature, selector] of Object.entries(v1Fixture.errors)) {
  assert.equal(keccak256(stringToHex(signature)).slice(0, 10), selector)
}
assert.equal(keccak256(stringToHex(v1Fixture.sampleStreamId)), v1Fixture.sampleStreamIdHash)
assert.equal(MAX_BLOBS_PER_SEGMENT, v1Fixture.maximumBlobsPerSegment)
assert.deepEqual(
  stationAbi.filter((entry) => entry.type === 'function').map((entry) => entry.name).sort(),
  ['MAX_BLOBS_PER_SEGMENT', 'publishSegment', 'publishedSegments'],
  'V1 function surface must remain frozen',
)
assert.deepEqual(
  stationAbi.filter((entry) => entry.type === 'event').map((entry) => entry.name),
  ['SegmentPublished'],
  'V1 event surface must remain frozen',
)
assert.deepEqual(
  stationAbi.filter((entry) => entry.type === 'error').map((entry) => entry.name).sort(),
  ['DuplicateSegment', 'InvalidBlobCount', 'MissingBlob'],
  'V1 error surface must remain frozen',
)

function compileIdsHarness() {
  const sources = {}
  for (const path of [
    'contracts/v2/libraries/ProtocolIds.sol',
    'contracts/test/ProtocolIdsHarness.sol',
  ]) {
    sources[path] = { content: fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') }
  }
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  })))
  const fatal = (output.errors || []).filter((error) => error.severity === 'error')
  assert.deepEqual(fatal, [], fatal.map((error) => error.formattedMessage || error.message).join('\n'))
  const contract = output.contracts['contracts/test/ProtocolIdsHarness.sol'].ProtocolIdsHarness
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }
}

const harness = compileIdsHarness()
const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun })
const evm = await createEVM({ common })
const caller = createAddressFromString(`0x${'99'.repeat(20)}`)
const deployment = await evm.runCall({
  caller,
  origin: caller,
  data: hexToBytes(harness.bytecode),
  gasLimit: 10_000_000n,
  skipBalance: true,
})
assert.equal(deployment.execResult.exceptionError, undefined)
assert.ok(deployment.createdAddress)

async function solidityId(functionName, args) {
  const result = await evm.runCall({
    to: deployment.createdAddress,
    caller,
    origin: caller,
    data: hexToBytes(encodeFunctionData({ abi: harness.abi, functionName, args })),
    gasLimit: 1_000_000n,
    skipBalance: true,
    isStatic: true,
  })
  assert.equal(result.execResult.exceptionError, undefined, `${functionName} reverted`)
  return decodeFunctionResult({
    abi: harness.abi,
    functionName,
    data: bytesToHex(result.execResult.returnValue),
  })
}

assert.equal(await solidityId('stationId', [BigInt(input.chainId), input.stationCore]), actualIds.stationId)
assert.equal(await solidityId('channelId', [actualIds.stationId, input.channelKey]), actualIds.channelId)
assert.equal(await solidityId('seasonId', [actualIds.channelId, BigInt(input.seasonNumber)]), actualIds.seasonId)
assert.equal(await solidityId('lotId', [actualIds.seasonId, Number(input.lotIndex)]), actualIds.lotId)
assert.equal(await solidityId('reservationId', [actualIds.lotId, input.winner, BigInt(input.allocationNonce)]), actualIds.reservationId)
assert.equal(await solidityId('programId', [actualIds.reservationId, BigInt(input.programNonce)]), actualIds.programId)
assert.equal(await solidityId('assetId', [input.manifestRoot, input.codecProfileHash, BigInt(input.totalDurationMs)]), actualIds.assetId)
assert.equal(await solidityId('segmentId', [actualIds.assetId, Number(input.sequence)]), actualIds.segmentId)
assert.equal(
  await solidityId('v1SyntheticChannelId', [BigInt(input.chainId), input.stationCore, input.publisher, input.streamIdHash]),
  actualIds.v1SyntheticChannelId,
)

const hash = `0x${'ab'.repeat(32)}`
const blockHash = `0x${'cd'.repeat(32)}`
const segment = {
  sequence: '0',
  durationMs: '12000',
  payloadBytes: '126000',
  payloadSha256: hash,
  previousSegmentHash: `0x${'00'.repeat(32)}`,
  blobVersionedHashes: [`0x01${'11'.repeat(31)}`],
  overlayBurnedIn: false,
  inclusion: {
    txHash: hash,
    blockNumber: '11240877',
    blockHash,
    transactionIndex: '2',
  },
}
const normalizedSegment = normalizeSegmentRecordV2(segment)
assert.equal(normalizedSegment.overlayStatus, 'known-absent')
assert.equal(normalizedSegment.overlayBurnedIn, false)
const { overlayBurnedIn: _legacyOverlayBoolean, ...unknownOverlaySegment } = segment

const manifest = normalizeAssetManifestV2({
  protocol: 'rfe',
  schema: 'asset-manifest',
  version: 2,
  assetId: actualIds.assetId,
  manifestRoot: input.manifestRoot,
  codec: 'av1-opus/webm',
  profile: '360p',
  totalDurationMs: '12000',
  availability: {
    network: 'sepolia',
    publishedAtBlock: '11240877',
    publishedAtSlot: '9000000',
    minimumAvailableUntilSlot: '9131072',
  },
  roles: ['GENERAL_FALLBACK', 'FUTURE_BOUNDED_ROLE'],
  segments: [{ ...unknownOverlaySegment, overlayStatus: 'unknown' }],
})
assert.equal(manifest.overlayStatus, 'unknown')
assert.equal(Object.hasOwn(manifest, 'overlayBurnedIn'), false, 'unknown overlay must not normalize to false')
assert.equal(Object.hasOwn(manifest.segments[0], 'overlayBurnedIn'), false, 'unknown segment overlay must not normalize to false')
assert.equal(manifest.hasUnknownRoles, true, 'bounded unknown roles must be retained and marked ineligible for initial policies')
assert.throws(() => normalizeAssetManifestV2({ ...manifest, version: 3 }), /version must be 2/)
assert.throws(() => normalizeSegmentRecordV2({ ...segment, sequence: '01' }), /canonical non-negative decimal/)
assert.throws(() => normalizeSegmentRecordV2({ ...segment, blobVersionedHashes: [] }), /at least 1/)
assert.throws(
  () => normalizeSegmentRecordV2({ ...segment, blobVersionedHashes: Array(7).fill(hash) }),
  /at most 6/,
)
assert.throws(
  () => normalizeSegmentRecordV2({ ...segment, overlayBurnedIn: false, overlayStatus: 'unknown' }),
  /cannot combine unknown/,
)
assert.throws(() => stationId('01', input.stationCore), /canonical non-negative decimal/)
assert.throws(() => lotId(actualIds.seasonId, (UINT32_MAX + 1n).toString()), /at most/)

assert.deepEqual(blockRange('10', '20'), { startBlock: 10n, endBlock: 20n })
assert.equal(rangeContainsBlock({ startBlock: '10', endBlock: '20' }, '10'), true)
assert.equal(rangeContainsBlock({ startBlock: '10', endBlock: '20' }, '20'), false)
assert.equal(rangesOverlap({ startBlock: '10', endBlock: '20' }, { startBlock: '20', endBlock: '30' }), false)
assert.equal(rangesOverlap({ startBlock: '10', endBlock: '20' }, { startBlock: '19', endBlock: '30' }), true)
const season = { seasonStartBlock: '100', seasonEndBlock: '300', lotSizeBlocks: '10', lotCount: '20' }
assert.deepEqual(lotRangeToBlockRange({ ...season, firstLot: '0', reservationLotCount: '1' }), { startBlock: 100n, endBlock: 110n })
assert.deepEqual(lotRangeToBlockRange({ ...season, firstLot: '19', reservationLotCount: '1' }), { startBlock: 290n, endBlock: 300n })
assert.equal(lotIndexAtBlock(season, '100'), 0n)
assert.equal(lotIndexAtBlock(season, '299'), 19n)
assert.equal(lotIndexAtBlock(season, '300'), null)
assert.throws(() => lotRangeToBlockRange({ ...season, firstLot: '20', reservationLotCount: '1' }), /inside/)
assert.throws(
  () => lotRangeToBlockRange({ seasonStartBlock: '0', seasonEndBlock: UINT64_MAX.toString(), lotSizeBlocks: UINT32_MAX.toString(), lotCount: UINT32_MAX.toString(), firstLot: '0', reservationLotCount: '1' }),
  /season end must equal/,
)
assert.throws(
  () => lotRangeToBlockRange({ seasonStartBlock: UINT64_MAX.toString(), seasonEndBlock: UINT64_MAX.toString(), lotSizeBlocks: '1', lotCount: '1', firstLot: '0', reservationLotCount: '1' }),
  /non-empty half-open range/,
)
assert.throws(
  () => lotRangeToBlockRange({ seasonStartBlock: (UINT64_MAX - 1n).toString(), seasonEndBlock: UINT64_MAX.toString(), lotSizeBlocks: '2', lotCount: '1', firstLot: '0', reservationLotCount: '1' }),
  /exceeds uint64/,
)

let randomState = 0x6d2b79f5
function random(maximum) {
  randomState = (Math.imul(randomState ^ (randomState >>> 15), 1 | randomState) + 0x6d2b79f5) >>> 0
  return randomState % maximum
}

for (let index = 0; index < 10_000; index += 1) {
  const lotSize = BigInt(random(1000) + 1)
  const lotCount = BigInt(random(1000) + 1)
  const start = BigInt(random(1_000_000))
  const first = BigInt(random(Number(lotCount)))
  const count = BigInt(random(Number(lotCount - first)) + 1)
  const generatedSeason = {
    seasonStartBlock: start.toString(),
    seasonEndBlock: (start + lotSize * lotCount).toString(),
    lotSizeBlocks: lotSize.toString(),
    lotCount: lotCount.toString(),
  }
  const range = lotRangeToBlockRange({
    ...generatedSeason,
    firstLot: first.toString(),
    reservationLotCount: count.toString(),
  })
  assert.equal(range.startBlock, start + lotSize * first)
  assert.equal(range.endBlock, range.startBlock + lotSize * count)
  assert.equal(lotIndexAtBlock(generatedSeason, range.startBlock), first)
  assert.equal(lotIndexAtBlock(generatedSeason, range.endBlock - 1n), first + count - 1n)
  if (range.endBlock < BigInt(generatedSeason.seasonEndBlock)) {
    assert.equal(rangesOverlap(range, { startBlock: range.endBlock, endBlock: range.endBlock + lotSize }), false)
  }
}

console.log('protocol kernel golden, schema, Solidity parity, and schedule property tests ok')
