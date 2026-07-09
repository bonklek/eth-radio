import 'dotenv/config'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { bytesToHex, createPublicClient, http, toBlobs, zeroHash } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import ffmpegPath from 'ffmpeg-static'
import { hasFlag, numberArg, readArg } from './lib/cli-args.mjs'
import { readExistingSegmentManifest, segmentSequence, upsertSegment } from './lib/live-segment-manifest.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '..')
const chains = { mainnet, sepolia }

const profiles = {
  '360p': { width: 640, height: 360, overlay: 'public/rfe-assets/overlays/rfe-terminal-360p.png' },
  '420p': { width: 746, height: 420, overlay: 'public/rfe-assets/overlays/rfe-terminal-420p.png' },
  '480p': { width: 854, height: 480, overlay: 'public/rfe-assets/overlays/rfe-terminal-480p.png' },
  '720p': { width: 1280, height: 720, overlay: 'public/rfe-assets/overlays/rfe-terminal-720p.png' },
  '1080p': { width: 1920, height: 1080, overlay: 'public/rfe-assets/overlays/rfe-terminal-1080p.png' },
}

function usage() {
  console.error(`Usage:
  pnpm live:segment:overlay -- --input <video> --out-dir <segment-dir> --stream-id <id>
       [--profile 360p] [--segment-ms 24000] [--start-seq 0] [--max-segments <count>]
       [--fps 24] [--video-bitrate 96k] [--audio-bitrate 16k] [--no-audio]
       [--max-blobs 6] [--max-bytes 761856] [--pace] [--reset]

Samples real chain/beacon context for each segment, renders the RFE overlay
dynamic regions from a fixed layout contract, then writes one composited WebM
and manifest entry at a time.
`)
  process.exit(1)
}

function fromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value)
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temp, value)
  fs.renameSync(temp, filePath)
}

function atomicWriteJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(command)} exited with code ${code}`))
    })
  })
}

function probeDurationMs(inputPath) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', inputPath], { encoding: 'utf8' })
  const text = `${result.stderr || ''}\n${result.stdout || ''}`
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return null
  const [, hours, minutes, seconds] = match
  return Math.round(((Number(hours) * 60 * 60) + (Number(minutes) * 60) + Number(seconds)) * 1000)
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function estimateBlobs(filePath) {
  const payload = fs.readFileSync(filePath)
  return toBlobs({ data: bytesToHex(payload) }).length
}

function short(value, head = 8, tail = 6) {
  if (!value) return '--'
  const text = String(value)
  if (text.length <= head + tail + 3) return text
  return `${text.slice(0, head)}...${text.slice(-tail)}`
}

function formatBytes(value) {
  const n = Number(value || 0)
  return n ? `${n.toLocaleString('en-US')} B` : '--'
}

function formatKilobytes(value) {
  const n = Number(value || 0)
  return n ? `${(n / 1000).toFixed(1)} KB` : '--'
}

function xml(value) {
  return String(value ?? '--')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeFilterText(value) {
  return String(value ?? '--')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
}

function readOptionalPublisherState(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      console.warn(`Ignoring invalid optional publisher state ${filePath}: expected an object`)
      return null
    }
    if (state.published !== undefined && !Array.isArray(state.published)) {
      console.warn(`Ignoring invalid optional publisher state ${filePath}: published must be an array`)
      return null
    }
    const published = state.published === undefined ? [] : state.published
    return { ...state, published }
  } catch (error) {
    console.warn(`Ignoring unreadable optional publisher state ${filePath}: ${error.message}`)
    return null
  }
}

function optionalPublishedSegmentSequence(segment, index, filePath) {
  try {
    return segmentSequence(segment.sequence, 'published segment')
  } catch (error) {
    console.warn(`Ignoring invalid optional publisher state ${filePath}: published[${index}].sequence ${error.message}`)
    return null
  }
}

function scaleBox(box, width, height) {
  const sx = width / 1920
  const sy = height / 1080
  return {
    x: Math.round(box.x * sx),
    y: Math.round(box.y * sy),
    width: Math.round(box.width * sx),
    height: Math.round(box.height * sy),
  }
}

function fit(text, maxChars) {
  const value = String(text || '--')
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(1, maxChars - 3))}...`
}

