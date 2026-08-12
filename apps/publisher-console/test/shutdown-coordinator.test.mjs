import assert from 'node:assert/strict'
import {
  CHILD_FORCE_WAIT_MS,
  CHILD_GRACE_MS,
  coordinateChildShutdown,
} from '../lib/shutdown-coordinator.mjs'

assert.equal(CHILD_GRACE_MS, 12_000)
assert.equal(CHILD_FORCE_WAIT_MS, 2_000)
assert.ok(CHILD_GRACE_MS > 5_000)

const graceful = { encoder: null, publisher: null }
graceful.encoder = {
  pid: 1,
  kill(signal) {
    assert.equal(signal, 'SIGTERM')
    graceful.encoder = null
  },
}
assert.deepEqual(await coordinateChildShutdown(graceful, { graceMs: 1 }), {
  clean: true, escalated: false, ambiguous: [],
})

const escalated = { encoder: null, publisher: null }
escalated.publisher = {
  pid: 2,
  kill(signal) {
    if (signal === 'SIGKILL') escalated.publisher = null
  },
}
assert.deepEqual(await coordinateChildShutdown(escalated, { graceMs: 1, forceWaitMs: 1, sleep: async () => {} }), {
  clean: true, escalated: true, ambiguous: [],
})

const hung = { encoder: { pid: 3, kill() {} }, publisher: null }
assert.deepEqual(await coordinateChildShutdown(hung, { graceMs: 1, forceWaitMs: 1, sleep: async () => {} }), {
  clean: false,
  escalated: true,
  ambiguous: [{ role: 'encoder', pid: 3 }],
})

const throwing = { encoder: { pid: 4, kill() { throw new Error('kill failed') } }, publisher: null }
assert.equal((await coordinateChildShutdown(throwing, { graceMs: 1, forceWaitMs: 1, sleep: async () => {} })).clean, false)

console.log('publisher shutdown coordinator tests ok')
