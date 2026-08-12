import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireSignerCoordinatorLease, signerCoordinatorEndpoint } from '../lib/signer-coordinator.mjs'

const identity = {
  chainId: 11155111,
  publisher: '0x1111111111111111111111111111111111111111',
}
const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rfe-signer-coordinator-'))
const stateA = path.join(registryRoot, 'job-a-state.json')
const stateB = path.join(registryRoot, 'job-b-state.json')
assert.equal(signerCoordinatorEndpoint(identity), signerCoordinatorEndpoint({
  ...identity,
  publisher: identity.publisher.toUpperCase(),
}))
assert.notEqual(signerCoordinatorEndpoint(identity), signerCoordinatorEndpoint({ ...identity, chainId: 1 }))
assert.notEqual(signerCoordinatorEndpoint(identity), signerCoordinatorEndpoint({
  ...identity,
  publisher: '0x2222222222222222222222222222222222222222',
}))

const first = await acquireSignerCoordinatorLease({ ...identity, statePath: stateA, registryRoot })
await assert.rejects(() => acquireSignerCoordinatorLease({ ...identity, statePath: stateA, registryRoot }), /already held or unavailable/)
const otherChain = await acquireSignerCoordinatorLease({ ...identity, chainId: 1, statePath: stateB, registryRoot })
await otherChain.release({ clearOwnership: true })
await first.release()
await assert.rejects(
  () => acquireSignerCoordinatorLease({ ...identity, statePath: stateB, registryRoot }),
  /unreconciled durable ownership/,
)
const resumedOwner = await acquireSignerCoordinatorLease({ ...identity, statePath: stateA, registryRoot })
await resumedOwner.release({ clearOwnership: true })
const afterReconcile = await acquireSignerCoordinatorLease({ ...identity, statePath: stateB, registryRoot })
await afterReconcile.release({ clearOwnership: true })
fs.rmSync(registryRoot, { recursive: true, force: true })

console.log('publisher signer coordinator tests ok')