function svgText({ text, x, y, size, weight = 800, family = 'Consolas, ui-monospace, monospace', color = '#c6ccff' }) {
  return `<text x="${x}" y="${y}" font-family="${xml(family)}" font-size="${size}" font-weight="${weight}" fill="${color}">${xml(text)}</text>`
}

function svgRect({ x, y, width, height, fill = '#181a24', rx = 2 }) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${fill}"/>`
}

function renderOverlaySvg({ width, height, fields, outputPath }) {
  const chipSource = {
    timeUtc: { x: 672, y: 31, width: 236, height: 48 },
    slot: { x: 922, y: 35, width: 238, height: 40 },
    nonce: { x: 1174, y: 35, width: 252, height: 40 },
    blockHash: { x: 1440, y: 35, width: 374, height: 40 },
  }
  const network = scaleBox({ x: 113, y: 66, width: 520, height: 31 }, width, height)
  const topMask = scaleBox({ x: 660, y: 24, width: 1168, height: 64 }, width, height)
  const lower = scaleBox({ x: 36, y: 948, width: 1848, height: 112 }, width, height)
  const cards = {
    tx: scaleBox({ x: 784, y: 998, width: 252, height: 54 }, width, height),
    payload: scaleBox({ x: 1060, y: 998, width: 196, height: 54 }, width, height),
    hash: scaleBox({ x: 1280, y: 998, width: 244, height: 54 }, width, height),
    prev: scaleBox({ x: 1548, y: 998, width: 244, height: 54 }, width, height),
  }
  const sx = width / 1920
  const sy = height / 1080
  const chipSize = Math.max(8, Math.round(22 * sy))
  const timeSize = Math.max(9, Math.round(29 * sy))
  const labelSize = Math.max(7, Math.round(15 * sy))
  const valueSize = Math.max(8, Math.round(21 * sy))
  const titleSize = Math.max(12, Math.round(42 * sy))
  const statusSize = Math.max(9, Math.round(24 * sy))
  const networkSize = Math.max(9, Math.round(26 * sy))

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    svgRect({ ...topMask, fill: '#181a24', rx: Math.max(1, Math.round(6 * sx)) }),
    svgRect({ ...network, fill: '#181a24', rx: 0 }),
    svgText({ text: fields.networkSignal, x: network.x, y: network.y + Math.round(24 * sy), size: networkSize }),
  ]

  for (const [name, sourceBox] of Object.entries(chipSource)) {
    const box = scaleBox(sourceBox, width, height)
    parts.push(svgRect({ ...box, fill: '#303343', rx: Math.max(1, Math.round(6 * sx)) }))
    const text = fields[name] || '--'
    parts.push(svgText({
      text: fit(text, name === 'blockHash' ? 18 : 14),
      x: box.x + Math.round(12 * sx),
      y: box.y + Math.round((name === 'timeUtc' ? 35 : 27) * sy),
      size: name === 'timeUtc' ? timeSize : chipSize,
    }))
  }

  parts.push(svgRect({ ...lower, fill: '#11131a', rx: Math.max(1, Math.round(6 * sx)) }))
  parts.push(svgText({ text: 'Now Reading', x: lower.x + Math.round(28 * sx), y: lower.y + Math.round(38 * sy), size: statusSize, weight: 900, family: 'Arial, Segoe UI, sans-serif', color: '#8f97e8' }))
  parts.push(svgText({ text: 'The Ethereum Foundation Mandate', x: lower.x + Math.round(28 * sx), y: lower.y + Math.round(88 * sy), size: titleSize, weight: 900, family: 'Arial, Segoe UI, sans-serif', color: '#f0f1f8' }))

  const telemetry = [
    ['tx', 'PREV TX', fields.prevTx],
    ['payload', 'PAYLOAD', fields.payload],
    ['hash', 'HASH', fields.hash],
    ['prev', 'PREV', fields.prevHash],
  ]
  for (const [key, label, value] of telemetry) {
    const box = cards[key]
    parts.push(svgText({ text: label, x: box.x, y: box.y + Math.round(15 * sy), size: labelSize, color: 'rgba(186,190,214,0.82)' }))
    parts.push(svgText({ text: fit(value, key === 'payload' ? 16 : 18), x: box.x, y: box.y + Math.round(42 * sy), size: valueSize }))
  }

  parts.push('</svg>')
  atomicWrite(outputPath, parts.join('\n'))
}

