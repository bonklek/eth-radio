import { mainnet, sepolia } from 'viem/chains'

export const chains = { sepolia, mainnet }
export const chainNames = Object.keys(chains).join('|')

export function chainFromEnv() {
  const chainName = process.env.CHAIN || 'sepolia'
  return { chainName, chain: chains[chainName] }
}

export function requireSupportedChain(chain) {
  if (!chain) {
    console.error(`Unsupported CHAIN. Choose one of: ${chainNames}`)
    process.exit(1)
  }
}

export function requireMainnetConfirmation(chainName, action) {
  if (chainName !== 'mainnet') return
  const phrase = 'I understand this spends real ETH'
  if (process.env.MAINNET_CONFIRM !== phrase) {
    console.error(`Refusing to ${action} on mainnet without MAINNET_CONFIRM="${phrase}"`)
    process.exit(1)
  }
}

export async function assertRpcChain(client, expectedChain) {
  const chainId = await client.getChainId()
  if (chainId !== expectedChain.id) {
    throw new Error(`RPC chain mismatch: expected ${expectedChain.id} (${expectedChain.name}), got ${chainId}`)
  }
  return chainId
}
