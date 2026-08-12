import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import { bytesToHex, createPublicClient, http, toBlobs } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { resolveSegmentSet, withFilesystemIdentity } from '../../scripts/lib/filesystem-identity.mjs'
import { atomicWriteJson } from '../../scripts/lib/publisher-safety.mjs'
import { readOptionalSegmentManifest, readPublisherJobConfig, readPublisherProgress } from './lib/runtime-schema.mjs'
import { reconcileSegmentResume, sourceIdentity } from './lib/segment-reconciliation.mjs'

const profileMap = {
  '360p': { width: 640, height: 360, fps: 24 },
  '480p': { width: 854, height: 480, fps: 24 },
  '720p': { width: 1280, height: 720, fps: 24 },
}

const configPath = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (!configPath || !fs.existsSync(configPath)) throw new Error('A persisted job configuration path is required')
if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve an ffmpeg binary')
const config = readPublisherJobConfig(configPath, { role: 'media' })
const profile = profileMap[config.profile]
if (!profile) throw new Error(`Unsupported profile ${config.profile}`)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outDir = path.resolve(config.segmentDir)
fs.mkdirSync(outDir, { recursive: true })
const segmentSet = resolveSegmentSet({ directory: outDir, streamId: config.streamId })
const filePrefix = segmentSet.identity.key
const manifestPath = path.join(outDir, `${filePrefix}.segments.json`)
const chain = config.chain === 'mainnet' ? mainnet : sepolia
const publicClient = createPublicClient({ chain, transport: http(config.executionRpcUrl, { timeout: 30_000 }) })
const publisherAddress = process.env.RFE_PUBLISHER_ADDRESS || null
const maxBytes = Math.min(config.maxBlobs * 126_976, config.maxBytes || Number.MAX_SAFE_INTEGER)
let child = null
let stopping = false
let lastProof = null

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function probeDurationMs(inputPath) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', inputPath], { encoding: 'utf8' })
  const match = `${result.stderr || ''}\n${result.stdout || ''}`.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) throw new Error('Could not determine source duration')
  return Math.round(((Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3])) * 1000)
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/,/g, '\\,')
}

function rgba(hex, opacity) {
  return `0x${hex.slice(1)}@${Math.max(0.1, Math.min(1, opacity / 100)).toFixed(2)}`
}

function short(value, head = 10, tail = 6) {
  const text = String(value || '--')
  return text.length > head + tail + 3 ? `${text.slice(0, head)}...${text.slice(-tail)}` : text
}

function drawText(text, x, y, size, color = 'white') {
  const font = process.platform === 'win32'
    ? "fontfile='C\\:/Windows/Fonts/consola.ttf'"
    : "font='monospace'"
  return `drawtext=${font}:text='${escapeText(text)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}`
}

function overlayFilters({ proof, sequence, mediaIndex, totalSegments }) {
  if (!config.overlay.enabled) return []
  const { width, height } = profile
  const scale = width / 640
  const px = (value) => Math.round(value * scale)
  const accent = rgba(config.overlay.accent, 100)
  const panel = rgba('#0b0d14', config.overlay.opacity)
  const fields = []
  if (config.overlay.showNetwork) fields.push(config.chain.toUpperCase())
  if (config.overlay.showUtc) fields.push(`ENCODED ${proof.utc}`)
  if (config.overlay.showBlockNumber) fields.push(`BLOCK ${proof.blockNumber}`)
  if (config.overlay.showBlockHash) fields.push(`HEAD ${short(proof.blockHash)}`)
  fields.push(`WITNESS ${String(proof.quality || 'unavailable').toUpperCase()}`)
  if (config.overlay.showSegment) fields.push(`SEG ${mediaIndex + 1}/${totalSegments}`)
  if (config.overlay.showStreamId) fields.push(`STREAM ${short(config.streamId, 18, 6)}`)
  const title = config.overlay.title || 'RADIO FREE ETHEREUM'
  const subtitle = config.overlay.subtitle || 'PUBLIC SIGNAL'

  if (config.overlay.layout === 'minimal') {
    return [
      `drawbox=x=${px(14)}:y=${px(14)}:w=${px(318)}:h=${px(42)}:color=${panel}:t=fill`,
      `drawbox=x=${px(14)}:y=${px(14)}:w=${px(4)}:h=${px(42)}:color=${accent}:t=fill`,
      drawText(title, px(26), px(20), px(12)),
      drawText(fields.slice(0, 2).join('  /  '), px(26), px(38), px(7), '0xc8ccdc'),
    ]
  }

  const bottomY = config.overlay.layout === 'lower-third' ? height - px(82) : height - px(64)
  const filters = [
    `drawbox=x=0:y=${bottomY}:w=${width}:h=${height - bottomY}:color=${panel}:t=fill`,
    `drawbox=x=0:y=${bottomY}:w=${px(6)}:h=${height - bottomY}:color=${accent}:t=fill`,
    drawText(title, px(20), bottomY + px(10), px(13)),
    drawText(subtitle, px(20), bottomY + px(31), px(7), '0xb9bed0'),
    drawText(fields.join('  /  '), px(196), bottomY + px(18), px(7), '0xd7daf0'),
  ]
  if (config.overlay.layout === 'terminal') {
    filters.unshift(
      `drawbox=x=0:y=0:w=${width}:h=${px(28)}:color=${panel}:t=fill`,
      `drawbox=x=0:y=${px(27)}:w=${width}:h=${px(1)}:color=${accent}:t=fill`,
      drawText(`${config.chain.toUpperCase()} / ${short(config.stationAddress, 10, 6)}`, px(16), px(9), px(7), '0xc8ccdc'),
      drawText(`PUBLISHER ${short(publisherAddress, 10, 6)} / CHAIN SEQ ${sequence}`, px(352), px(9), px(7), '0xc8ccdc'),
    )
  }
  return filters
}

