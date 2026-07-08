import fs from 'node:fs'
import { bytesToHex, createPublicClient, formatEther, http, parseGwei, toBlobs } from 'viem'
import { mainnet, sepolia } from 'viem/chains'

export const chains = { mainnet, sepolia }

const WEI_PER_ETH = 10n ** 18n
const BLOB_GAS_PER_BLOB = 131_072n

function argvValue(name, fallback = undefined, argv = process.argv) {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return argv[idx + 1]
}

export function hasCostBudget(argv = process.argv) {
  return argv.includes('--max-cost-eth')
}

export function readCostOptions(argv = process.argv) {
  return {
    maxCostEth: argvValue('max-cost-eth', undefined, argv),
    mode: argvValue('cost-mode', 'block', argv),
    safetyMultiplier: Number(argvValue('cost-safety-multiplier', process.env.COST_SAFETY_MULTIPLIER || '1.25', argv)),
    gasPerSegment: BigInt(argvValue('cost-gas-per-segment', process.env.GAS_LIMIT || '180000', argv)),
    maxFeePerGasGwei: argvValue('cost-max-fee-per-gas-gwei', process.env.MAX_FEE_PER_GAS_GWEI, argv),
    maxFeePerBlobGasGwei: argvValue(
      'cost-max-fee-per-blob-gas-gwei',
      process.env.MAX_FEE_PER_BLOB_GAS_GWEI,
      argv,
    ),
    streamDurationMs: argvValue('stream-duration-ms', undefined, argv),
    expectedSegments: argvValue('expected-segments', undefined, argv),
  }
}

