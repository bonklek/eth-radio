import dotenv from 'dotenv'
import {
  commitmentToVersionedHash,
  createPublicClient,
  getAddress,
  http,
  parseEventLogs,
} from 'viem'
import { assertRpcChain, chainEndpointsFromEnv, chainFromEnv, chainNames, requireSupportedChain } from './chains.mjs'
import { resolveLatestBeaconSlot } from './lib/beacon-head.mjs'
import { bigintArg, numberArg, readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import { stationReadConfig } from './lib/station-deployment.mjs'
import { installEndpointSafeProcessHandlers } from './lib/endpoint-privacy.mjs'
import { fetchBoundedJson } from './lib/bounded-fetch.mjs'

const MAX_BLOBS_AFTER_BPO2 = 21
const MAX_BEACON_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_METRIC_SLOTS = 64
const MAX_STATION_HISTORY_BLOCKS = 250_000n
const STATION_LOG_RANGE_BLOCKS = 5_000n
const MAX_STATION_LOGS = 10_000

function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm slots:metrics -- [--slots 1..64] [--station 0x...] [--from-block <number>]

Environment:
  ETH_RPC_URL, BEACON_RPC_URL, CHAIN=${chainNames}, optional STATION_ADDRESS
`)
  process.exit(exitCode)
}

if (helpRequested()) usage(0)
dotenv.config({ quiet: true })

async function beacon(beaconUrl, pathname) {
  return fetchBoundedJson(`${beaconUrl}${pathname}`, {
    maxBytes: MAX_BEACON_RESPONSE_BYTES,
    timeoutMs: 10_000,
    label: `beacon response ${pathname}`,
  })
}

function assertBytes48Hex(value, label) {
  if (!/^0x[0-9a-fA-F]{96}$/.test(String(value || ''))) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
}

function sidecarIndex(value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return number
}

function assertBytes32Hex(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value || ''))) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
}

function transactionHash(value, label) {
  assertBytes32Hex(value, label)
  return String(value).toLowerCase()
}

function blobVersionedHashes(value, label) {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}: must be an array`)
  return value.map((hash) => {
    assertBytes32Hex(hash, label)
    return hash.toLowerCase()
  })
}

function stationSegmentBlobAttribution(log, index) {
  const args = log.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`SegmentPublished log ${index} args must be an object`)
  }
  if (typeof args.streamId !== 'string') throw new Error(`SegmentPublished log ${index} streamId must be a string`)
  if (typeof args.sequence !== 'bigint' || args.sequence < 0n) {
    throw new Error(`SegmentPublished log ${index} sequence must be a non-negative bigint`)
  }
  return {
    streamId: args.streamId,
    sequence: args.sequence.toString(),
    txHash: transactionHash(log.transactionHash, `SegmentPublished log ${index} transactionHash`),
    blobVersionedHashes: blobVersionedHashes(args.blobVersionedHashes, `SegmentPublished log ${index} blobVersionedHashes`),
  }
}

function beaconData(response, label) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || !('data' in response)) {
    throw new Error(`Invalid beacon ${label} response: missing data`)
  }
  return response.data
}

function beaconDataArray(response, label) {
  const data = beaconData(response, label)
  if (!Array.isArray(data)) throw new Error(`Invalid beacon ${label} response: data must be an array`)
  if (data.length > MAX_BLOBS_AFTER_BPO2) {
    throw new Error(`Invalid beacon ${label} response: exceeds ${MAX_BLOBS_AFTER_BPO2} entries`)
  }
  return data
}

function beaconGenesisTime(response) {
  const data = beaconData(response, 'genesis')
  const genesisTime = data?.genesis_time
  if (!/^\d+$/.test(String(genesisTime || ''))) {
    throw new Error('Invalid beacon genesis response: genesis_time must be a decimal string')
  }
  return BigInt(genesisTime)
}

const { chainName, chain } = chainFromEnv()
requireSupportedChain(chain)
const endpoints = chainEndpointsFromEnv(chainName)
const rpcUrl = endpoints.executionRpcUrl
const beaconUrl = endpoints.beaconRpcUrl.replace(/\/$/, '')
installEndpointSafeProcessHandlers(() => [rpcUrl, beaconUrl].filter(Boolean))
if (!rpcUrl || !beaconUrl) usage()

const stationConfig = stationReadConfig(chainName, {
  stationAddress: readArg('station', process.env.STATION_ADDRESS),
})
const station = stationConfig.stationAddress
const stationAbi = stationConfig.abi
const slots = numberArg('slots', '6', { integer: true, min: 1, max: MAX_METRIC_SLOTS })
const client = createPublicClient({ chain, transport: http(rpcUrl) })
await assertRpcChain(client, chain)

