import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, zeroHash } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import ffmpegPath from 'ffmpeg-static'
import { hasFlag, numberArg, readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import { sha256FileSync } from './lib/bounded-files.mjs'
import { readExistingSegmentManifest, segmentSequence, serializeSegmentManifest, upsertSegment } from './lib/live-segment-manifest.mjs'
import { readPublisherStateSnapshot } from './lib/publisher-state.mjs'

const ffmpegExecutable = /** @type {string | null} */ (/** @type {unknown} */ (ffmpegPath))
import { blobCountForPayloadBytes, maxBlobsArg, segmentMsArg } from './lib/station-cli.mjs'
import { legacyFilesystemKey, resolveScopedJsonPath, resolveSegmentSet, scopedStreamFilesystemIdentity, withFilesystemIdentity } from './lib/filesystem-identity.mjs'
import { installEndpointSafeProcessHandlers } from './lib/endpoint-privacy.mjs'
import { fetchBoundedJson } from './lib/bounded-fetch.mjs'

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

function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm live:segment:overlay -- --input <video> --out-dir <segment-dir> --stream-id <id>
       [--profile 360p] [--segment-ms 24000] [--start-seq 0] [--max-segments <count>]
       [--fps 24] [--video-bitrate 96k] [--audio-bitrate 16k] [--no-audio]
       [--max-blobs 6] [--max-bytes 761856] [--pace] [--reset]

Samples real chain/beacon context for each segment, renders the RFE overlay
dynamic regions from a fixed layout contract, then writes one composited WebM
and manifest entry at a time.
`)
  process.exit(exitCode)
}

if (helpRequested()) usage(0)
dotenv.config({ quiet: true })

function fromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value)
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
  atomicWrite(filePath, serializeSegmentManifest(value, filePath))
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
  const result = spawnSync(ffmpegExecutable, ['-hide_banner', '-i', inputPath], { encoding: 'utf8' })
  const text = `${result.stderr || ''}\n${result.stdout || ''}`
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return null
  const [, hours, minutes, seconds] = match
  return Math.round(((Number(hours) * 60 * 60) + (Number(minutes) * 60) + Number(seconds)) * 1000)
}

function sha256File(filePath, maxBytes) {
  return sha256FileSync(filePath, {
    maxBytes,
    label: `encoded segment ${filePath}`,
  })
}

function short(value, head = 8, tail = 6) {
  if (!value) return '--'
  const text = String(value)
  if (text.length <= head + tail + 3) return text
  return `${text.slice(0, head)}...${text.slice(-tail)}`
}

function formatKilobytes(value) {
  const n = Number(value || 0)
  return n ? `${(n / 1000).toFixed(1)} KB` : '--'
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
    return readPublisherStateSnapshot(filePath, { label: `optional publisher state ${filePath}` })
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

function fit(text, maxChars) {
  const value = String(text || '--')
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(1, maxChars - 3))}...`
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
  return fetchBoundedJson(url, {
    maxBytes: 256 * 1024,
    timeoutMs,
    label: 'beacon head response',
  })
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
if (!ffmpegExecutable) throw new Error('ffmpeg-static did not resolve an ffmpeg binary')

const profileName = readArg('profile', '360p').toLowerCase()
const profile = profiles[profileName]
if (!profile) throw new Error(`Unsupported --profile ${profileName}; use ${Object.keys(profiles).join(', ')}`)

const inputPath = fromRoot(input)
const outDir = fromRoot(readArg('out-dir', 'work/blob-radio-testnet/live-segments'))
const segmentSet = resolveSegmentSet({ directory: outDir, streamId })
const filePrefix = segmentSet.identity.key
const manifestPath = path.join(outDir, `${filePrefix}.segments.json`)
const publisherStateArg = readArg('publisher-state')
const overlayPath = fromRoot(readArg('overlay', profile.overlay))
const segmentMs = segmentMsArg('24000')
const startSeq = numberArg('start-seq', '0', { integer: true, min: 0 })
const fps = numberArg('fps', '24', { min: 1 })
const videoBitrate = readArg('video-bitrate', '96k')
const audioBitrate = readArg('audio-bitrate', '16k')
const maxBlobs = maxBlobsArg('6')
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
installEndpointSafeProcessHandlers(() => [rpcUrl, beaconUrl].filter(Boolean))
const account = process.env.PRIVATE_KEY
  ? privateKeyToAccount(/** @type {`0x${string}`} */ (process.env.PRIVATE_KEY))
  : null
const publisherIdentity = scopedStreamFilesystemIdentity({ chain: chainName, station: process.env.STATION_ADDRESS, publisher: account?.address || process.env.PUBLISHER_ADDRESS, streamId })
const statePath = resolveScopedJsonPath({
  explicitPath: publisherStateArg,
  targetPath: fromRoot(`work/blob-radio-testnet/live-state/${publisherIdentity.key}.pipelined.json`),
  legacyPath: fromRoot(`work/blob-radio-testnet/live-state/${legacyFilesystemKey(streamId)}.pipelined.json`),
  streamId,
  identity: publisherIdentity,
  description: 'pipelined publisher state',
})

if (!chain || !rpcUrl) throw new Error('CHAIN and ETH_RPC_URL are required for proof-aware overlay generation')
if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`)
if (!fs.existsSync(overlayPath)) throw new Error(`Overlay PNG not found: ${overlayPath}`)
if (!Number.isFinite(segmentMs) || segmentMs <= 0) throw new Error(`Invalid --segment-ms ${segmentMs}`)
if (!Number.isInteger(startSeq) || startSeq < 0) throw new Error(`Invalid --start-seq ${startSeq}`)
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000 }) })
const durationMs = probeDurationMs(inputPath)
const manifestInvariants = {
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
}
let manifest = reset
  ? null
  : readExistingSegmentManifest(manifestPath, {
      streamId,
      filePrefix,
      invariants: manifestInvariants,
    })
fs.mkdirSync(outDir, { recursive: true })
if (reset && fs.existsSync(manifestPath)) fs.rmSync(manifestPath, { force: true })

manifest ||= withFilesystemIdentity({
  app: 'eth-radio',
  kind: 'live-segment-set',
  streamId,
  filePrefix,
  ...manifestInvariants,
  compositor: {
    name: 'live-composite-rfe-segments',
    version: 2,
    currentPayloadHashVisibility: 'manifest-only-noncircular',
  },
  createdAt: new Date().toISOString(),
  segments: [],
}, segmentSet.identity)
manifest = withFilesystemIdentity({
  ...manifest,
  ...manifestInvariants,
  streamId,
  filePrefix,
  updatedAt: new Date().toISOString(),
}, segmentSet.identity)
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

  const finalPath = path.join(outDir, `${filePrefix}-${String(sequence).padStart(6, '0')}.webm`)
  const tempPath = `${finalPath}.tmp`
  if (fs.existsSync(finalPath) && !reset) throw new Error(`Refusing to overwrite existing segment without --reset: ${finalPath}`)
  if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })

  manifest = readExistingSegmentManifest(manifestPath, {
    streamId,
    filePrefix,
    invariants: manifestInvariants,
  }) || manifest
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
    await run(ffmpegExecutable, ffmpegArgs({ payloadLabel: visiblePayloadLabel, outputPath: tempPath }))
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
  const estimatedBlobs = blobCountForPayloadBytes(bytes)
  if (bytes > maxBytes || estimatedBlobs > maxBlobs) {
    throw new Error(`Segment ${sequence} exceeds cap: ${bytes} bytes / ${estimatedBlobs} blob(s), cap ${maxBytes} bytes / ${maxBlobs} blob(s)`)
  }
  const payloadSha256 = sha256File(finalPath, maxBytes)

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
