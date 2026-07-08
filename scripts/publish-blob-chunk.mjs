import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadKZG } from 'kzg-wasm'
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  hexToBytes,
  http,
  keccak256,
  parseGwei,
  stringToBytes,
  zeroHash,
  toBlobs,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { assertRpcChain, chainFromEnv, chainNames, requireMainnetConfirmation, requireSupportedChain } from './chains.mjs'

function usage() {
  console.error(`Usage:
  pnpm blob:publish -- --input <file> [--stream-id demo] [--seq 0] [--duration-ms 6000] [--codec av1/webm]

Environment:
  ETH_RPC_URL, PRIVATE_KEY, CHAIN=${chainNames}, optional TO_ADDRESS, STATION_ADDRESS, GAS_LIMIT
`)
  process.exit(1)
}

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return process.argv[idx + 1]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getTransactionWithRetry(hash, attempts = 8, retryMs = 3000) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await publicClient.getTransaction({ hash })
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      console.warn(`getTransaction retry ${attempt}/${attempts} for ${hash}: ${error.shortMessage || error.message}`)
      await sleep(retryMs)
    }
  }
  throw lastError
}

const input = arg('input')
if (!input) usage()

const rpcUrl = process.env.ETH_RPC_URL
const privateKey = process.env.PRIVATE_KEY
const { chainName, chain } = chainFromEnv()

if (!rpcUrl || !privateKey) usage()
requireSupportedChain(chain)
requireMainnetConfirmation(chainName, 'publish blob transaction')

const inputPath = path.resolve(input)
const payload = fs.readFileSync(inputPath)
const streamId = arg('stream-id', `eth-radio-${new Date().toISOString()}`)
const sequence = Number(arg('seq', '0'))
const durationMs = Number(arg('duration-ms', '0'))
const codec = arg('codec', 'av1/webm')
const previousSegmentHash = arg('previous-hash', zeroHash)

const account = privateKeyToAccount(privateKey)
const to = process.env.TO_ADDRESS || account.address
const wasmKzg = await loadKZG()
const kzg = {
  blobToKzgCommitment(blob) {
    return hexToBytes(wasmKzg.blobToKzgCommitment(bytesToHex(blob)))
  },
  computeBlobKzgProof(blob, commitment) {
    return hexToBytes(wasmKzg.computeBlobKZGProof(bytesToHex(blob), bytesToHex(commitment)))
  },
}

const transport = http(rpcUrl, { timeout: 60_000 })
const publicClient = createPublicClient({ chain, transport })
const walletClient = createWalletClient({
  account,
  chain,
  transport,
})
await assertRpcChain(publicClient, chain)

const blobs = toBlobs({ data: bytesToHex(payload) })
if (blobs.length > 6) {
  throw new Error(`Input needs ${blobs.length} blobs. Start with <= 6 blobs per tx for the prototype.`)
}

const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex')
const stationAbi = [
  {
    type: 'function',
    name: 'publishSegment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'streamId', type: 'string' },
      { name: 'sequence', type: 'uint256' },
      { name: 'durationMs', type: 'uint64' },
      { name: 'payloadBytes', type: 'uint32' },
      { name: 'payloadSha256', type: 'bytes32' },
      { name: 'codec', type: 'string' },
      { name: 'previousSegmentHash', type: 'bytes32' },
      { name: 'blobCount', type: 'uint8' },
    ],
    outputs: [],
  },
]
const segmentPublishedEvent = {
  type: 'event',
  name: 'SegmentPublished',
  inputs: [
    { name: 'publisher', type: 'address', indexed: true },
    { name: 'streamIdHash', type: 'bytes32', indexed: true },
    { name: 'sequence', type: 'uint256', indexed: true },
    { name: 'streamId', type: 'string', indexed: false },
    { name: 'durationMs', type: 'uint64', indexed: false },
    { name: 'payloadBytes', type: 'uint32', indexed: false },
    { name: 'payloadSha256', type: 'bytes32', indexed: false },
    { name: 'codec', type: 'string', indexed: false },
    { name: 'previousSegmentHash', type: 'bytes32', indexed: false },
    { name: 'blobVersionedHashes', type: 'bytes32[]', indexed: false },
  ],
}

