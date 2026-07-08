import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { commitmentToVersionedHash, createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'

const chains = { sepolia }

function usage() {
  console.error(`Usage:
  pnpm blob:fetch -- --manifest <manifest.json>
  pnpm blob:fetch -- --tx 0x...

Environment:
  ETH_RPC_URL, BEACON_RPC_URL, CHAIN=sepolia
`)
  process.exit(1)
}

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return process.argv[idx + 1]
}

const chainName = process.env.CHAIN || 'sepolia'
const chain = chains[chainName]
const rpcUrl = process.env.ETH_RPC_URL
const beaconUrl = process.env.BEACON_RPC_URL?.replace(/\/$/, '')

if (!chain || !rpcUrl || !beaconUrl) usage()

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

let txHash = arg('tx')
let manifest
if (arg('manifest')) {
  const manifestPath = path.resolve(arg('manifest'))
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  txHash = manifest.txHash
}
if (!txHash) usage()

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
const genesisTime = BigInt(genesis.data.genesis_time)
const secondsPerSlot = 12n
const slot = (block.timestamp - genesisTime) / secondsPerSlot

console.log(`execution block: ${block.number} (${block.hash})`)
console.log(`estimated beacon slot: ${slot}`)

const sidecars = await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`)
const wanted = new Set(tx.blobVersionedHashes || manifest?.blobVersionedHashes || [])
const matches = []

for (const sidecar of sidecars.data || []) {
  const commitment = sidecar.kzg_commitment || sidecar.kzgCommitment
  if (!commitment) continue
  const versionedHash = commitmentToVersionedHash({ commitment })
  if (wanted.size === 0 || wanted.has(versionedHash)) {
    matches.push({ ...sidecar, versionedHash })
  }
}

fs.mkdirSync('work/blob-radio-testnet/sidecars', { recursive: true })
const out = path.resolve(`work/blob-radio-testnet/sidecars/${txHash}.json`)
fs.writeFileSync(out, `${JSON.stringify({ txHash, slot: slot.toString(), matches }, null, 2)}\n`)

console.log(`matched sidecars: ${matches.length}`)
console.log(`sidecars: ${out}`)