const [latestBlock, genesis] = await Promise.all([
  client.getBlock({ blockTag: 'latest' }),
  beacon(beaconUrl, '/eth/v1/beacon/genesis'),
])
const genesisTime = beaconGenesisTime(genesis)
const latestSlotResolution = await resolveLatestBeaconSlot({
  fetchHead: () => beacon(beaconUrl, '/eth/v1/beacon/headers/head'),
  latestExecutionTimestamp: latestBlock.timestamp,
  genesisTime,
})
const latestSlot = latestSlotResolution.slot
if (latestSlotResolution.warning) console.warn(latestSlotResolution.warning)
if (BigInt(slots - 1) > latestSlot) {
  throw new Error(`Requested ${slots} slots, but the resolved beacon head is only slot ${latestSlot}`)
}

const streamBlobHashes = new Map()
if (station && stationAbi) {
  const requestedFromBlock = bigintArg('from-block', stationConfig.fromBlock, { min: 0n })
  const earliestBoundedBlock = latestBlock.number >= MAX_STATION_HISTORY_BLOCKS - 1n
    ? latestBlock.number - MAX_STATION_HISTORY_BLOCKS + 1n
    : 0n
  const fromBlock = requestedFromBlock < earliestBoundedBlock ? earliestBoundedBlock : requestedFromBlock
  if (fromBlock !== requestedFromBlock) {
    console.warn(`Station attribution is limited to the latest ${MAX_STATION_HISTORY_BLOCKS} execution blocks; use a newer --from-block to narrow it further`)
  }
  const logs = []
  for (let rangeFrom = fromBlock; rangeFrom <= latestBlock.number; rangeFrom += STATION_LOG_RANGE_BLOCKS) {
    const rangeTo = rangeFrom + STATION_LOG_RANGE_BLOCKS - 1n < latestBlock.number
      ? rangeFrom + STATION_LOG_RANGE_BLOCKS - 1n
      : latestBlock.number
    const rangeLogs = await client.getLogs({
      address: getAddress(station),
      fromBlock: rangeFrom,
      toBlock: rangeTo,
    })
    if (!Array.isArray(rangeLogs)) throw new Error('Station attribution log response must be an array')
    if (rangeLogs.length > MAX_STATION_LOGS || logs.length + rangeLogs.length > MAX_STATION_LOGS) {
      throw new Error(`Station attribution exceeds ${MAX_STATION_LOGS} logs; provide a newer --from-block`)
    }
    logs.push(...rangeLogs)
  }
  const parsed = parseEventLogs({
    abi: stationAbi,
    eventName: 'SegmentPublished',
    logs,
  })

  parsed.map(stationSegmentBlobAttribution).forEach((segment) => {
    for (const hash of segment.blobVersionedHashes) {
      streamBlobHashes.set(hash, {
        streamId: segment.streamId,
        sequence: segment.sequence,
        txHash: segment.txHash,
      })
    }
  })
} else {
  console.warn('Station address is not configured; stream attribution is disabled')
}

const rows = []
for (let i = slots - 1; i >= 0; i--) {
  const slot = latestSlot - BigInt(i)
  let sidecars = []
  let error = null
  try {
    const result = await beacon(beaconUrl, `/eth/v1/beacon/blob_sidecars/${slot}`)
    sidecars = beaconDataArray(result, 'blob sidecars')
  } catch (err) {
    error = err.message
  }

  const blobs = sidecars.map((sidecar) => {
    const commitment = sidecar.kzg_commitment || sidecar.kzgCommitment
    if (commitment) assertBytes48Hex(commitment, 'sidecar KZG commitment')
    const versionedHash = commitment ? commitmentToVersionedHash({ commitment }) : null
    const stream = versionedHash ? streamBlobHashes.get(versionedHash) : null
    return {
      index: sidecarIndex(sidecar.index, 'sidecar index'),
      versionedHash,
      isStreamBlob: Boolean(stream),
      stream: stream || null,
    }
  })

  rows.push({
    slot: slot.toString(),
    blobCount: blobs.length,
    maxBlobs: MAX_BLOBS_AFTER_BPO2,
    streamBlobCount: blobs.filter((blob) => blob.isStreamBlob).length,
    blobs,
    error,
  })
}

console.log(JSON.stringify({
  chain: chainName,
  latestExecutionBlock: latestBlock.number.toString(),
  latestSlot: latestSlot.toString(),
  latestSlotSource: latestSlotResolution.source,
  latestSlotWarning: latestSlotResolution.warning,
  station: station || null,
  streamKnownBlobHashes: streamBlobHashes.size,
  rows,
}, null, 2))
