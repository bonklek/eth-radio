import assert from 'node:assert/strict'
import {
  PUBLISHER_STABLE_RUN_MS,
  publisherRestartDecision,
} from '../lib/restart-policy.mjs'

const base = Date.parse('2026-07-11T00:00:00.000Z')
let history = []
for (let index = 0; index < 4; index += 1) {
  const decision = publisherRestartDecision({
    history,
    cause: 'exit:1',
    exitedAt: new Date(base + index * 1000).toISOString(),
    runtimeMs: 1000,
  })
  assert.equal(decision.circuitOpen, false)
  history = decision.history
}
const terminal = publisherRestartDecision({
  history,
  cause: 'signal:SIGABRT',
  exitedAt: new Date(base + 5000).toISOString(),
  runtimeMs: 1000,
})
assert.equal(terminal.circuitOpen, true)
assert.equal(terminal.delayMs, null)
assert.match(terminal.reason, /reconcile durable signer and transaction state/)

const stableReset = publisherRestartDecision({
  history: terminal.history,
  cause: 'exit:1',
  exitedAt: new Date(base + PUBLISHER_STABLE_RUN_MS + 10_000).toISOString(),
  runtimeMs: PUBLISHER_STABLE_RUN_MS,
})
assert.equal(stableReset.circuitOpen, false)
assert.equal(stableReset.history.length, 1)
assert.equal(stableReset.delayMs, 2000)

const expiredWindow = publisherRestartDecision({
  history: terminal.history,
  cause: 'exit:2',
  exitedAt: new Date(base + 11 * 60 * 1000).toISOString(),
  runtimeMs: 1000,
})
assert.equal(expiredWindow.history.length, 1)
assert.throws(() => publisherRestartDecision({ history: [], cause: '', exitedAt: 'bad', runtimeMs: -1 }))

console.log('publisher restart policy tests ok')