function drawBoxFilter({ x, y, width, height, color = '0x181a24@1' }) {
  return `drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=${color}:t=fill`
}

function drawTextFilter({ text, x, y, size, color = '0xc6ccff@1', font = 'Consolas' }) {
  return [
    'drawtext',
    `text='${escapeFilterText(text)}'`,
    `x=${x}`,
    `y=${y}`,
    `fontsize=${size}`,
    `font=${font}`,
    `fontcolor=${color}`,
    'box=0',
  ].join(':').replace('drawtext:text=', 'drawtext=text=')
}

function proofLayerFilters({ width, height, fields }) {
  if (width !== 640 || height !== 360) {
    throw new Error('Proof compositor currently has exact raster boxes only for the 360p overlay shell')
  }

  const filters = []
  filters.push(drawTextFilter({
    text: 'RADIO FREE ETHEREUM',
    x: 38,
    y: 8,
    size: 12,
    color: '0xf0f1f8@1',
    font: 'Arial',
  }))
  filters.push(drawTextFilter({
    text: fields.networkSignal,
    x: 38,
    y: 23,
    size: 6,
    color: '0xc6ccff@1',
    font: 'Arial',
  }))

  const topFields = [
    ['timeUtc', { x: 224, y: 10, width: 80, height: 17 }, fields.timeUtc, 10, 5],
    ['slot', { x: 309, y: 10, width: 78, height: 17 }, fit(fields.slot, 14), 8, 4],
    ['nonce', { x: 391, y: 10, width: 85, height: 17 }, fit(fields.nonce, 14), 8, 4],
    ['blockHash', { x: 480, y: 10, width: 126, height: 17 }, fit(fields.blockHash, 18), 8, 4],
  ]
  for (const [, box, value, size, xPad] of topFields) {
    filters.push(drawBoxFilter({ ...box, color: '0x303343@1' }))
    filters.push(drawTextFilter({
      text: value,
      x: box.x + xPad,
      y: box.y + 4,
      size,
    }))
  }

  filters.push(drawTextFilter({
    text: 'NOW READING',
    x: 20,
    y: 312,
    size: 7,
    color: '0xc6ccff@1',
  }))
  filters.push(drawTextFilter({
    text: 'The Ethereum Foundation Mandate',
    x: 20,
    y: 334,
    size: 12,
    color: '0xf0f1f8@1',
    font: 'Arial',
  }))

  const telemetryCards = [
    [{ x: 276, y: 313, width: 91, height: 31 }, 'PREV TX', short(fields.prevTx, 10, 6)],
    [{ x: 372, y: 313, width: 95, height: 31 }, 'PAYLOAD', fields.payload],
    [{ x: 472, y: 313, width: 109, height: 31 }, 'HASH', fit(fields.hash, 18)],
  ]
  for (const [box, label, value] of telemetryCards) {
    filters.push(drawBoxFilter({ ...box, color: '0x11131a@1' }))
    filters.push(drawTextFilter({
      text: label,
      x: box.x + 2,
      y: box.y + 2,
      size: 7,
      color: '0xbabed6@1',
    }))
    filters.push(drawTextFilter({
      text: value || '--',
      x: box.x + 2,
      y: box.y + 15,
      size: 7,
    }))
  }
  return filters
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function sampleProofContext({ publicClient, chainName, beaconUrl, account }) {
  const generatedAt = new Date().toISOString()
  const [block, nonce, beaconHead] = await Promise.all([
    publicClient.getBlock({ blockTag: 'latest' }),
    account ? publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }).catch(() => null) : null,
    beaconUrl ? fetchJson(`${beaconUrl}/eth/v1/beacon/headers/head`).catch(() => null) : null,
  ])
  const header = beaconHead?.data?.header?.message
  return {
    generatedAt,
    chain: chainName,
    networkLabel: chainName === 'mainnet' ? 'Mainnet' : 'Sepolia',
    executionBlock: {
      number: block.number.toString(),
      hash: block.hash,
      timestamp: block.timestamp.toString(),
    },
    proofSlot: header?.slot || null,
    proofRoot: beaconHead?.data?.root || null,
    proofNonce: nonce == null ? null : String(nonce),
  }
}

