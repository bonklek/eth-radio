import 'dotenv/config'
import { createPublicClient, formatEther, http } from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

if (!process.env.PRIVATE_KEY || !process.env.ETH_RPC_URL) {
  console.error('Missing PRIVATE_KEY or ETH_RPC_URL in .env')
  process.exit(1)
}

const account = privateKeyToAccount(process.env.PRIVATE_KEY)
const client = createPublicClient({ chain: sepolia, transport: http(process.env.ETH_RPC_URL) })
const [chainId, blockNumber, balance] = await Promise.all([
  client.getChainId(),
  client.getBlockNumber(),
  client.getBalance({ address: account.address }),
])

console.log(JSON.stringify({
  address: account.address,
  chainId,
  blockNumber: blockNumber.toString(),
  balanceEth: formatEther(balance),
}, null, 2))