export function parseEthToWei(value) {
  const text = String(value || '').trim()
  if (!text) throw new Error('--max-cost-eth requires an ETH amount')
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid ETH amount: ${text}`)
  const [whole, fractional = ''] = text.split('.')
  const padded = `${fractional}000000000000000000`.slice(0, 18)
  return BigInt(whole) * WEI_PER_ETH + BigInt(padded)
}

function decimalMultiplier(value) {
  const text = String(value)
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`Invalid safety multiplier: ${text}`)
  const [whole, fractional = ''] = text.split('.')
  const scale = 1_000_000n
  const frac = `${fractional}000000`.slice(0, 6)
  return { numerator: BigInt(whole) * scale + BigInt(frac), denominator: scale }
}

function multiplyWei(wei, multiplier) {
  const { numerator, denominator } = decimalMultiplier(multiplier)
  return (wei * numerator + denominator - 1n) / denominator
}

export function formatEth(wei) {
  const asText = formatEther(wei)
  const [whole, fractional = ''] = asText.split('.')
  const trimmed = fractional.slice(0, 8).replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : whole
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}

export function segmentStats(segments) {
  const blobCounts = segments.map((segment) => Number(segment.blobCount || segment.estimatedBlobs || 0))
  const bytes = segments.map((segment) => Number(segment.payloadBytes || segment.bytes || 0))
  return {
    segments: segments.length,
    totalBlobs: blobCounts.reduce((sum, value) => sum + value, 0),
    averageBlobs: blobCounts.length ? blobCounts.reduce((sum, value) => sum + value, 0) / blobCounts.length : 0,
    maxBlobs: Math.max(0, ...blobCounts),
    p90Blobs: percentile(blobCounts, 0.9),
    totalBytes: bytes.reduce((sum, value) => sum + value, 0),
    averageBytes: bytes.length ? bytes.reduce((sum, value) => sum + value, 0) / bytes.length : 0,
  }
}

export function readSegmentFilesAsCostSegments(files) {
  return files
    .map((file) => {
      const payload = fs.readFileSync(file)
      if (!payload.length) return null
      return {
        file,
        payloadBytes: payload.length,
        blobCount: toBlobs({ data: bytesToHex(payload) }).length,
      }
    })
    .filter(Boolean)
}

async function readFeeWei({ chainName, rpcUrl, options }) {
  if (options.maxFeePerGasGwei && options.maxFeePerBlobGasGwei) {
    return {
      source: 'fee caps',
      executionGasPriceWei: parseGwei(options.maxFeePerGasGwei),
      blobGasPriceWei: parseGwei(options.maxFeePerBlobGasGwei),
    }
  }

  if (rpcUrl && chains[chainName]) {
    const publicClient = createPublicClient({ chain: chains[chainName], transport: http(rpcUrl, { timeout: 20_000 }) })
    const [executionGasPriceWei, blobBaseFeeHex] = await Promise.all([
      options.maxFeePerGasGwei
        ? Promise.resolve(parseGwei(options.maxFeePerGasGwei))
        : publicClient.getGasPrice(),
      options.maxFeePerBlobGasGwei
        ? Promise.resolve(parseGwei(options.maxFeePerBlobGasGwei))
        : publicClient.request({ method: 'eth_blobBaseFee' }).catch(() => null),
    ])
    return {
      source: 'current RPC fee quote',
      executionGasPriceWei,
      blobGasPriceWei: blobBaseFeeHex ? BigInt(blobBaseFeeHex) : parseGwei('1'),
    }
  }

  return {
    source: 'fallback defaults',
    executionGasPriceWei: options.maxFeePerGasGwei ? parseGwei(options.maxFeePerGasGwei) : parseGwei('1'),
    blobGasPriceWei: options.maxFeePerBlobGasGwei ? parseGwei(options.maxFeePerBlobGasGwei) : parseGwei('1'),
  }
}

export async function estimateStreamCost({ segments, segmentMs, chainName, rpcUrl, options }) {
  if (!segments.length && !options.expectedSegments && !options.streamDurationMs) {
    throw new Error('Cost preflight needs existing segments, --expected-segments, or --stream-duration-ms')
  }

  const concreteStats = segmentStats(segments)
  const expectedSegments = options.expectedSegments
    ? Number(options.expectedSegments)
    : options.streamDurationMs
      ? Math.ceil(Number(options.streamDurationMs) / Number(segmentMs))
      : concreteStats.segments

  const averageBlobs = concreteStats.averageBlobs || 4
  const totalBlobs = concreteStats.totalBlobs || Math.ceil(expectedSegments * averageBlobs)
  const { source, executionGasPriceWei, blobGasPriceWei } = await readFeeWei({ chainName, rpcUrl, options })
  const executionWei = BigInt(expectedSegments) * options.gasPerSegment * executionGasPriceWei
  const blobWei = BigInt(totalBlobs) * BLOB_GAS_PER_BLOB * blobGasPriceWei
  const totalWei = executionWei + blobWei
  const safetyWei = multiplyWei(totalWei, options.safetyMultiplier)
  const budgetWei = parseEthToWei(options.maxCostEth)
  const bufferWei = budgetWei - safetyWei

  return {
    source,
    chainName,
    segmentMs: Number(segmentMs),
    expectedSegments,
    stats: {
      ...concreteStats,
      totalBlobs,
      averageBlobs,
    },
    fees: {
      executionGasPriceGwei: Number(executionGasPriceWei) / 1e9,
      blobGasPriceGwei: Number(blobGasPriceWei) / 1e9,
      gasPerSegment: options.gasPerSegment.toString(),
    },
    executionWei,
    blobWei,
    totalWei,
    safetyWei,
    budgetWei,
    bufferWei,
    ok: bufferWei >= 0n,
    formatted: {
      executionEth: formatEth(executionWei),
      blobEth: formatEth(blobWei),
      totalEth: formatEth(totalWei),
      safetyEth: formatEth(safetyWei),
      budgetEth: formatEth(budgetWei),
      bufferEth: `${bufferWei < 0n ? '-' : ''}${formatEth(bufferWei < 0n ? -bufferWei : bufferWei)}`,
    },
  }
}

export function printCostPreflight(report) {
  const verdict = report.ok ? 'PASS' : 'FAIL'
  console.log('\n== cost preflight ==')
  console.log(`verdict: ${verdict}`)
  console.log(`chain: ${report.chainName}`)
  console.log(`fee source: ${report.source}`)
  console.log(`segments: ${report.expectedSegments} @ ${report.segmentMs}ms`)
  console.log(
    `blobs: ${report.stats.totalBlobs} total, avg ${report.stats.averageBlobs.toFixed(2)} / segment, max observed ${report.stats.maxBlobs}`,
  )
  console.log(
    `fees: execution ${report.fees.executionGasPriceGwei} gwei, blob ${report.fees.blobGasPriceGwei} gwei, gas/segment ${report.fees.gasPerSegment}`,
  )
  console.log(`execution estimate: ${report.formatted.executionEth} ETH`)
  console.log(`blob estimate:      ${report.formatted.blobEth} ETH`)
  console.log(`total estimate:     ${report.formatted.totalEth} ETH`)
  console.log(`safety budget:      ${report.formatted.safetyEth} ETH`)
  console.log(`user budget:        ${report.formatted.budgetEth} ETH`)
  console.log(`${report.ok ? 'remaining buffer' : 'shortfall'}: ${report.formatted.bufferEth} ETH`)
}

export function serializableCostReport(report) {
  return JSON.parse(JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)))
}

export async function runCostPreflightOrExit({ segments, segmentMs, argv = process.argv }) {
  if (!hasCostBudget(argv)) return null
  const options = readCostOptions(argv)
  const report = await estimateStreamCost({
    segments,
    segmentMs,
    chainName: process.env.CHAIN || 'sepolia',
    rpcUrl: process.env.ETH_RPC_URL,
    options,
  })
  printCostPreflight(report)
  if (!report.ok && options.mode !== 'warn') {
    throw new Error(
      `Cost preflight failed: ${report.formatted.safetyEth} ETH required with safety buffer, budget is ${report.formatted.budgetEth} ETH. Use --cost-mode warn to override.`,
    )
  }
  return report
}
