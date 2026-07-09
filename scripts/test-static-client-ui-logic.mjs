import assert from 'node:assert/strict'

function normalizeHex(value) {
  return String(value || '').toLowerCase()
}

function extractAddress(value) {
  return String(value || '').match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase() || ''
}

function normalizeStationAddressInput(value) {
  const address = extractAddress(value)
  if (address) return address
  const trimmed = String(value || '').trim()
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed.toLowerCase() : ''
}

function extractTxHash(value) {
  return String(value || '').match(/0x[a-fA-F0-9]{64}/)?.[0]?.toLowerCase() || ''
}

function parseArchiveStationInput(value) {
  const raw = String(value || '').trim()
  const txHash = extractTxHash(raw)
  if (txHash && !/\/address\//i.test(raw)) return { kind: 'tx', address: '', txHash }
  const address = normalizeStationAddressInput(raw)
  if (address) return { kind: 'address', address, txHash: '' }
  return { kind: 'invalid', address: '', txHash: '' }
}

function isBytes32Hex(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || ''))
}

function favoriteId(item) {
  return [
    item.type,
    normalizeHex(item.stationAddress),
    normalizeHex(item.inboxAddress || ''),
    normalizeHex(item.publisher || ''),
    normalizeHex(item.streamIdHash || ''),
    item.streamId || '',
  ].join(':')
}

function normalizeFavoriteItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const type = ['station', 'channel', 'stream', 'inbox', 'inbox-channel', 'inbox-stream'].includes(item.type) ? item.type : ''
  const stationAddress = normalizeStationAddressInput(item.stationAddress)
  const inboxAddress = normalizeStationAddressInput(item.inboxAddress)
  const publisher = normalizeStationAddressInput(item.publisher || '')
  const streamId = String(item.streamId || '').trim()
  const streamIdHash = isBytes32Hex(item.streamIdHash) ? normalizeHex(item.streamIdHash) : ''
  const firstBlock = Number(item.firstBlock)
  const latestBlock = Number(item.latestBlock)
  const hasArchiveRange = Number.isSafeInteger(firstBlock) && firstBlock >= 0
    && Number.isSafeInteger(latestBlock) && latestBlock >= firstBlock
  if (!type) return null
  if (type.startsWith('inbox')) {
    if (!inboxAddress) return null
    if (type === 'inbox-channel' && !publisher) return null
    if (type === 'inbox-stream' && (!publisher || (!streamId && !streamIdHash))) return null
  } else if (!stationAddress) return null
  if (type === 'channel' && !publisher) return null
  if (type === 'stream' && (!publisher || (!streamId && !streamIdHash))) return null
  const id = favoriteId({ type, stationAddress, inboxAddress, publisher, streamId, streamIdHash })
  return {
    id,
    type,
    stationAddress,
    inboxAddress,
    publisher,
    streamId,
    streamIdHash,
    firstBlock: hasArchiveRange ? firstBlock : null,
    latestBlock: hasArchiveRange ? latestBlock : null,
  }
}

function normalizeFavorites(value) {
  const byId = new Map()
  for (const item of Array.isArray(value) ? value : []) {
    const favorite = normalizeFavoriteItem(item)
    if (favorite) byId.set(favorite.id, favorite)
  }
  return [...byId.values()]
}

function archiveStreamKey(segment) {
  return `${normalizeHex(segment.publisher)}:${normalizeHex(segment.streamIdHash)}:${segment.streamId}`
}

