import dotenv from 'dotenv'
import { createPublicClient, formatEther, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { assertRpcChain, chainFromEnv, requireSupportedChain } from './chains.mjs'
import { installEndpointSafeProcessHandlers } from './lib/endpoint-privacy.mjs'
import { helpRequested } from './lib/cli-help.mjs'

if (helpRequested()) {
  console.log(`Usage:
  pnpm wallet:balance

Environment:
  ETH_RPC_URL, PRIVATE_KEY, CHAIN=sepolia|mainnet
`)
  process.exit(0)
}
dotenv.config({ quiet: true })
installEndpointSafeProcessHandlers(() => [process.env.ETH_RPC_URL].filter(Boolean))

if (!process.env.PRIVATE_KEY || !process.env.ETH_RPC_URL) {
  console.error('Missing PRIVATE_KEY or ETH_RPC_URL in .env')
  process.exit(1)
}

const account = privateKeyToAccount(/** @type {`0x${string}`} */ (process.env.PRIVATE_KEY))
const { chainName, chain } = chainFromEnv()
requireSupportedChain(chain)
const client = createPublicClient({ chain, transport: http(process.env.ETH_RPC_URL) })
const [chainId, blockNumber, balance] = await Promise.all([
  assertRpcChain(client, chain),
  client.getBlockNumber(),
  client.getBalance({ address: account.address }),
])

console.log(JSON.stringify({
  address: account.address,
  chain: chainName,
  chainId,
  blockNumber: blockNumber.toString(),
  balanceEth: formatEther(balance),
}, null, 2))
