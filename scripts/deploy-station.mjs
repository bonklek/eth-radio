import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { assertRpcChain, chainFromEnv, requireMainnetConfirmation, requireSupportedChain } from './chains.mjs'
import { compileStation } from './compile-station.mjs'

const rpcUrl = process.env.ETH_RPC_URL
const privateKey = process.env.PRIVATE_KEY
const { chainName, chain } = chainFromEnv()

if (!rpcUrl || !privateKey) {
  console.error('Missing ETH_RPC_URL, PRIVATE_KEY, or supported CHAIN in .env')
  process.exit(1)
}
requireSupportedChain(chain)
requireMainnetConfirmation(chainName, 'deploy Station')

const account = privateKeyToAccount(privateKey)
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })
const { abi, bytecode } = compileStation()

await assertRpcChain(publicClient, chain)
console.log(`Deploying Station from ${account.address} on ${chain.name}...`)
const hash = await walletClient.deployContract({ account, abi, bytecode })
console.log(`tx: ${hash}`)

const receipt = await publicClient.waitForTransactionReceipt({ hash })
if (!receipt.contractAddress) throw new Error('Deployment receipt did not include a contract address')

const deployment = {
  app: 'eth-radio',
  contract: 'Station',
  chain: chainName,
  address: receipt.contractAddress,
  txHash: hash,
  blockHash: receipt.blockHash,
  blockNumber: receipt.blockNumber.toString(),
  deployedAt: new Date().toISOString(),
  abi,
}

fs.mkdirSync('work/blob-radio-testnet/contracts', { recursive: true })
const out = path.resolve(`work/blob-radio-testnet/contracts/Station.${chainName}.json`)
fs.writeFileSync(out, `${JSON.stringify(deployment, null, 2)}\n`)

console.log(`address: ${receipt.contractAddress}`)
console.log(`deployment: ${out}`)
