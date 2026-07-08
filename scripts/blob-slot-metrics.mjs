import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import {
  commitmentToVersionedHash,
  createPublicClient,
  getAddress,
  http,
  parseEventLogs,
} from 'viem'
import { sepolia } from 'viem/chains'

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

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return process.argv[idx + 1]
}

function loadDeployment(chainName) {
  const deploymentPath = path.resolve(`work/blob-radio-testnet/contracts/Station.${chainName}.json`)
  if (!fs.existsSync(deploymentPath)) return null
  return JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
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

const chainName = process.env.CHAIN || 'sepolia'
const chain = chains[chainName]
const rpcUrl = process.env.ETH_RPC_URL
const beaconUrl = process.env.BEACON_RPC_URL?.replace(/\/$/, '')
if (!chain || !rpcUrl || !beaconUrl) usage()

const deployment = loadDeployment(chainName)
const station = arg('station', process.env.STATION_ADDRESS || deployment?.address)
const stationAbi = deployment?.abi
const slots = Number(arg('slots', '6'))
const client = createPublicClient({ chain, transport: http(rpcUrl) })

const latestBlock = await client.getBlock({ blockTag: 'latest' })
const genesis = await beacon(beaconUrl, '/eth/v1/beacon/genesis')
const genesisTime = BigInt(genesis.data.genesis_time)
const latestSlot = (latestBlock.timestamp - genesisTime) / 12n

const streamBlobHashes = new Map()
if (station && stationAbi) {
  const fromBlock = BigInt(arg('from-block', deployment?.blockNumber || '0'))
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

  for (const log of parsed) {
    for (const hash of log.args.blobVersionedHashes) {
      streamBlobHashes.set(hash, {
        streamId: log.args.streamId,
        sequence: log.args.sequence.toString(),
        txHash: log.transactionHash,
      })
    }
  }
}

const rows = []
for (let i = slots - 1; i >= 0; i--) {
  const slot = latestSlot - BigInt(i)
  let sidecars = []
  let error = null
  try {
    const result = await beacon(beaconUrl, `/eth/v1/beacon/blob_sidecars/${slot}`)
    sidecars = result.data || []
  } catch (err) {
    error = err.message
  }

  const blobs = sidecars.map((sidecar) => {
    const commitment = sidecar.kzg_commitment || sidecar.kzgCommitment
    const versionedHash = commitment ? commitmentToVersionedHash({ commitment }) : null
    const stream = versionedHash ? streamBlobHashes.get(versionedHash) : null
    return {
      index: Number(sidecar.index),
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
