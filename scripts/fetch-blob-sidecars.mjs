import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { commitmentToVersionedHash, createPublicClient, http } from 'viem'
import { assertRpcChain, chainEndpointsFromEnv, chainFromEnv, chainNames, requireSupportedChain } from './chains.mjs'
import { executionTimestampSlot } from './lib/beacon-head.mjs'
import { assertCompleteBlobSidecarMatches } from './lib/blob-sidecar-matches.mjs'
import { readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import { installEndpointSafeProcessHandlers } from './lib/endpoint-privacy.mjs'
import { readBoundedJsonFileSync } from './lib/bounded-files.mjs'
import { fetchBoundedJson } from './lib/bounded-fetch.mjs'

const MAX_PUBLISHER_MANIFEST_BYTES = 1024 * 1024
const MAX_BEACON_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_BEACON_SIDECARS = 21

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
  if (data.length > MAX_BEACON_SIDECARS) {
    throw new Error(`Invalid beacon ${label} response: exceeds ${MAX_BEACON_SIDECARS} entries`)
  }
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
  const manifest = readBoundedJsonFileSync(filePath, {
    maxBytes: MAX_PUBLISHER_MANIFEST_BYTES,
    label: `manifest ${filePath}`,
  })
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

function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm blob:fetch -- --manifest <manifest.json>
  pnpm blob:fetch -- --tx 0x...

Environment:
  ETH_RPC_URL, BEACON_RPC_URL, CHAIN=${chainNames}
`)
  process.exit(exitCode)
}

if (helpRequested()) usage(0)
dotenv.config({ quiet: true })

const { chainName, chain } = chainFromEnv()
requireSupportedChain(chain)
const endpoints = chainEndpointsFromEnv(chainName)
const rpcUrl = endpoints.executionRpcUrl
const beaconUrl = endpoints.beaconRpcUrl.replace(/\/$/, '')
installEndpointSafeProcessHandlers(() => [rpcUrl, beaconUrl].filter(Boolean))

if (!rpcUrl || !beaconUrl) usage()

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

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
await assertRpcChain(publicClient, chain)

async function beacon(pathname) {
  return fetchBoundedJson(`${beaconUrl}${pathname}`, {
    maxBytes: MAX_BEACON_RESPONSE_BYTES,
    timeoutMs: 10_000,
    label: `beacon response ${pathname}`,
  })
}

const tx = await publicClient.getTransaction({ hash: txHash })
const block = await publicClient.getBlock({ blockHash: tx.blockHash })
const genesis = await beacon('/eth/v1/beacon/genesis')
const genesisTime = beaconGenesisTime(genesis)
const slot = executionTimestampSlot(block.timestamp, genesisTime)

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

assertCompleteBlobSidecarMatches(wanted, matches)
fs.mkdirSync('work/blob-radio-testnet/sidecars', { recursive: true })
const out = path.resolve(`work/blob-radio-testnet/sidecars/${txHash}.json`)
fs.writeFileSync(out, `${JSON.stringify({ txHash, slot: slot.toString(), matches }, null, 2)}\n`)

console.log(`matched sidecars: ${matches.length}`)
console.log(`sidecars: ${out}`)
