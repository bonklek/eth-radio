import fs from 'node:fs'
import path from 'node:path'

function assertSafeDeploymentChainName(chainName) {
  if (/^[a-z0-9_-]+$/i.test(String(chainName || ''))) return
  throw new Error(`Invalid Station deployment chain name: ${chainName}`)
}

export function stationDeploymentPath(chainName, root = process.cwd()) {
  assertSafeDeploymentChainName(chainName)
  return path.resolve(root, 'work', 'blob-radio-testnet', 'contracts', `Station.${chainName}.json`)
}

export function loadStationDeployment(chainName, { root = process.cwd(), warn = console.warn } = {}) {
  const deploymentPath = stationDeploymentPath(chainName, root)
  if (!fs.existsSync(deploymentPath)) return null
  try {
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
    if (Array.isArray(deployment?.abi)) return deployment
    warn?.(`Ignoring invalid Station deployment metadata for ${chainName}: missing abi array`)
  } catch (error) {
    warn?.(`Ignoring unreadable Station deployment metadata for ${chainName}: ${error.message}`)
  }
  return null
}