async function proofContext() {
  const utc = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  try {
    const block = await publicClient.getBlock({ blockTag: 'latest' })
    const ageSeconds = Math.max(0, Math.round(Date.now() / 1000 - Number(block.timestamp)))
    lastProof = {
      utc,
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      blockTimestamp: block.timestamp.toString(),
      ageSeconds,
      quality: ageSeconds > 36 ? 'delayed' : 'fresh',
      sampledAt: new Date().toISOString(),
    }
    return lastProof
  } catch (error) {
    console.warn(`overlay chain context unavailable: ${String(error.message || error).split('\n')[0]}`)
    if (lastProof) {
      return {
        ...lastProof,
        utc,
        quality: 'stale',
        staleForSeconds: Math.max(0, Math.round((Date.now() - Date.parse(lastProof.sampledAt)) / 1000)),
      }
    }
    return { utc, blockNumber: '--', blockHash: '--', quality: 'unavailable', sampledAt: new Date().toISOString() }
  }
}

async function waitForRollingCapacity(manifest) {
  const cap = Number(config.maxAheadSegments || 6)
  let announced = false
  while (!stopping) {
    let confirmed = 0
    try {
      if (fs.existsSync(config.publisherProgressPath)) {
        const publisher = readPublisherProgress(config.publisherProgressPath, {
          chain: config.chain,
          stationAddress: config.stationAddress,
          streamId: config.streamId,
        })
        confirmed = publisher?.confirmedCount || 0
      }
    } catch {
      // A concurrent atomic replacement or unavailable state simply delays the next check.
    }
    const ahead = manifest.segments.length - confirmed
    if (ahead < cap) return
    if (!announced) {
      console.log(`rolling buffer full: ${ahead}/${cap} segment(s) ahead; waiting for publisher confirmations`)
      announced = true
    }
    await sleep(750)
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    child = spawn(ffmpegPath, args, { cwd: root, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      child = null
      if (stopping) resolve(false)
      else if (code === 0) resolve(true)
      else reject(new Error(`ffmpeg exited with ${signal || code}`))
    })
  })
}

function stop() {
  stopping = true
  if (child && !child.killed) child.kill('SIGTERM')
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

const durationMs = probeDurationMs(config.sourcePath)
const totalSegments = Math.ceil(durationMs / config.segmentMs)
const currentSourceIdentity = sourceIdentity(config.sourcePath)
const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
  sourceIdentity: currentSourceIdentity,
  streamId: config.streamId,
  profile: config.profile,
  segmentMs: config.segmentMs,
  overlay: config.overlay,
})).digest('hex')

let manifest = readOptionalSegmentManifest(manifestPath, { streamId: config.streamId, segmentDir: outDir })
if (manifest && manifest.configFingerprint !== fingerprint) {
  throw new Error('Existing segment manifest belongs to different source or overlay settings')
}
manifest ||= withFilesystemIdentity({
  app: 'eth-radio-private-console',
  kind: 'publisher-console-segments',
  streamId: config.streamId,
  filePrefix,
  input: config.sourcePath,
  sourceIdentity: currentSourceIdentity,
  outDir,
  segmentMs: config.segmentMs,
  codec: 'av1-opus/webm',
  configFingerprint: fingerprint,
  durationMs,
  totalSegments,
  pipelineMode: 'rolling-parallel',
  overlayBurnedIn: Boolean(config.overlay.enabled),
  maxAheadSegments: config.maxAheadSegments || 6,
  createdAt: new Date().toISOString(),
  segments: [],
}, segmentSet.identity)
manifest.overlayBurnedIn ??= Boolean(config.overlay.enabled)
let confirmedCount = 0
if (fs.existsSync(config.publisherProgressPath)) {
  confirmedCount = readPublisherProgress(config.publisherProgressPath, {
    chain: config.chain, stationAddress: config.stationAddress, streamId: config.streamId,
  }).confirmedCount
}
reconcileSegmentResume({
  manifest, segmentDir: outDir, startSequence: Number(config.startSequence || 0),
  mode: 'finite', confirmedCount, expectedSourceIdentity: currentSourceIdentity,
})
atomicWriteJson(manifestPath, manifest)

