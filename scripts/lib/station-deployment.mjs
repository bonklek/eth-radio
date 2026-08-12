import fs from 'node:fs'
import path from 'node:path'
import { readBoundedJsonFileSync } from './bounded-files.mjs'
import { stationAbi } from './station-abi.mjs'

export const MAX_STATION_DEPLOYMENT_BYTES = 1024 * 1024

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
    const deployment = readBoundedJsonFileSync(deploymentPath, {
      maxBytes: MAX_STATION_DEPLOYMENT_BYTES,
      label: `Station deployment metadata for ${chainName}`,
    })
    if (Array.isArray(deployment?.abi)) return deployment
    warn?.(`Ignoring invalid Station deployment metadata for ${chainName}: missing abi array`)
  } catch (error) {
    warn?.(`Ignoring unreadable Station deployment metadata for ${chainName}: ${error.message}`)
  }
  return null
}

export function stationReadConfig(chainName, { root = process.cwd(), stationAddress = '', warn = console.warn } = {}) {
  const deployment = loadStationDeployment(chainName, { root, warn })
  const explicitAddress = String(stationAddress || '').trim()
  const deploymentAddress = String(deployment?.address || '').trim()
  const explicitMatchesDeployment = explicitAddress
    && deploymentAddress
    && explicitAddress.toLowerCase() === deploymentAddress.toLowerCase()
  const useDeploymentMetadata = !explicitAddress || explicitMatchesDeployment
  return {
    stationAddress: explicitAddress || deploymentAddress,
    abi: useDeploymentMetadata && deployment?.abi ? deployment.abi : stationAbi,
    fromBlock: useDeploymentMetadata ? deployment?.blockNumber || '0' : '0',
    abiSource: useDeploymentMetadata && deployment?.abi ? 'deployment-metadata' : 'tracked-station-abi',
  }
}
