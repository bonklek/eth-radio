import assert from 'node:assert/strict'
import { durableReserveThenSign } from '../lib/signing-coordinator.mjs'

const reservation = { intentDigest: 'ab'.repeat(32), reservedExposureWei: '100' }
const events = []
let durable = null
let signerCalls = 0

await assert.rejects(() => durableReserveThenSign({
  reservation,
  durableReserve(value) {
    durable = structuredClone(value)
    events.push('reserved')
  },
  afterDurableReserve() {
    events.push('fault')
    throw new Error('injected power loss')
  },
  sign() {
    signerCalls += 1
    return 'signed'
  },
  verify() {},
  durableCommit() {},
}), /injected power loss/)
assert.deepEqual(durable, reservation)
assert.equal(signerCalls, 0, 'the signer must not run before the durable fault boundary')
assert.deepEqual(events, ['reserved', 'fault'])

events.length = 0
await durableReserveThenSign({
  reservation,
  durableReserve() { events.push('reserved') },
  sign() { events.push('signed'); return 'signed-transaction' },
  verify() { events.push('verified') },
  durableCommit() { events.push('committed') },
})
assert.deepEqual(events, ['reserved', 'signed', 'verified', 'committed'])

events.length = 0
await assert.rejects(() => durableReserveThenSign({
  reservation,
  durableReserve() { events.push('reserved') },
  sign() { events.push('signed'); return 'hostile-transaction' },
  verify() { events.push('rejected'); throw new Error('intent mismatch') },
  durableCommit() { events.push('committed') },
}), /intent mismatch/)
assert.deepEqual(events, ['reserved', 'signed', 'rejected'], 'unverified signer output must never become durable authority')

console.log('publisher reserve-before-sign coordinator tests ok')
