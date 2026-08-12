import assert from 'node:assert/strict'
import { Common, Hardfork, Mainnet } from '@ethereumjs/common'
import { createEVM } from '@ethereumjs/evm'
import { createAddressFromString } from '@ethereumjs/util'
import {
  bytesToHex,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  stringToHex,
  zeroHash,
} from 'viem'
import { compileStation } from './compile-station.mjs'

const gasLimit = 30_000_000n
const publisherAHex = `0x${'11'.repeat(20)}`
const publisherBHex = `0x${'22'.repeat(20)}`
const publisherA = createAddressFromString(publisherAHex)
const publisherB = createAddressFromString(publisherBHex)
const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun })
const evm = await createEVM({ common })
const { abi, bytecode } = compileStation()

let blobhashSteps = 0
evm.events.on('step', (step) => {
  if (step.opcode.name === 'BLOBHASH') blobhashSteps += 1
})

function versionedHash(marker) {
  const byte = Number(marker).toString(16).padStart(2, '0')
  return `0x01${byte.repeat(31)}`
}

function metadata(overrides = {}) {
  return {
    streamId: 'radio-free-ethereum',
    sequence: 0n,
    durationMs: 24_000n,
    payloadBytes: 456_789,
    payloadSha256: `0x${'ab'.repeat(32)}`,
    codec: 'av1-opus/webm',
    previousSegmentHash: zeroHash,
    blobCount: 1,
    ...overrides,
  }
}

function publishData(value) {
  return encodeFunctionData({
    abi,
    functionName: 'publishSegment',
    args: [
      value.streamId,
      value.sequence,
      value.durationMs,
      value.payloadBytes,
      value.payloadSha256,
      value.codec,
      value.previousSegmentHash,
      value.blobCount,
    ],
  })
}

async function publish(caller, value, blobVersionedHashes) {
  const stepsBefore = blobhashSteps
  const result = await evm.runCall({
    to: stationAddress,
    caller,
    origin: caller,
    data: hexToBytes(publishData(value)),
    gasLimit,
    skipBalance: true,
    blobVersionedHashes,
  })
  return { ...result, blobhashSteps: blobhashSteps - stepsBefore }
}

function assertSuccess(result, label) {
  assert.equal(result.execResult.exceptionError, undefined, `${label} reverted: ${result.execResult.exceptionError?.error}`)
}

function assertCustomError(result, name, expectedArgs = []) {
  assert.equal(result.execResult.exceptionError?.error, 'revert')
  const decoded = decodeErrorResult({ abi, data: bytesToHex(result.execResult.returnValue) })
  assert.equal(decoded.errorName, name)
  assert.deepEqual(decoded.args || [], expectedArgs)
  assert.deepEqual(result.execResult.logs || [], [], `${name} must not retain reverted logs`)
}

function decodeSegmentEvent(result) {
  const logs = result.execResult.logs || []
  assert.equal(logs.length, 1, 'successful publish must emit exactly one event')
  const [address, topics, data] = logs[0]
  assert.equal(bytesToHex(address).toLowerCase(), stationAddress.toString().toLowerCase())
  return decodeEventLog({
    abi,
    eventName: 'SegmentPublished',
    topics: topics.map((topic) => bytesToHex(topic)),
    data: bytesToHex(data),
    strict: true,
  })
}

async function isPublished(callerHex, value) {
  const data = encodeFunctionData({
    abi,
    functionName: 'publishedSegments',
    args: [callerHex, keccak256(stringToHex(value.streamId)), value.sequence],
  })
  const result = await evm.runCall({
    to: stationAddress,
    caller: publisherA,
    origin: publisherA,
    data: hexToBytes(data),
    gasLimit,
    skipBalance: true,
    isStatic: true,
  })
  assertSuccess(result, 'publishedSegments read')
  return decodeFunctionResult({ abi, functionName: 'publishedSegments', data: bytesToHex(result.execResult.returnValue) })
}

const deployment = await evm.runCall({
  caller: publisherA,
  origin: publisherA,
  data: hexToBytes(bytecode),
  gasLimit,
  skipBalance: true,
})
assertSuccess(deployment, 'Station deployment')
assert.ok(deployment.createdAddress, 'Station deployment did not create a contract address')
const stationAddress = deployment.createdAddress
const deployedCode = await evm.stateManager.getCode(stationAddress)
assert.ok(deployedCode.length > 0, 'Station deployment stored no runtime bytecode')
assert.equal(common.hardfork(), Hardfork.Cancun)

