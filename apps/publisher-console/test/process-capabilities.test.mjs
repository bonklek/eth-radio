import assert from 'node:assert/strict'
import { mediaProcessEnv, publisherProcessEnv } from '../lib/process-capabilities.mjs'

const source = {
  SystemRoot: 'C:\\Windows',
  PATH: 'C:\\Windows\\System32',
  PRIVATE_KEY: `0x${'12'.repeat(32)}`,
  ETH_RPC_URL: 'https://secret-rpc.example.test/key',
  BEACON_RPC_URL: 'https://secret-beacon.example.test/key',
  LIVE_INPUT_PASSWORD: 'ingest-canary',
  AWS_SECRET_ACCESS_KEY: 'cloud-canary',
  NODE_OPTIONS: '--require=hostile-module',
  PUBLISHER_FAULT_INJECT: 'console-after-reservation',
}

const media = mediaProcessEnv(source, { publisherAddress: '0x1111111111111111111111111111111111111111' })
assert.equal(media.RFE_PROCESS_ROLE, 'media')
assert.equal(media.RFE_PUBLISHER_ADDRESS, '0x1111111111111111111111111111111111111111')
for (const secret of ['PRIVATE_KEY', 'ETH_RPC_URL', 'BEACON_RPC_URL', 'LIVE_INPUT_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'PUBLISHER_FAULT_INJECT']) {
  assert.equal(secret in media, false, `media environment leaked ${secret}`)
}

const publisher = publisherProcessEnv(source)
assert.equal(publisher.RFE_PROCESS_ROLE, 'publisher')
assert.equal(publisher.PRIVATE_KEY, source.PRIVATE_KEY)
for (const secret of ['ETH_RPC_URL', 'BEACON_RPC_URL', 'LIVE_INPUT_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'PUBLISHER_FAULT_INJECT']) {
  assert.equal(secret in publisher, false, `publisher environment leaked ${secret}`)
}
assert.equal(publisherProcessEnv(source, { allowFaultInjection: true }).PUBLISHER_FAULT_INJECT, source.PUBLISHER_FAULT_INJECT)
assert.throws(() => publisherProcessEnv({ PATH: source.PATH }), /signer key is unavailable/)

console.log('publisher process capability tests ok')
