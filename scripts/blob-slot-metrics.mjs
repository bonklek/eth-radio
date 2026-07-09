import 'dotenv/config'
import {
  commitmentToVersionedHash,
  createPublicClient,
  getAddress,
  http,
  parseEventLogs,
} from 'viem'
import { sepolia } from 'viem/chains'
import { bigintArg, numberArg, readArg } from './lib/cli-args.mjs'
import { loadStationDeployment } from './lib/station-deployment.mjs'

const chains = { sepolia }
const MAX_BLOBS_AFTER_BPO2 = 21

function usage() {
  console.error(`Usage:
  pnpm slots:metrics -- [--slots 6] [--station 0x...] [--from-block <number>]

Environment:
  ETH_RPC_URL, BEACON_RPC_URL, CHAIN=sepolia, optional STATION_ADDRESS
`)
  process.exit(1)
}

async function beacon(beaconUrl, pathname) {
  const response = await fetch(`${beaconUrl}${pathname}`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`)
  }
  return response.json()
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

const chainName = process.env.CHAIN || 'sepolia'
const chain = chains[chainName]
const rpcUrl = process.env.ETH_RPC_URL
const beaconUrl = process.env.BEACON_RPC_URL?.replace(/\/$/, '')
if (!chain || !rpcUrl || !beaconUrl) usage()

const deployment = loadStationDeployment(chainName)
const station = readArg('station', process.env.STATION_ADDRESS || deployment?.address)
const stationAbi = deployment?.abi
const slots = numberArg('slots', '6', { integer: true, min: 1 })
const client = createPublicClient({ chain, transport: http(rpcUrl) })

const latestBlock = await client.getBlock({ blockTag: 'latest' })
const genesis = await beacon(beaconUrl, '/eth/v1/beacon/genesis')
const genesisTime = beaconGenesisTime(genesis)
const latestSlot = (latestBlock.timestamp - genesisTime) / 12n

const streamBlobHashes = new Map()
if (station && stationAbi) {
  const fromBlock = bigintArg('from-block', deployment?.blockNumber || '0', { min: 0n })
  const logs = await client.getLogs({
    address: getAddress(station),
    fromBlock,
    toBlock: 'latest',
  })
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
  station: station || null,
  streamKnownBlobHashes: streamBlobHashes.size,
  rows,
}, null, 2))