function groupOldStreamsFromSegmentPublishedLogs(segments) {
  const groups = new Map()
  for (const segment of segments) {
    const key = archiveStreamKey(segment)
    const existing = groups.get(key) || {
      key,
      publisher: segment.publisher,
      streamIdHash: normalizeHex(segment.streamIdHash),
      streamId: segment.streamId,
      title: segment.streamId,
      segmentCount: 0,
      firstSequence: segment.sequence,
      latestSequence: segment.sequence,
      firstBlock: segment.blockNumber,
      latestBlock: segment.blockNumber,
    }
    existing.segmentCount += 1
    existing.firstSequence = Math.min(existing.firstSequence, segment.sequence)
    existing.latestSequence = Math.max(existing.latestSequence, segment.sequence)
    existing.firstBlock = Math.min(existing.firstBlock, segment.blockNumber)
    existing.latestBlock = Math.max(existing.latestBlock, segment.blockNumber)
    groups.set(key, existing)
  }
  return [...groups.values()].sort((a, b) => b.latestBlock - a.latestBlock || a.title.localeCompare(b.title))
}

function parseRfe1Envelope(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return null
  if (bytes[0] !== 0x52 || bytes[1] !== 0x46 || bytes[2] !== 0x45 || bytes[3] !== 0x31) return null
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, false)
  const headerStart = 8
  const headerEnd = headerStart + headerLength
  if (headerLength <= 0 || headerEnd > bytes.length) return null
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerStart, headerEnd)))
  const payload = bytes.subarray(headerEnd)
  const publisher = normalizeStationAddressInput(header.publisher)
  const sequence = Number(header.sequence)
  const payloadSha256Hex = normalizeHex(header.payloadSha256 || '')
  if (!publisher || !header.streamId || !Number.isSafeInteger(sequence) || !isBytes32Hex(payloadSha256Hex)) return null
  return { publisher, streamId: header.streamId, sequence, payload }
}

const BLOB_GAS_PER_BLOB = 131_072n
const MAX_BLOBS_PER_BLOCK = 21
const TARGET_BLOBS_PER_BLOCK = 14
const WEI_PER_GWEI = 1_000_000_000n
const WEI_PER_ETH = 1_000_000_000_000_000_000n
const BLOB_FEE_HISTORY_CHUNK_BLOCKS = 1024
const BLOB_FEE_HISTORY_WINDOWS = {
  tenMinute: { blocks: 50, cacheMs: 90_000 },
  hour: { blocks: 300, cacheMs: 3 * 60_000 },
  day: { blocks: 7200, cacheMs: 20 * 60_000 },
  week: { blocks: 50400, cacheMs: 60 * 60_000 },
}

function defaultLayoutSettings() {
  return {
    bottomSpan: 'between',
    player: { visible: true, position: 'main', order: 1 },
    feeds: { visible: true, position: 'right', order: 1 },
    archive: { visible: true, position: 'bottom', order: 1 },
    blobFees: { visible: false, position: 'bottom', order: 2 },
  }
}

function normalizeLayoutSettings(value) {
  const fallback = defaultLayoutSettings()
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const next = { bottomSpan: input.bottomSpan === 'full' ? 'full' : 'between' }
  for (const panel of ['player', 'feeds', 'archive', 'blobFees']) {
    const config = input[panel] && typeof input[panel] === 'object' ? input[panel] : fallback[panel]
    const position = ['left', 'main', 'right', 'bottom'].includes(config.position) ? config.position : fallback[panel].position
    const order = Number(config.order)
    next[panel] = {
      visible: config.visible !== false,
      position,
      order: Number.isSafeInteger(order) && order > 0 && order <= 4 ? order : fallback[panel].order,
    }
  }
  if (!Object.values(next).some((panel) => panel.visible)) next.player.visible = true
  return next
}