console.log(`source: ${config.sourcePath}`)
console.log(`segments: ${manifest.segments.length}/${totalSegments}`)
console.log(`profile: ${config.profile}, ${config.segmentMs}ms, max ${config.maxBlobs} blob(s)`)

for (let mediaIndex = manifest.segments.length; mediaIndex < totalSegments && !stopping; mediaIndex += 1) {
  await waitForRollingCapacity(manifest)
  if (stopping) break
  const sequence = Number(config.startSequence || 0) + mediaIndex
  const startMs = mediaIndex * config.segmentMs
  const actualDurationMs = Math.min(config.segmentMs, durationMs - startMs)
  const finalPath = path.join(outDir, `${filePrefix}-${String(sequence).padStart(6, '0')}.webm`)
  const tempPath = `${finalPath}.tmp`
  if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
  const proof = await proofContext()
  const filterParts = [
    `fps=${profile.fps}`,
    `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease`,
    `pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2`,
    'format=yuv420p',
    ...overlayFilters({ proof, sequence, mediaIndex, totalSegments }),
  ]

  const rates = [...new Set([1, 0.85, 0.7, 0.55, 0.4].map((factor) => Math.max(48, Math.round(config.videoBitrateKbps * factor))))]
  let acceptedRate = null
  for (const rate of rates) {
    if (stopping) break
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
    console.log(`encoding segment ${mediaIndex + 1}/${totalSegments} at ${rate}k`)
    const ok = await runFfmpeg([
      '-hide_banner', '-loglevel', 'warning', '-y',
      '-ss', String(startMs / 1000), '-t', String(actualDurationMs / 1000), '-i', config.sourcePath,
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', filterParts.join(','),
      '-c:v', 'libaom-av1', '-cpu-used', '8', '-b:v', `${rate}k`,
      '-g', String(Math.max(1, Math.round(profile.fps * config.segmentMs / 1000))),
      '-keyint_min', String(Math.max(1, Math.round(profile.fps * config.segmentMs / 1000))),
      '-row-mt', '1', '-c:a', 'libopus', '-b:a', `${config.audioBitrateKbps}k`,
      '-f', 'webm', tempPath,
    ])
    if (!ok || !fs.existsSync(tempPath)) break
    const payload = fs.readFileSync(tempPath)
    const blobCount = toBlobs({ data: bytesToHex(payload) }).length
    if (payload.length <= maxBytes && blobCount <= config.maxBlobs) {
      acceptedRate = rate
      break
    }
    console.warn(`segment ${mediaIndex + 1} needs ${payload.length} bytes / ${blobCount} blobs; retrying lower`)
  }
  if (stopping) break
  if (acceptedRate == null) throw new Error(`Segment ${mediaIndex + 1} could not fit within ${config.maxBlobs} blobs`)
  fs.renameSync(tempPath, finalPath)
  const payload = fs.readFileSync(finalPath)
  const entry = {
    sequence,
    mediaIndex,
    file: finalPath,
    bytes: payload.length,
    estimatedBlobs: toBlobs({ data: bytesToHex(payload) }).length,
    payloadSha256: crypto.createHash('sha256').update(payload).digest('hex'),
    startMs,
    durationMs: actualDurationMs,
    videoBitrateKbps: acceptedRate,
    overlayBurnedIn: Boolean(config.overlay.enabled),
    overlayProof: proof,
    createdAt: new Date().toISOString(),
  }
  manifest.segments.push(entry)
  manifest.updatedAt = new Date().toISOString()
  atomicWriteJson(manifestPath, manifest)
  console.log(`ready segment ${mediaIndex + 1}: ${entry.bytes} bytes / ${entry.estimatedBlobs} blob(s)`)
}

if (!stopping && manifest.segments.length >= totalSegments) {
  manifest.completedAt = new Date().toISOString()
  manifest.updatedAt = manifest.completedAt
  atomicWriteJson(manifestPath, manifest)
  console.log('encoding complete')
}
