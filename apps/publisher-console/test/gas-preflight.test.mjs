import assert from 'node:assert/strict'
import { gasLimitDecision } from '../lib/gas-preflight.mjs'

const codeHash = `0x${'a'.repeat(64)}`
assert.equal(gasLimitDecision({ observations: [] }).allowed, false)
assert.equal(gasLimitDecision({
  observations: [{ provider: 'RPC 1', stationCodeHash: codeHash, estimateGas: '0' }],
}).allowed, false)
assert.deepEqual(gasLimitDecision({
  observations: [{ provider: 'RPC 1', stationCodeHash: codeHash, estimateGas: '80000' }],
}), {
  allowed: true,
  reason: null,
  maximumEstimateGas: 80000n,
  gasLimit: 100000n,
  disagreement: false,
  observations: [{ provider: 'RPC 1', stationCodeHash: codeHash, estimateGas: 80000n }],
})
const conservative = gasLimitDecision({ observations: [
  { provider: 'RPC 1', stationCodeHash: codeHash, estimateGas: '100001' },
  { provider: 'RPC 2', stationCodeHash: codeHash, estimateGas: '120000' },
] })
assert.equal(conservative.gasLimit, 150000n)
assert.equal(conservative.disagreement, true)
assert.equal(gasLimitDecision({ observations: [
  { provider: 'RPC 1', stationCodeHash: codeHash, estimateGas: '100000' },
  { provider: 'RPC 2', stationCodeHash: `0x${'b'.repeat(64)}`, estimateGas: '100000' },
] }).allowed, false)
assert.match(gasLimitDecision({
  observations: [{ provider: 'RPC 1', stationCodeHash: codeHash, estimateGas: '500000' }],
}).reason, /exceeds gas cap/)
assert.throws(() => gasLimitDecision({
  observations: [{ provider: 'RPC 1', stationCodeHash: codeHash, estimateGas: '-1' }],
}), /unsigned integer/)

console.log('publisher gas preflight tests ok')