function rpcQuantityBigInt(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} must be an RPC quantity`)
  return BigInt(value)
}

function blobFeeWei(baseFeePerBlobGasWei) {
  return BigInt(baseFeePerBlobGasWei) * BLOB_GAS_PER_BLOB
}

function formatGweiFromWei(value) {
  const wei = typeof value === 'bigint' ? value : BigInt(value)
  const whole = wei / WEI_PER_GWEI
  const fraction = (wei % WEI_PER_GWEI).toString().padStart(9, '0').slice(0, 4).replace(/0+$/, '')
  return `${whole.toString()}${fraction ? `.${fraction}` : ''} Gwei`
}

function formatEthFromWei(value) {
  const wei = typeof value === 'bigint' ? value : BigInt(value)
  const whole = wei / WEI_PER_ETH
  const fraction = (wei % WEI_PER_ETH).toString().padStart(18, '0').slice(0, 8).replace(/0+$/, '')
  return `${whole.toString()}${fraction ? `.${fraction}` : ''} ETH`
}

function fmtUtcClock(date = new Date()) {
  return `${date.toISOString().slice(11, 19)} UTC`
}

function fmtClockWithPrefs(date, clock) {
  if (clock.mode === 'local') {
    return `${new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)} local`
  }
  if (clock.mode === 'timezone' && clock.timeZone) {
    try {
      return `${new Intl.DateTimeFormat([], {
        timeZone: clock.timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date)} ${clock.timeZone}`
    } catch {
      return fmtUtcClock(date)
    }
  }
  return fmtUtcClock(date)
}

function formatBlobWindowUsage(entry) {
  const blocks = Number(entry?.sampleBlocks || 0)
  const blobs = Number(entry?.blobCount || 0)
  if (!Number.isSafeInteger(blocks) || blocks <= 0 || !Number.isFinite(blobs)) return { text: '-', title: '' }
  return {
    text: `${blocks} blocks - ~${Math.round(blobs)} blobs`,
    title: `Approximate total blobs observed in the selected window, derived from blobGasUsedRatio * ${MAX_BLOBS_PER_BLOCK} max blobs per block. Current mainnet target is ${TARGET_BLOBS_PER_BLOCK}; max is ${MAX_BLOBS_PER_BLOCK}.`,
  }
}

function averageBigInts(values) {
  const usable = values.filter((value) => typeof value === 'bigint' && value > 0n)
  if (!usable.length) return null
  return usable.reduce((sum, value) => sum + value, 0n) / BigInt(usable.length)
}

function percentileBigInt(values, percentile) {
  const usable = values.filter((value) => typeof value === 'bigint' && value > 0n).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  if (!usable.length) return null
  const index = Math.min(usable.length - 1, Math.max(0, Math.ceil((percentile / 100) * usable.length) - 1))
  return usable[index]
}

function blobFeeHistoryValues(response) {
  const fees = Array.isArray(response?.baseFeePerBlobGas) ? response.baseFeePerBlobGas : null
  if (!fees) throw new Error('eth_feeHistory response missing baseFeePerBlobGas')
  const ratios = Array.isArray(response?.blobGasUsedRatio) ? response.blobGasUsedRatio : []
  return {
    baseFees: fees.map((value) => rpcQuantityBigInt(value, 'baseFeePerBlobGas')).filter((value) => value > 0n),
    utilization: ratios.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0 && value <= 1),
    oldestBlock: response.oldestBlock ? rpcQuantityBigInt(response.oldestBlock, 'feeHistory oldestBlock') : null,
  }
}

async function fetchBlobFeeHistory(blocks, rpc) {
  const baseFees = []
  const utilization = []
  let newestBlock = 'latest'
  let remaining = blocks
  while (remaining > 0) {
    const chunk = Math.min(remaining, BLOB_FEE_HISTORY_CHUNK_BLOCKS)
    const response = await rpc('eth_feeHistory', [chunk, newestBlock, []])
    const parsed = blobFeeHistoryValues(response)
    baseFees.push(...parsed.baseFees)
    utilization.push(...parsed.utilization)
    if (!parsed.oldestBlock || parsed.oldestBlock === 0n) break
    newestBlock = `0x${(parsed.oldestBlock - 1n).toString(16)}`
    remaining -= chunk
  }
  return { baseFees, utilization }
}

async function refreshBlobFeeWindow(key, state, rpc) {
  const windowConfig = BLOB_FEE_HISTORY_WINDOWS[key]
  try {
    const history = await fetchBlobFeeHistory(windowConfig.blocks, rpc)
    const average = averageBigInts(history.baseFees)
    if (average == null) throw new Error('No blob fee samples returned')
    const next = {
      status: 'ok',
      averageWei: average.toString(),
      percentile75Wei: percentileBigInt(history.baseFees, 75)?.toString() || '',
      sampleBlocks: history.utilization.length,
      blobCount: Math.round(history.utilization.reduce((sum, value) => sum + value * MAX_BLOBS_PER_BLOCK, 0)),
      utilization: history.utilization.length ? history.utilization.reduce((sum, value) => sum + value, 0) / history.utilization.length : null,
    }
    state.history[key] = next
    return next
  } catch (error) {
    const next = { status: 'limited', message: key === 'day' || key === 'week' ? 'provider limited' : error.message }
    state.history[key] = next
    return next
  }
}

assert.equal(normalizeStationAddressInput('https://sepolia.etherscan.io/address/0x060c51D481808B506dfae72f054F39e11E4f4017'), '0x060c51d481808b506dfae72f054f39e11e4f4017')
assert.equal(normalizeStationAddressInput('0xnot-an-address'), '')
assert.deepEqual(parseArchiveStationInput('https://etherscan.io/address/0x0000000000000000000000000000000000000001'), {
  kind: 'address',
  address: '0x0000000000000000000000000000000000000001',
  txHash: '',
})
assert.deepEqual(parseArchiveStationInput(`https://etherscan.io/tx/0x${'f'.repeat(64)}`), {
  kind: 'tx',
  address: '',
  txHash: `0x${'f'.repeat(64)}`,
})

