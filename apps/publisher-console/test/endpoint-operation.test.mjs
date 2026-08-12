import assert from 'node:assert/strict'
import {
  firstSuccessfulEndpoint,
  MAX_EXECUTION_ENDPOINTS,
  settleEndpointOperation,
} from '../lib/endpoint-operation.mjs'

const delay = (ms, value, { reject = false } = {}) => new Promise((resolve, fail) => {
  setTimeout(() => reject ? fail(value) : resolve(value), ms)
})

await assert.rejects(
  () => firstSuccessfulEndpoint(Array(MAX_EXECUTION_ENDPOINTS + 1).fill('rpc'), () => 'unused'),
  /exceeds maximum/,
)

const mixed = await settleEndpointOperation(['accepted', 'rejected', 'slow'], (endpoint) => {
  if (endpoint === 'accepted') return delay(5, 'tx hash')
  if (endpoint === 'rejected') return delay(2, new Error('rejected'), { reject: true })
  return delay(500, 'late')
}, { deadlineMs: 30, concurrency: 3 })
assert.equal(mixed.deadlineExceeded, true)
assert.deepEqual(mixed.results.slice(0, 2).map((result) => result.status), ['fulfilled', 'rejected'])
assert.equal(mixed.results[2].status, 'rejected')

const boundedConcurrency = { current: 0, maximum: 0 }
const settled = await settleEndpointOperation(['a', 'b', 'c', 'd'], async (endpoint) => {
  boundedConcurrency.current += 1
  boundedConcurrency.maximum = Math.max(boundedConcurrency.maximum, boundedConcurrency.current)
  await delay(5, endpoint)
  boundedConcurrency.current -= 1
  return endpoint
}, { deadlineMs: 100, concurrency: 2 })
assert.equal(settled.deadlineExceeded, false)
assert.equal(boundedConcurrency.maximum, 2)
assert.deepEqual(settled.results.map((result) => result.value), ['a', 'b', 'c', 'd'])

const started = Date.now()
const fast = await firstSuccessfulEndpoint(['slow', 'fast'], async (endpoint, { signal }) => {
  if (endpoint === 'slow') return delay(500, 'too late')
  assert.equal(signal.aborted, false)
  return delay(10, 'fast result')
}, { deadlineMs: 100, concurrency: 2 })
assert.equal(fast, 'fast result')
assert.ok(Date.now() - started < 200, 'slow-first endpoint must not serialize a faster fallback')

await assert.rejects(
  () => firstSuccessfulEndpoint(['a', 'b'], () => delay(500, 'late'), { deadlineMs: 30, concurrency: 2 }),
  /aggregate deadline/,
)

const aborted = []
const winner = await firstSuccessfulEndpoint(['winner', 'peer'], (endpoint, { signal }) => {
  signal.addEventListener('abort', () => aborted.push(endpoint), { once: true })
  return endpoint === 'winner' ? delay(5, 'ok') : delay(500, 'late')
}, { deadlineMs: 100, concurrency: 2 })
assert.equal(winner, 'ok')
await delay(0)
assert.ok(aborted.includes('peer'), 'logical peer work must receive cancellation')

await assert.rejects(
  () => firstSuccessfulEndpoint(['a', 'b'], (endpoint) => delay(1, new Error(endpoint), { reject: true })),
  (error) => error instanceof AggregateError && error.errors.length === 2,
)

console.log('publisher endpoint operation tests ok')
