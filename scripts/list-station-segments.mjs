import 'dotenv/config'
import { createPublicClient, getAddress, http, parseEventLogs } from 'viem'
import { assertRpcChain, chainFromEnv, chainNames, requireSupportedChain } from './chains.mjs'
import { bigintArg, readArg } from './lib/cli-args.mjs'
import { loadStationDeployment } from './lib/station-deployment.mjs'

function usage() {
  console.error(`Usage:
  pnpm station:segments -- [--station 0x...] [--from-block <number>] [--to-block latest]

Environment:
  ETH_RPC_URL, CHAIN=${chainNames}, optional STATION_ADDRESS
`)
  process.exit(1)
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return value
}

function nonNegativeBigint(value, label) {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new Error(`${label} must be a non-negative bigint`)
  }
  return value
}

function nonNegativeSafeNumber(value, label) {
  if (typeof value === 'bigint') {
    const number = Number(value)
    if (Number.isSafeInteger(number) && number >= 0) return number
  }
  return nonNegativeInteger(value, label)
}

function bytes32(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value))) {
    throw new Error(`${label} must be 0x-prefixed bytes32`)
  }
  return String(value).toLowerCase()
}

function normalizeBlobVersionedHashes(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((hash, index) => bytes32(hash, `${label}[${index}]`))
}

function compareDecimalBigintStrings(left, right, label) {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  if (leftValue < 0n || rightValue < 0n) throw new Error(`${label} must be non-negative`)
  if (leftValue < rightValue) return -1
  if (leftValue > rightValue) return 1
  return 0
}

function stationSegment(log, index) {
  const args = log.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`SegmentPublished log ${index} args must be an object`)
  }
  const sequence = nonNegativeBigint(args.sequence, `SegmentPublished log ${index} sequence`)
  if (typeof args.streamId !== 'string') throw new Error(`SegmentPublished log ${index} streamId must be a string`)
  if (typeof args.codec !== 'string') throw new Error(`SegmentPublished log ${index} codec must be a string`)
  return {
    blockNumber: log.blockNumber.toString(),
    transactionHash: log.transactionHash,
    transactionIndex: nonNegativeInteger(log.transactionIndex, `SegmentPublished log ${index} transactionIndex`),
    logIndex: nonNegativeInteger(log.logIndex, `SegmentPublished log ${index} logIndex`),
    publisher: getAddress(args.publisher),
    streamIdHash: bytes32(args.streamIdHash, `SegmentPublished log ${index} streamIdHash`),
    sequence: sequence.toString(),
    streamId: args.streamId,
    durationMs: nonNegativeSafeNumber(args.durationMs, `SegmentPublished log ${index} durationMs`),
    payloadBytes: nonNegativeSafeNumber(args.payloadBytes, `SegmentPublished log ${index} payloadBytes`),
    payloadSha256: bytes32(args.payloadSha256, `SegmentPublished log ${index} payloadSha256`),
    codec: args.codec,
    previousSegmentHash: bytes32(args.previousSegmentHash, `SegmentPublished log ${index} previousSegmentHash`),
    blobVersionedHashes: normalizeBlobVersionedHashes(args.blobVersionedHashes, `SegmentPublished log ${index} blobVersionedHashes`),
  }
}

const { chainName, chain } = chainFromEnv()
const rpcUrl = process.env.ETH_RPC_URL
if (!rpcUrl) usage()
requireSupportedChain(chain)

const deployment = loadStationDeployment(chainName)
const station = readArg('station', process.env.STATION_ADDRESS || deployment?.address)
const abi = deployment?.abi
if (!station || !abi) usage()

const fromBlock = bigintArg('from-block', deployment?.blockNumber || '0', { min: 0n })
const toBlockArg = readArg('to-block', 'latest')
const toBlock = toBlockArg === 'latest' ? 'latest' : bigintArg('to-block', toBlockArg, { min: 0n })
const client = createPublicClient({ chain, transport: http(rpcUrl) })
await assertRpcChain(client, chain)

const logs = await client.getLogs({
  address: getAddress(station),
  fromBlock,
  toBlock,
})

const parsed = parseEventLogs({
  abi,
  eventName: 'SegmentPublished',
  logs,
})

const segments = parsed.map(stationSegment).sort(
  (a, b) =>
    a.streamId.localeCompare(b.streamId) ||
    (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0) ||
    compareDecimalBigintStrings(a.blockNumber, b.blockNumber, 'SegmentPublished blockNumber') ||
    a.transactionIndex - b.transactionIndex ||
    a.logIndex - b.logIndex,
)

console.log(JSON.stringify({
  chain: chainName,
  station: getAddress(station),
  fromBlock: fromBlock.toString(),
  toBlock: toBlockArg,
  count: segments.length,
  segments,
}, null, 2))
