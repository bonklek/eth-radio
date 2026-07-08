import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, getAddress, http, parseEventLogs } from 'viem'
import { assertRpcChain, chainFromEnv, chainNames, requireSupportedChain } from './chains.mjs'

function usage() {
  console.error(`Usage:
  pnpm station:segments -- [--station 0x...] [--from-block <number>] [--to-block latest]

Environment:
  ETH_RPC_URL, CHAIN=${chainNames}, optional STATION_ADDRESS
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

const { chainName, chain } = chainFromEnv()
const rpcUrl = process.env.ETH_RPC_URL
if (!rpcUrl) usage()
requireSupportedChain(chain)

const deployment = loadDeployment(chainName)
const station = arg('station', process.env.STATION_ADDRESS || deployment?.address)
const abi = deployment?.abi
if (!station || !abi) usage()

const fromBlockArg = arg('from-block', deployment?.blockNumber || '0')
const toBlockArg = arg('to-block', 'latest')
const fromBlock = BigInt(fromBlockArg)
const toBlock = toBlockArg === 'latest' ? 'latest' : BigInt(toBlockArg)
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

const segments = parsed.map((log) => ({
  blockNumber: log.blockNumber.toString(),
  transactionHash: log.transactionHash,
  logIndex: log.logIndex,
  publisher: log.args.publisher,
  streamIdHash: log.args.streamIdHash,
  sequence: log.args.sequence.toString(),
  streamId: log.args.streamId,
  durationMs: Number(log.args.durationMs),
  payloadBytes: Number(log.args.payloadBytes),
  payloadSha256: log.args.payloadSha256,
  codec: log.args.codec,
  previousSegmentHash: log.args.previousSegmentHash,
  blobVersionedHashes: log.args.blobVersionedHashes,
}))

console.log(JSON.stringify({
  chain: chainName,
  station: getAddress(station),
  fromBlock: fromBlock.toString(),
  toBlock: toBlockArg,
  count: segments.length,
  segments,
}, null, 2))