function readPreviousFacts({ sequence, manifest, statePath }) {
  const previousSegment = [...manifest.segments]
    .filter((segment) => segmentSequence(segment.sequence, 'manifest segment') === sequence - 1)
    .at(-1)
  const state = readOptionalPublisherState(statePath)
  const previousPublished = [...(state ? state.published : [])]
    .filter((segment, index) => optionalPublishedSegmentSequence(segment, index, statePath) === sequence - 1)
    .at(-1)
  return {
    previousSegmentHash: previousSegment?.payloadSha256 ? `0x${previousSegment.payloadSha256}` : zeroHash,
    previousTxHash: previousPublished?.txHash || null,
  }
}

const input = readArg('input')
const streamId = readArg('stream-id')
if (!input || !streamId) usage()
if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve an ffmpeg binary')

const safeStreamId = sanitize(streamId)
const profileName = readArg('profile', '360p').toLowerCase()
const profile = profiles[profileName]
if (!profile) throw new Error(`Unsupported --profile ${profileName}; use ${Object.keys(profiles).join(', ')}`)

const inputPath = fromRoot(input)
const outDir = fromRoot(readArg('out-dir', 'work/blob-radio-testnet/live-segments'))
const statePath = fromRoot(readArg('publisher-state', `work/blob-radio-testnet/live-state/${safeStreamId}.pipelined.json`))
const manifestPath = path.join(outDir, `${safeStreamId}.segments.json`)
const overlayPath = fromRoot(readArg('overlay', profile.overlay))
const segmentMs = numberArg('segment-ms', '24000', { integer: true, min: 1 })
const startSeq = numberArg('start-seq', '0', { integer: true, min: 0 })
const fps = numberArg('fps', '24', { min: 1 })
const videoBitrate = readArg('video-bitrate', '96k')
const audioBitrate = readArg('audio-bitrate', '16k')
const maxBlobs = numberArg('max-blobs', '6', { integer: true, min: 1 })
const maxBytes = numberArg('max-bytes', String(maxBlobs * 126_976), { integer: true, min: 1 })
const noAudio = hasFlag('no-audio')
const pace = hasFlag('pace')
const reset = hasFlag('reset')
const maxSegmentsArg = readArg('max-segments')
const maxSegments = maxSegmentsArg !== undefined
  ? numberArg('max-segments', undefined, { integer: true, min: 1 })
  : null
const segmentSeconds = segmentMs / 1000
const chainName = process.env.CHAIN || 'sepolia'
const chain = chains[chainName]
const rpcUrl = process.env.ETH_RPC_URL
const beaconUrl = process.env.BEACON_RPC_URL?.replace(/\/$/, '')
const account = process.env.PRIVATE_KEY ? privateKeyToAccount(process.env.PRIVATE_KEY) : null

