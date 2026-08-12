import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Common, Hardfork, Mainnet } from '@ethereumjs/common'
import { createEVM } from '@ethereumjs/evm'
import { createAddressFromString } from '@ethereumjs/util'
import solc from 'solc'
import {
  bytesToHex,
  decodeFunctionResult,
  encodeFunctionData,
  hexToBytes,
} from 'viem'
import { UINT256_MAX } from '../packages/protocol/constants.mjs'

const sourceName = 'FullPrecisionEconomicsHarness.sol'
const source = fs.readFileSync('contracts/test/FullPrecisionEconomicsHarness.sol', 'utf8')
const input = {
  language: 'Solidity',
  sources: { [sourceName]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error')
assert.deepEqual(errors, [], errors.map((entry) => entry.formattedMessage).join('\n'))
const compiled = output.contracts[sourceName].FullPrecisionEconomicsHarness
const abi = compiled.abi
const bytecode = `0x${compiled.evm.bytecode.object}`

const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun })
const evm = await createEVM({ common })
const caller = createAddressFromString(`0x${'11'.repeat(20)}`)
const deployment = await evm.runCall({
  caller,
  origin: caller,
  data: hexToBytes(bytecode),
  gasLimit: 30_000_000n,
  skipBalance: true,
})
assert.equal(deployment.execResult.exceptionError, undefined)
assert.ok(deployment.createdAddress)
const harness = deployment.createdAddress

async function call(functionName, args) {
  const result = await evm.runCall({
    to: harness,
    caller,
    origin: caller,
    data: hexToBytes(encodeFunctionData({ abi, functionName, args })),
    gasLimit: 30_000_000n,
    skipBalance: true,
    isStatic: true,
  })
  if (result.execResult.exceptionError) return { reverted: true }
  return {
    reverted: false,
    value: decodeFunctionResult({
      abi,
      functionName,
      data: bytesToHex(result.execResult.returnValue),
    }),
  }
}

const adversarial = [
  [UINT256_MAX - 1n, UINT256_MAX - 1n, UINT256_MAX],
  [UINT256_MAX, UINT256_MAX, UINT256_MAX],
  [UINT256_MAX, UINT256_MAX - 1n, UINT256_MAX],
  [1n << 255n, (1n << 255n) - 1n, UINT256_MAX],
  [(1n << 200n) + 123n, (1n << 180n) + 456n, (1n << 128n) + 789n],
]

for (let index = 1n; index <= 128n; index += 1n) {
  const x = (UINT256_MAX - index * 65_537n) & UINT256_MAX
  const y = ((1n << 255n) + index * 1_000_003n) & UINT256_MAX
  const denominator = UINT256_MAX - index * 97n
  adversarial.push([x, y, denominator])
}

for (const [x, y, denominator] of adversarial) {
  const numerator = x * y
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  const fits = quotient <= UINT256_MAX
  for (const [rounding, mode] of [[0, 'DOWN'], [1, 'UP'], [2, 'EXACT']]) {
    const response = await call('mulDiv', [x, y, denominator, rounding])
    const shouldRevert = !fits
      || (mode === 'EXACT' && remainder !== 0n)
      || (mode === 'UP' && remainder !== 0n && quotient === UINT256_MAX)
    assert.equal(response.reverted, shouldRevert, `${mode} revert mismatch for ${x}/${y}/${denominator}`)
    if (!shouldRevert) {
      const [value, evmQuotient, evmRemainder] = response.value
      const expectedValue = mode === 'UP' && remainder !== 0n ? quotient + 1n : quotient
      assert.equal(value, expectedValue)
      assert.equal(evmQuotient, quotient)
      assert.equal(evmRemainder, remainder)
    }
  }
}

const comparisons = [
  [UINT256_MAX, UINT256_MAX, UINT256_MAX, UINT256_MAX],
  [UINT256_MAX, UINT256_MAX - 1n, UINT256_MAX - 2n, UINT256_MAX],
  [1n << 255n, 2n, UINT256_MAX, 1n],
]
for (let index = 1n; index <= 128n; index += 1n) {
  comparisons.push([UINT256_MAX - index, index * 17n, UINT256_MAX - index * 2n, index * 19n])
}
for (const [a, b, c, d] of comparisons) {
  const response = await call('compareProducts', [a, b, c, d])
  assert.equal(response.reverted, false)
  const expected = a * b < c * d ? -1 : a * b > c * d ? 1 : 0
  assert.equal(Number(response.value), expected)
}

console.log('economics full-precision Solidity/EVM parity tests passed')