const stationAddress = arg('station-address', process.env.STATION_ADDRESS)
const data = stationAddress
  ? encodeFunctionData({
      abi: stationAbi,
      functionName: 'publishSegment',
      args: [
        streamId,
        BigInt(sequence),
        BigInt(durationMs),
        payload.length,
        `0x${payloadSha256}`,
        codec,
        previousSegmentHash,
        blobs.length,
      ],
    })
  : bytesToHex(
      Buffer.from(
        JSON.stringify({
          app: 'eth-radio',
          version: 1,
          streamId,
          sequence,
          durationMs,
          payloadBytes: payload.length,
          sha256: payloadSha256,
          codec,
          previousSegmentHash,
        }),
      ),
    )

const tx = {
  account,
  blobs,
  kzg,
  to: stationAddress || to,
  data,
}

if (process.env.MAX_FEE_PER_BLOB_GAS_GWEI) {
  tx.maxFeePerBlobGas = parseGwei(process.env.MAX_FEE_PER_BLOB_GAS_GWEI)
}
if (process.env.MAX_FEE_PER_GAS_GWEI) {
  tx.maxFeePerGas = parseGwei(process.env.MAX_FEE_PER_GAS_GWEI)
}
if (process.env.MAX_PRIORITY_FEE_PER_GAS_GWEI) {
  tx.maxPriorityFeePerGas = parseGwei(process.env.MAX_PRIORITY_FEE_PER_GAS_GWEI)
}
if (process.env.GAS_LIMIT) {
  tx.gas = BigInt(process.env.GAS_LIMIT)
}

console.log(`Publishing ${payload.length} bytes as ${blobs.length} blob(s) on ${chain.name}...`)
const hash = await walletClient.sendTransaction(tx)
console.log(`tx: ${hash}`)

const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') {
  throw new Error(`Transaction ${hash} was included but failed with status ${receipt.status}`)
}
const transaction = await getTransactionWithRetry(hash)
const streamIdHash = keccak256(stringToBytes(streamId))
if (stationAddress) {
  const stationEvent = receipt.logs
    .filter((log) => log.address.toLowerCase() === stationAddress.toLowerCase())
    .map((log) => {
      try {
        return decodeEventLog({ abi: [segmentPublishedEvent], data: log.data, topics: log.topics })
      } catch {
        return null
      }
    })
    .find((log) => {
      if (!log || log.eventName !== 'SegmentPublished') return false
      return (
        log.args.publisher.toLowerCase() === account.address.toLowerCase() &&
        log.args.streamIdHash === streamIdHash &&
        Number(log.args.sequence) === sequence
      )
    })
  if (!stationEvent) {
    throw new Error(`Transaction ${hash} did not emit Station SegmentPublished for ${streamId} seq ${sequence}`)
  }
}

const manifest = {
  app: 'eth-radio',
  version: 1,
  chain: chainName,
  streamId,
  sequence,
  durationMs,
  codec,
  input: inputPath,
  payloadBytes: payload.length,
  payloadSha256,
  previousSegmentHash,
  blobCount: blobs.length,
  stationAddress: stationAddress || null,
  txHash: hash,
  blockHash: receipt.blockHash,
  blockNumber: receipt.blockNumber.toString(),
  blobVersionedHashes: transaction.blobVersionedHashes || [],
  createdAt: new Date().toISOString(),
}

fs.mkdirSync('work/blob-radio-testnet/manifests', { recursive: true })
const out = path.resolve(
  `work/blob-radio-testnet/manifests/${streamId.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${sequence}.json`,
)
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`manifest: ${out}`)
