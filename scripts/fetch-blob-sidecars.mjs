import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { commitmentToVersionedHash, createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { readArg } from './lib/cli-args.mjs'

const chains = { sepolia }

function assertTxHash(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value || ''))) {
    throw new Error(`Invalid transaction hash: ${value}`)
  }
}

function assertBytes32Hex(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value || ''))) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
}

function assertBytes48Hex(value, label) {
  if (!/^0x[0-9a-fA-F]{96}$/.test(String(value || ''))) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
}

function normalizeBlobVersionedHashes(value, label) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}: must be an array`)
  return value.map((hash) => {
    assertBytes32Hex(hash, label)
    return hash.toLowerCase()
  })
}

function nonEmptyBlobVersionedHashes(value, label) {
  const hashes = normalizeBlobVersionedHashes(value, label)
  if (hashes !== undefined && hashes.length === 0) {
    throw new Error(`Invalid ${label}: must include at least one hash`)
  }
  return hashes
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
    throw new Error(`Invalid beacon genesis response: genesis_time must be a decimal string`)
  }
  return BigInt(genesisTime)
}

function readManifest(filePath) {
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid manifest ${filePath}: expected a JSON object`)
  }
  assertTxHash(manifest.txHash)
  const blobVersionedHashes = nonEmptyBlobVersionedHashes(
    manifest.blobVersionedHashes,
    `manifest ${filePath} blobVersionedHashes`,
  )
  if (blobVersionedHashes !== undefined) manifest.blobVersionedHashes = blobVersionedHashes
  return manifest
}

function transactionBlobVersionedHashes(tx, manifest) {
  const txHashes = nonEmptyBlobVersionedHashes(tx.blobVersionedHashes, 'transaction blobVersionedHashes')
  const hashes = txHashes ?? manifest?.blobVersionedHashes
  if (!hashes) throw new Error('Missing transaction blobVersionedHashes; provide a manifest with blobVersionedHashes')
  return hashes
}

function usage() {
  console.error(`Usage:
  pnpm blob:fetch -- --manifest <manifest.json>
  pnpm blob:fetch -- --tx 0x...

Environment:
  ETH_RPC_URL, BEACON_RPC_URL, CHAIN=sepolia
`)
  process.exit(1)
}

const chainName = process.env.CHAIN || 'sepolia'
const chain = chains[chainName]
const rpcUrl = process.env.ETH_RPC_URL
const beaconUrl = process.env.BEACON_RPC_URL?.replace(/\/$/, '')

if (!chain || !rpcUrl || !beaconUrl) usage()

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

let txHash = readArg('tx')
let manifest
const manifestArg = readArg('manifest')
if (manifestArg) {
  const manifestPath = path.resolve(manifestArg)
  manifest = readManifest(manifestPath)
  txHash = manifest.txHash
}
if (!txHash) usage()
assertTxHash(txHash)

async function beacon(pathname) {
  const response = await fetch(`${beaconUrl}${pathname}`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`)
  }
  return response.json()
}

const tx = await publicClient.getTransaction({ hash: txHash })
const block = await publicClient.getBlock({ blockHash: tx.blockHash })
const genesis = await beacon('/eth/v1/beacon/genesis')
const genesisTime = beaconGenesisTime(genesis)
const secondsPerSlot = 12n
const slot = (block.timestamp - genesisTime) / secondsPerSlot

console.log(`execution block: ${block.number} (${block.hash})`)
console.log(`estimated beacon slot: ${slot}`)

const sidecars = await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`)
const wanted = new Set(transactionBlobVersionedHashes(tx, manifest))
const matches = []

for (const sidecar of beaconDataArray(sidecars, 'blob sidecars')) {
  const commitment = sidecar.kzg_commitment || sidecar.kzgCommitment
  if (!commitment) continue
  assertBytes48Hex(commitment, 'sidecar KZG commitment')
  const versionedHash = commitmentToVersionedHash({ commitment })
  if (wanted.has(versionedHash)) {
    matches.push({ ...sidecar, versionedHash })
  }
}

fs.mkdirSync('work/blob-radio-testnet/sidecars', { recursive: true })
const out = path.resolve(`work/blob-radio-testnet/sidecars/${txHash}.json`)
fs.writeFileSync(out, `${JSON.stringify({ txHash, slot: slot.toString(), matches }, null, 2)}\n`)

console.log(`matched sidecars: ${matches.length}`)
console.log(`sidecars: ${out}`)