const zeroBlob = metadata({ sequence: 10n, blobCount: 0 })
const zeroResult = await publish(publisherA, zeroBlob, [])
assertCustomError(zeroResult, 'InvalidBlobCount')
assert.equal(zeroResult.blobhashSteps, 0, 'zero boundary must reject before BLOBHASH')
assert.equal(await isPublished(publisherAHex, zeroBlob), false)

const oneHash = versionedHash(1)
const oneBlob = metadata()
const oneResult = await publish(publisherA, oneBlob, [oneHash])
assertSuccess(oneResult, 'one-blob publish')
assert.equal(oneResult.blobhashSteps, 1, 'one-blob publish must execute BLOBHASH once')
assert.equal(await isPublished(publisherAHex, oneBlob), true)
const oneEvent = decodeSegmentEvent(oneResult)
assert.equal(oneEvent.eventName, 'SegmentPublished')
assert.deepEqual(oneEvent.args, {
  publisher: publisherAHex,
  streamIdHash: keccak256(stringToHex(oneBlob.streamId)),
  sequence: oneBlob.sequence,
  streamId: oneBlob.streamId,
  durationMs: oneBlob.durationMs,
  payloadBytes: oneBlob.payloadBytes,
  payloadSha256: oneBlob.payloadSha256,
  codec: oneBlob.codec,
  previousSegmentHash: oneBlob.previousSegmentHash,
  blobVersionedHashes: [oneHash],
})

const sixHashes = Array.from({ length: 6 }, (_, index) => versionedHash(index + 10))
const sixBlob = metadata({ sequence: 1n, blobCount: 6, payloadBytes: 761_856 })
const sixResult = await publish(publisherA, sixBlob, sixHashes)
assertSuccess(sixResult, 'six-blob publish')
assert.equal(sixResult.blobhashSteps, 6, 'six-blob publish must execute every production BLOBHASH')
assert.deepEqual(decodeSegmentEvent(sixResult).args.blobVersionedHashes, sixHashes)
assert.equal(await isPublished(publisherAHex, sixBlob), true)

const sevenHashes = Array.from({ length: 7 }, (_, index) => versionedHash(index + 30))
const sevenBlob = metadata({ sequence: 2n, blobCount: 7 })
const sevenResult = await publish(publisherA, sevenBlob, sevenHashes)
assertCustomError(sevenResult, 'InvalidBlobCount')
assert.equal(sevenResult.blobhashSteps, 0, 'seven boundary must reject before BLOBHASH')
assert.equal(await isPublished(publisherAHex, sevenBlob), false)

const missingBlob = metadata({ sequence: 3n, blobCount: 2 })
const missingResult = await publish(publisherA, missingBlob, [versionedHash(50)])
assertCustomError(missingResult, 'MissingBlob', [1n])
assert.equal(missingResult.blobhashSteps, 2, 'missing-blob path must execute the absent BLOBHASH index')
assert.equal(await isPublished(publisherAHex, missingBlob), false, 'MissingBlob must roll back the duplicate guard write')
const missingRetry = await publish(publisherA, missingBlob, [versionedHash(50), versionedHash(51)])
assertSuccess(missingRetry, 'retry after MissingBlob rollback')
assert.equal(await isPublished(publisherAHex, missingBlob), true)

const duplicateResult = await publish(publisherA, metadata({
  sequence: oneBlob.sequence,
  payloadSha256: `0x${'cd'.repeat(32)}`,
}), [versionedHash(60)])
assertCustomError(duplicateResult, 'DuplicateSegment', [
  publisherAHex,
  keccak256(stringToHex(oneBlob.streamId)),
  oneBlob.sequence,
])
assert.equal(duplicateResult.blobhashSteps, 0, 'duplicate must reject before BLOBHASH')

assert.equal(await isPublished(publisherBHex, oneBlob), false, 'publisher namespaces must begin independently')
const publisherBResult = await publish(publisherB, oneBlob, [versionedHash(61)])
assertSuccess(publisherBResult, 'same stream/sequence from second publisher')
assert.equal(await isPublished(publisherAHex, oneBlob), true)
assert.equal(await isPublished(publisherBHex, oneBlob), true)
const publisherBEvent = decodeSegmentEvent(publisherBResult)
assert.equal(publisherBEvent.args.publisher.toLowerCase(), publisherBHex)
assert.deepEqual(publisherBEvent.args.blobVersionedHashes, [versionedHash(61)])

console.log('Station Cancun EVM behavioral tests ok')
