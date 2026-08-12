import { executionTimestampSlot } from '../../packages/protocol/availability.mjs'

export { executionTimestampSlot }

function responseData(response, label) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || !('data' in response)) {
    throw new Error(`Invalid beacon ${label} response: missing data`)
  }
  return response.data
}

export function beaconHeadSlot(response) {
  const value = responseData(response, 'head')?.header?.message?.slot
  if (!/^(0|[1-9]\d*)$/.test(String(value ?? ''))) {
    throw new Error('Invalid beacon head response: header.message.slot must be a decimal integer')
  }
  return BigInt(value)
}

export async function resolveLatestBeaconSlot({ fetchHead, latestExecutionTimestamp, genesisTime }) {
  try {
    return {
      slot: beaconHeadSlot(await fetchHead()),
      source: 'beacon-head',
      warning: null,
    }
  } catch (error) {
    return {
      slot: executionTimestampSlot(latestExecutionTimestamp, genesisTime),
      source: 'execution-head-timestamp-fallback',
      warning: `Beacon head unavailable; using the latest execution block timestamp as a potentially lagging slot fallback: ${error.message}`,
    }
  }
}