const favorites = normalizeFavorites([
  { type: 'station', stationAddress: '0x0000000000000000000000000000000000000001' },
  { type: 'channel', stationAddress: '0x0000000000000000000000000000000000000001', publisher: '0x0000000000000000000000000000000000000002' },
  { type: 'stream', stationAddress: '0x0000000000000000000000000000000000000001', publisher: '0x0000000000000000000000000000000000000002', streamId: 'rfe-mainnet-live', streamIdHash: `0x${'a'.repeat(64)}`, firstBlock: 10, latestBlock: 20 },
  { type: 'inbox-stream', inboxAddress: '0x0000000000000000000000000000000000000003', publisher: '0x0000000000000000000000000000000000000002', streamId: 'rfe-inbox-live' },
  { type: 'stream', stationAddress: '0x0000000000000000000000000000000000000001', streamId: 'missing-publisher' },
])
assert.equal(favorites.length, 4)
assert.equal(favorites[2].streamId, 'rfe-mainnet-live')
assert.equal(favorites[2].firstBlock, 10)
assert.equal(favorites[2].latestBlock, 20)
assert.equal(favorites[3].type, 'inbox-stream')

const grouped = groupOldStreamsFromSegmentPublishedLogs([
  { publisher: '0x0000000000000000000000000000000000000002', streamIdHash: `0x${'a'.repeat(64)}`, streamId: 'alpha', sequence: 2, blockNumber: 12 },
  { publisher: '0x0000000000000000000000000000000000000002', streamIdHash: `0x${'a'.repeat(64)}`, streamId: 'alpha', sequence: 1, blockNumber: 10 },
  { publisher: '0x0000000000000000000000000000000000000003', streamIdHash: `0x${'b'.repeat(64)}`, streamId: 'beta', sequence: 7, blockNumber: 20 },
])
assert.equal(grouped.length, 2)
assert.equal(grouped[0].streamId, 'beta')
assert.equal(grouped[1].segmentCount, 2)
assert.equal(grouped[1].firstSequence, 1)
assert.equal(grouped[1].latestSequence, 2)
assert.equal(grouped[1].firstBlock, 10)
assert.equal(grouped[1].latestBlock, 12)