if (!chain || !rpcUrl) throw new Error('CHAIN and ETH_RPC_URL are required for proof-aware overlay generation')
if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`)
if (!fs.existsSync(overlayPath)) throw new Error(`Overlay PNG not found: ${overlayPath}`)
if (!Number.isFinite(segmentMs) || segmentMs <= 0) throw new Error(`Invalid --segment-ms ${segmentMs}`)
if (!Number.isInteger(startSeq) || startSeq < 0) throw new Error(`Invalid --start-seq ${startSeq}`)
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000 }) })
const durationMs = probeDurationMs(inputPath)
fs.mkdirSync(outDir, { recursive: true })
if (reset && fs.existsSync(manifestPath)) fs.rmSync(manifestPath, { force: true })

let manifest = readExistingSegmentManifest(manifestPath, { streamId, filePrefix: safeStreamId }) || {
  app: 'eth-radio',
  kind: 'live-segment-set',
  streamId,
  filePrefix: safeStreamId,
  input: inputPath,
  outDir,
  segmentMs,
  width: profile.width,
  height: profile.height,
  fps,
  videoBitrate,
  audioBitrate: noAudio ? null : audioBitrate,
  codec: noAudio ? 'av1/webm' : 'av1-opus/webm',
  overlay: 'rfe-proof-burned-in',
  overlayProfile: profileName,
  overlayAsset: overlayPath,
  compositor: {
    name: 'live-composite-rfe-segments',
    version: 2,
    currentPayloadHashVisibility: 'manifest-only-noncircular',
  },
  createdAt: new Date().toISOString(),
  segments: [],
}
manifest = {
  ...manifest,
  streamId,
  filePrefix: safeStreamId,
  outDir,
  overlay: 'rfe-proof-burned-in',
  overlayProfile: profileName,
  overlayAsset: overlayPath,
  updatedAt: new Date().toISOString(),
}
atomicWriteJson(manifestPath, manifest)

console.log(`live RFE proof compositor: ${inputPath}`)
console.log(`chain: ${chainName}`)
console.log(`overlay: ${overlayPath}`)
console.log(`output: ${outDir}`)
console.log(`manifest: ${manifestPath}`)
console.log(`profile: ${profileName} ${profile.width}x${profile.height} ${fps}fps AV1 WebM, segment ${segmentSeconds}s`)
if (durationMs != null) console.log(`source duration: ${durationMs}ms`)
if (!beaconUrl) console.warn('BEACON_RPC_URL not configured; proof slot/root fields will be unavailable')

const wallStart = Date.now()
let generated = 0

for (let sequence = startSeq; ; sequence += 1) {
  if (maxSegments != null && generated >= maxSegments) break
  const startMs = sequence * segmentMs
  if (durationMs != null && startMs >= durationMs) break

  const finalPath = path.join(outDir, `${safeStreamId}-${String(sequence).padStart(6, '0')}.webm`)
  const tempPath = `${finalPath}.tmp`
  if (fs.existsSync(finalPath) && !reset) throw new Error(`Refusing to overwrite existing segment without --reset: ${finalPath}`)
  if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })

  manifest = readExistingSegmentManifest(manifestPath, { streamId, filePrefix: safeStreamId }) || manifest
  const proof = await sampleProofContext({ publicClient, chainName, beaconUrl, account })
  const previous = readPreviousFacts({ sequence, manifest, statePath })
  function ffmpegArgs({ payloadLabel, outputPath }) {
    const proofFilters = proofLayerFilters({
      width: profile.width,
      height: profile.height,
      fields: {
        networkSignal: `PUBLIC SIGNAL / ${proof.networkLabel.toUpperCase()}`,
        timeUtc: `${proof.generatedAt.slice(11, 19)} UTC`,
        slot: proof.proofSlot ? `PROOF SLOT ${proof.proofSlot}` : `BLOCK ${proof.executionBlock.number}`,
        nonce: proof.proofNonce ? `NONCE ${proof.proofNonce}` : `SEQ ${sequence}`,
        blockHash: `BLOCK ${short(proof.executionBlock.hash, 8, 4)}`,
        prevTx: short(previous.previousTxHash, 10, 6),
        payload: payloadLabel,
        hash: 'MANIFEST',
        prevHash: short(previous.previousSegmentHash, 10, 6),
      },
    })

    const filter = [
      `[0:v]fps=${fps},scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2,format=rgba[base]`,
      '[1:v]format=rgba[shell]',
      '[base][shell]overlay=0:0:format=auto[withshell]',
      `[withshell]${proofFilters.join(',')},format=yuv420p[v]`,
    ].join(';')

    const args = [
      '-hide_banner',
      '-y',
      '-ss',
      String(startMs / 1000),
      '-t',
      String(segmentSeconds),
      '-i',
      inputPath,
      '-loop',
      '1',
      '-framerate',
      String(fps),
      '-i',
      overlayPath,
      '-filter_complex',
      filter,
      '-map',
      '[v]',
    ]
    if (noAudio) args.push('-an')
    else args.push('-map', '0:a:0?', '-c:a', 'libopus', '-b:a', audioBitrate)
    args.push(
      '-c:v',
      'libaom-av1',
      '-cpu-used',
      '8',
      '-b:v',
      videoBitrate,
      '-g',
      String(Math.max(1, Math.round(fps * segmentSeconds))),
      '-keyint_min',
      String(Math.max(1, Math.round(fps * segmentSeconds))),
      '-row-mt',
      '1',
      '-shortest',
      '-f',
      'webm',
      outputPath,
    )
    return args
  }

  console.log(`\n== compositing seq ${sequence} @ ${startMs}ms ==`)
  let visiblePayloadLabel = 'ENCODING'
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
    await run(ffmpegPath, ffmpegArgs({ payloadLabel: visiblePayloadLabel, outputPath: tempPath }))
    if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size === 0) break
    const nextLabel = formatKilobytes(fs.statSync(tempPath).size)
    if (nextLabel === visiblePayloadLabel) break
    visiblePayloadLabel = nextLabel
  }
  if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size === 0) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
    console.log(`no segment produced for seq ${sequence}; stopping`)
    break
  }
  fs.renameSync(tempPath, finalPath)

  const bytes = fs.statSync(finalPath).size
  const estimatedBlobs = estimateBlobs(finalPath)
  const payloadSha256 = sha256File(finalPath)
  if (bytes > maxBytes || estimatedBlobs > maxBlobs) {
    throw new Error(`Segment ${sequence} exceeds cap: ${bytes} bytes / ${estimatedBlobs} blob(s), cap ${maxBytes} bytes / ${maxBlobs} blob(s)`)
  }

  manifest.segments = upsertSegment(manifest.segments, {
      sequence,
      file: finalPath,
      bytes,
      estimatedBlobs,
      payloadSha256,
      startMs,
      durationMs: Math.min(segmentMs, durationMs == null ? segmentMs : Math.max(0, durationMs - startMs)),
      overlay: 'rfe-proof-burned-in',
      overlayProfile: profileName,
      overlayAsset: overlayPath,
      proof,
      previousSegmentHash: previous.previousSegmentHash,
      previousTxHash: previous.previousTxHash,
      payloadFields: {
        visiblePayloadLabel,
        visibleHashLabel: 'MANIFEST',
        finalPayloadBytes: bytes,
        finalPayloadKilobytes: formatKilobytes(bytes),
        finalPayloadSha256: payloadSha256,
      },
    })
  manifest.updatedAt = new Date().toISOString()
  atomicWriteJson(manifestPath, manifest)
  console.log(`seq ${sequence}: ${bytes} bytes / ${estimatedBlobs} blob(s), proof overlay burned in`)

  generated += 1
  if (pace) {
    const waitMs = wallStart + ((sequence - startSeq + 1) * segmentMs) - Date.now()
    if (waitMs > 0) await sleep(waitMs)
  }
}

manifest.completedAt = new Date().toISOString()
manifest.updatedAt = manifest.completedAt
atomicWriteJson(manifestPath, manifest)
console.log(`complete: ${generated} composited segment(s) generated`)
