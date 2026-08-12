import assert from 'node:assert/strict'
import {
  checkedAdd,
  checkedMultiply,
  checkedSubtract,
  compareRatios,
  divideWithRounding,
  multiplyByRatio,
  normalizeRatio,
} from '../packages/economics/index.mjs'
import { UINT256_MAX } from '../packages/protocol/constants.mjs'

assert.deepEqual(normalizeRatio({ numerator: '6', denominator: '8' }), {
  numerator: '3',
  denominator: '4',
})
assert.deepEqual(normalizeRatio({ numerator: '0', denominator: UINT256_MAX.toString() }), {
  numerator: '0',
  denominator: '1',
})
assert.throws(() => normalizeRatio({ numerator: '1', denominator: '0' }), /greater than zero/)
assert.throws(() => normalizeRatio({ numerator: '01', denominator: '2' }), /canonical/)
assert.throws(() => normalizeRatio({ numerator: '1' }), /denominator must be an own property/)
assert.throws(
  () => normalizeRatio({ numerator: '1', denominator: '2', unit: 'wei' }),
  /unit is not supported/,
)
const symbolDecoratedRatio = { numerator: '1', denominator: '2' }
symbolDecoratedRatio[Symbol('hidden')] = 'not canonical'
assert.throws(() => normalizeRatio(symbolDecoratedRatio), /must not contain symbol keys/)
const accessorRatio = { numerator: '1' }
let ratioGetterCalled = false
Object.defineProperty(accessorRatio, 'denominator', {
  enumerable: true,
  get() {
    ratioGetterCalled = true
    return '2'
  },
})
assert.throws(() => normalizeRatio(accessorRatio), /enumerable data property/)
assert.equal(ratioGetterCalled, false)
const hiddenRatio = { numerator: '1' }
Object.defineProperty(hiddenRatio, 'denominator', { enumerable: false, value: '2' })
assert.throws(() => normalizeRatio(hiddenRatio), /enumerable data property/)

assert.equal(checkedAdd('2', '3'), '5')
assert.equal(checkedSubtract('3', '2'), '1')
assert.equal(checkedMultiply('7', '6'), '42')
assert.throws(() => checkedAdd(UINT256_MAX.toString(), '1'), /exceeds/)
assert.throws(() => checkedSubtract('2', '3'), /must not be negative/)
assert.throws(() => checkedMultiply(UINT256_MAX.toString(), '2'), /exceeds/)

assert.deepEqual(divideWithRounding('10', '4', { rounding: 'DOWN' }), {
  value: '2', remainder: '2', rounded: true, rounding: 'DOWN',
})
assert.deepEqual(divideWithRounding('10', '4', { rounding: 'UP' }), {
  value: '3', remainder: '2', rounded: true, rounding: 'UP',
})
assert.deepEqual(divideWithRounding('12', '4', { rounding: 'EXACT' }), {
  value: '3', remainder: '0', rounded: false, rounding: 'EXACT',
})
assert.throws(() => divideWithRounding('10', '4', { rounding: 'EXACT' }), /not exactly divisible/)
assert.throws(() => divideWithRounding('1', '0', { rounding: 'UP' }), /greater than zero/)
assert.throws(() => divideWithRounding('1', '2', {}), /must be DOWN, UP, or EXACT/)