const headerBytes = new TextEncoder().encode(JSON.stringify({
  publisher: '0x0000000000000000000000000000000000000002',
  streamId: 'rfe-inbox-live',
  sequence: 3,
  payloadSha256: `0x${'c'.repeat(64)}`,
}))
const payloadBytes = new Uint8Array([1, 2, 3])
const envelope = new Uint8Array(8 + headerBytes.length + payloadBytes.length)
envelope.set([0x52, 0x46, 0x45, 0x31])
new DataView(envelope.buffer).setUint32(4, headerBytes.length, false)
envelope.set(headerBytes, 8)
envelope.set(payloadBytes, 8 + headerBytes.length)
const parsedEnvelope = parseRfe1Envelope(envelope)
assert.equal(parsedEnvelope.streamId, 'rfe-inbox-live')
assert.equal(parsedEnvelope.sequence, 3)
assert.equal(parsedEnvelope.payload.byteLength, 3)

const defaultLayout = defaultLayoutSettings()
assert.equal(defaultLayout.blobFees.visible, false)
assert.equal(defaultLayout.blobFees.position, 'bottom')
assert.equal(defaultLayout.blobFees.order, 2)
const enabledLayout = normalizeLayoutSettings({ blobFees: { visible: true, position: 'bottom', order: 4 } })
assert.equal(enabledLayout.blobFees.visible, true)
assert.equal(enabledLayout.blobFees.position, 'bottom')
assert.equal(enabledLayout.blobFees.order, 4)

assert.equal(blobFeeWei(2_000_000_000n), 262_144_000_000_000n)
assert.equal(formatGweiFromWei(WEI_PER_GWEI), '1 Gwei')
assert.equal(formatGweiFromWei(1_500_000_000n), '1.5 Gwei')
assert.equal(formatEthFromWei(WEI_PER_ETH), '1 ETH')
assert.equal(fmtClockWithPrefs(new Date('2026-07-09T12:34:56Z'), { mode: 'utc', timeZone: '' }), '12:34:56 UTC')
assert.match(fmtClockWithPrefs(new Date('2026-07-09T12:34:56Z'), { mode: 'timezone', timeZone: 'America/New_York' }), /America\/New_York$/)
assert.equal(formatBlobWindowUsage({ sampleBlocks: 50, blobCount: 326 }).text, '50 blocks - ~326 blobs')
assert.match(formatBlobWindowUsage({ sampleBlocks: 50, blobCount: 326 }).title, /target is 14; max is 21/)
assert.equal(averageBigInts([0n, 10n, 20n]), 15n)
assert.equal(averageBigInts([0n]), null)
assert.throws(() => blobFeeHistoryValues({ oldestBlock: '0x1', blobGasUsedRatio: [0.5] }), /baseFeePerBlobGas/)
assert.deepEqual(blobFeeHistoryValues({
  oldestBlock: '0x10',
  baseFeePerBlobGas: ['0x0', '0xa', '0x14'],
  blobGasUsedRatio: [0, 0.5, 'bad', 1.2],
}), { baseFees: [10n, 20n], utilization: [0, 0.5], oldestBlock: 16n })

const calls = []
const history = await fetchBlobFeeHistory(1500, async (method, params) => {
  calls.push([method, params])
  return { oldestBlock: params[1] === 'latest' ? '0x400' : '0x1', baseFeePerBlobGas: ['0x1'], blobGasUsedRatio: [0.2] }
})
assert.equal(history.baseFees.length, 2)
assert.equal(calls[0][1][0], 1024)
assert.equal(calls[1][1][0], 476)
assert.equal(calls[1][1][1], '0x3ff')

const providerLimitedState = { history: {} }
const limited = await refreshBlobFeeWindow('week', providerLimitedState, async () => {
  throw new Error('too many blocks')
})
assert.equal(limited.status, 'limited')
assert.equal(limited.message, 'provider limited')

console.log('static client ui logic ok')