assert.deepEqual(multiplyByRatio('5', { numerator: '3', denominator: '2' }, { rounding: 'DOWN' }), {
  value: '7',
  rounded: true,
  roundingReceipt: {
    originalNumerator: '15', originalDenominator: '2', quotient: '7', remainder: '1', roundingMode: 'DOWN',
  },
})
assert.deepEqual(multiplyByRatio('5', { numerator: '3', denominator: '2' }, { rounding: 'UP' }), {
  value: '8',
  rounded: true,
  roundingReceipt: {
    originalNumerator: '15', originalDenominator: '2', quotient: '7', remainder: '1', roundingMode: 'UP',
  },
})
assert.deepEqual(
  multiplyByRatio(UINT256_MAX.toString(), { numerator: '1', denominator: UINT256_MAX.toString() }, { rounding: 'EXACT' }),
  {
    value: '1',
    rounded: false,
    roundingReceipt: {
      originalNumerator: UINT256_MAX.toString(),
      originalDenominator: UINT256_MAX.toString(),
      quotient: '1',
      remainder: '0',
      roundingMode: 'EXACT',
    },
  },
)
assert.throws(
  () => multiplyByRatio(UINT256_MAX.toString(), { numerator: '2', denominator: '1' }, { rounding: 'DOWN' }),
  /exceeds/,
)
assert.deepEqual(
  multiplyByRatio('100', { numerator: '1', denominator: '100' }, {
    rounding: 'EXACT',
    amountMaximum: 100n,
    resultMaximum: 10n,
  }),
  {
    value: '1',
    rounded: false,
    roundingReceipt: {
      originalNumerator: '100',
      originalDenominator: '100',
      quotient: '1',
      remainder: '0',
      roundingMode: 'EXACT',
    },
  },
)
assert.throws(
  () => multiplyByRatio('100', { numerator: '1', denominator: '100' }, {
    rounding: 'EXACT',
    amountMaximum: 99n,
    resultMaximum: 10n,
  }),
  /amount must be at most 99/,
)
assert.throws(
  () => multiplyByRatio('100', { numerator: '1', denominator: '2' }, {
    rounding: 'EXACT',
    amountMaximum: 100n,
    resultMaximum: 49n,
  }),
  /exceeds/,
)
assert.deepEqual(
  multiplyByRatio('6', { numerator: '1', denominator: '4' }, { rounding: 'DOWN' }).roundingReceipt,
  {
    originalNumerator: '6',
    originalDenominator: '4',
    quotient: '1',
    remainder: '2',
    roundingMode: 'DOWN',
  },
)

assert.equal(compareRatios({ numerator: '1', denominator: '3' }, { numerator: '2', denominator: '6' }), 0)
assert.equal(compareRatios({ numerator: '1', denominator: '3' }, { numerator: '1', denominator: '2' }), -1)
assert.equal(compareRatios({ numerator: '3', denominator: '4' }, { numerator: '2', denominator: '3' }), 1)

for (let index = 1n; index <= 10_000n; index += 1n) {
  const numerator = index * 17n + 3n
  const denominator = index % 97n + 1n
  const down = divideWithRounding(numerator.toString(), denominator.toString(), { rounding: 'DOWN' })
  const up = divideWithRounding(numerator.toString(), denominator.toString(), { rounding: 'UP' })
  assert.equal(BigInt(down.value), numerator / denominator)
  assert.equal(BigInt(up.value), (numerator + denominator - 1n) / denominator)
  assert.equal(BigInt(up.value) - BigInt(down.value) <= 1n, true)

  const ratio = normalizeRatio({ numerator: numerator.toString(), denominator: denominator.toString() })
  assert.equal(
    BigInt(ratio.numerator) * denominator,
    numerator * BigInt(ratio.denominator),
  )
  assert.deepEqual(normalizeRatio(ratio), ratio)

  const scaledDown = multiplyByRatio(index.toString(), ratio, { rounding: 'DOWN' })
  const scaledUp = multiplyByRatio(index.toString(), ratio, { rounding: 'UP' })
  const exactNumerator = index * numerator
  assert.equal(BigInt(scaledDown.value), exactNumerator / denominator)
  assert.equal(BigInt(scaledUp.value), (exactNumerator + denominator - 1n) / denominator)
  assert.equal(BigInt(scaledDown.roundingReceipt.originalNumerator), index * BigInt(ratio.numerator))
  assert.equal(BigInt(scaledDown.roundingReceipt.originalDenominator), BigInt(ratio.denominator))
  assert.equal(
    BigInt(scaledDown.roundingReceipt.originalNumerator),
    BigInt(scaledDown.roundingReceipt.quotient) * BigInt(scaledDown.roundingReceipt.originalDenominator)
      + BigInt(scaledDown.roundingReceipt.remainder),
  )
}

console.log('economics exact-arithmetic tests passed')
