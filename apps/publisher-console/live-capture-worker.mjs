import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import { bytesToHex, createPublicClient, http, toBlobs } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { resolveSegmentSet, withFilesystemIdentity } from '../../scripts/lib/filesystem-identity.mjs'
import { atomicWriteJson } from '../../scripts/lib/publisher-safety.mjs'
import { readOptionalSegmentManifest, readPublisherJobConfig, readPublisherProgress } from './lib/runtime-schema.mjs'
import { reconcileSegmentResume } from './lib/segment-reconciliation.mjs'

const configPath = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (!configPath || !fs.existsSync(configPath)) throw new Error('A persisted live job configuration is required')
if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve an ffmpeg binary')
const config = readPublisherJobConfig(configPath, { role: 'media' })
if (!['screen', 'live-url'].includes(config.sourceMode)) throw new Error('Live capture worker requires screen or live-url mode')

const profiles = {
  '360p': { width: 640, height: 360, fps: 24 },
  '480p': { width: 854, height: 480, fps: 24 },
  '720p': { width: 1280, height: 720, fps: 24 },
}
const profile = profiles[config.profile]
if (!profile) throw new Error(`Unsupported profile ${config.profile}`)
const chain = config.chain === 'mainnet' ? mainnet : sepolia
const client = createPublicClient({ chain, transport: http(config.executionRpcUrl, { timeout: 10_000 }) })
const outDir = path.resolve(config.segmentDir)
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
const segmentSet = resolveSegmentSet({ directory: outDir, streamId: config.streamId })
const filePrefix = segmentSet.identity.key
const manifestPath = path.join(outDir, `${filePrefix}.segments.json`)
const witnessTextPath = path.join(outDir, 'live-witness.txt')
const maxBytes = config.maxBlobs * 126_976
let ffmpeg = null
let stopping = false
let witnessBusy = false
let currentWitness = null
const witnessByCaptureIndex = new Map()

function atomicWrite(filePath, contents) {
  const temp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temp, filePath)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function short(value, head = 10, tail = 6) {
  const text = String(value || '--')
  return text.length > head + tail + 3 ? `${text.slice(0, head)}...${text.slice(-tail)}` : text
}

function ffmpegPathValue(value) {
  return path.resolve(value).replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:')
}

function witnessLines(witness) {
  const title = config.overlay.title || 'RADIO FREE ETHEREUM'
  const subtitle = config.overlay.subtitle || 'PUBLIC SIGNAL'
  const fields = []
  if (config.overlay.showNetwork) fields.push(config.chain.toUpperCase())
  if (config.overlay.showUtc) fields.push(witness.utc)
  if (config.overlay.showBlockNumber) fields.push(`BLOCK ${witness.blockNumber}`)
  if (config.overlay.showBlockHash) fields.push(`HEAD ${short(witness.blockHash)}`)
  fields.push(`WITNESS ${witness.quality.toUpperCase()}`)
  return `${title}\n${subtitle} / ${fields.join(' / ')}`
}

async function updateWitness() {
  if (witnessBusy || stopping) return
  witnessBusy = true
  const utc = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`
  try {
    const block = await client.getBlock({ blockTag: 'latest' })
    const ageSeconds = Math.max(0, Math.round(Date.now() / 1000 - Number(block.timestamp)))
    currentWitness = {
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      blockTimestamp: block.timestamp.toString(),
      utc,
      ageSeconds,
      quality: ageSeconds > 36 ? 'delayed' : 'fresh',
      sampledAt: new Date().toISOString(),
    }
  } catch (error) {
    if (currentWitness) {
      currentWitness = {
        ...currentWitness,
        utc,
        quality: 'stale',
        staleForSeconds: Math.max(0, Math.round((Date.now() - Date.parse(currentWitness.sampledAt)) / 1000)),
      }
    } else {
      currentWitness = {
        blockNumber: '--',
        blockHash: '--',
        utc,
        quality: 'unavailable',
        sampledAt: new Date().toISOString(),
        error: String(error.message || error).split('\n')[0],
      }
    }
    console.warn(`live witness degraded to ${currentWitness.quality}; capture continues`)
  } finally {
    atomicWrite(witnessTextPath, `${witnessLines(currentWitness)}\n`)
    witnessBusy = false
  }
}

const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
  sourceMode: config.sourceMode,
  liveInputUrl: config.liveInputUrl,
  captureTarget: config.captureTarget,
  captureX: config.captureX,
  captureY: config.captureY,
  captureWidth: config.captureWidth,
  captureHeight: config.captureHeight,
  captureAudioDevice: config.captureAudioDevice,
  profile: config.profile,
  segmentMs: config.segmentMs,
  videoBitrateKbps: config.videoBitrateKbps,
  audioBitrateKbps: config.audioBitrateKbps,
  overlay: config.overlay,
})).digest('hex')

let manifest = readOptionalSegmentManifest(manifestPath, { streamId: config.streamId, segmentDir: outDir })
if (manifest && manifest.configFingerprint !== fingerprint) throw new Error('Existing live manifest belongs to different capture settings')
manifest ||= withFilesystemIdentity({
  app: 'eth-radio-private-console',
  kind: 'publisher-console-live-segments',
  streamId: config.streamId,
  filePrefix,
  input: config.sourceMode === 'screen' ? 'windows-desktop' : config.liveInputUrl,
  sourceMode: config.sourceMode,
  outDir,
  segmentMs: config.segmentMs,
  codec: 'av1-opus/webm',
  configFingerprint: fingerprint,
  pipelineMode: 'continuous-live',
  overlayBurnedIn: Boolean(config.overlay.enabled),
  totalSegments: null,
  nextCaptureIndex: 0,
  droppedSegments: [],
  createdAt: new Date().toISOString(),
  segments: [],
}, segmentSet.identity)
manifest.nextCaptureIndex ||= 0
manifest.droppedSegments ||= []
manifest.overlayBurnedIn ??= Boolean(config.overlay.enabled)
delete manifest.pausedAt
let confirmedCount = 0
if (fs.existsSync(config.publisherProgressPath)) {
  confirmedCount = readPublisherProgress(config.publisherProgressPath, {
    chain: config.chain, stationAddress: config.stationAddress, streamId: config.streamId,
  }).confirmedCount
}
reconcileSegmentResume({
  manifest, segmentDir: outDir, startSequence: Number(config.startSequence || 0), mode: 'live', confirmedCount,
})
atomicWriteJson(manifestPath, manifest)

function overlayFilter() {
  if (!config.overlay.enabled) return ''
  const scale = profile.width / 640
  const px = (value) => Math.round(value * scale)
  const opacity = Math.max(0.1, Math.min(1, config.overlay.opacity / 100)).toFixed(2)
  const panel = `0x0b0d14@${opacity}`
  const accent = `0x${config.overlay.accent.slice(1)}@1`
  const font = process.platform === 'win32'
    ? "fontfile='C\\:/Windows/Fonts/consola.ttf'"
    : "font='monospace'"
  const textFile = ffmpegPathValue(witnessTextPath)
  if (config.overlay.layout === 'minimal') {
    return [
      `drawbox=x=${px(14)}:y=${px(14)}:w=${px(380)}:h=${px(50)}:color=${panel}:t=fill`,
      `drawbox=x=${px(14)}:y=${px(14)}:w=${px(4)}:h=${px(50)}:color=${accent}:t=fill`,
      `drawtext=${font}:textfile='${textFile}':reload=1:x=${px(26)}:y=${px(20)}:fontsize=${px(9)}:line_spacing=${px(4)}:fontcolor=white`,
    ].join(',')
  }
  const y = profile.height - px(config.overlay.layout === 'lower-third' ? 82 : 64)
  return [
    `drawbox=x=0:y=${y}:w=${profile.width}:h=${profile.height - y}:color=${panel}:t=fill`,
    `drawbox=x=0:y=${y}:w=${px(6)}:h=${profile.height - y}:color=${accent}:t=fill`,
    `drawtext=${font}:textfile='${textFile}':reload=1:x=${px(20)}:y=${y + px(10)}:fontsize=${px(9)}:line_spacing=${px(5)}:fontcolor=white`,
  ].join(',')
}

function inputArgs() {
  if (config.sourceMode === 'screen') {
    const args = ['-f', 'gdigrab', '-framerate', String(profile.fps)]
    if (config.captureTarget === 'region') {
      args.push(
        '-offset_x', String(config.captureX), '-offset_y', String(config.captureY),
        '-video_size', `${config.captureWidth}x${config.captureHeight}`,
      )
    }
    args.push('-i', 'desktop')
    if (config.captureAudioDevice) args.push('-f', 'dshow', '-i', `audio=${config.captureAudioDevice}`)
    return args
  }
  return ['-i', config.liveInputUrl]
}

function outputArgs(startNumber) {
  const overlay = overlayFilter()
  const base = [
    '-filter_complex', `[0:v]fps=${profile.fps},scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p${overlay ? `,${overlay}` : ''}[v]`,
    '-map', '[v]',
  ]
  if (config.sourceMode === 'screen' && config.captureAudioDevice) base.push('-map', '1:a:0?')
  else if (config.sourceMode === 'live-url') base.push('-map', '0:a:0?')
  else base.push('-an')
  base.push(
    '-c:v', 'libaom-av1', '-cpu-used', '8', '-b:v', `${config.videoBitrateKbps}k`,
    '-g', String(Math.max(1, Math.round(profile.fps * config.segmentMs / 1000))),
    '-keyint_min', String(Math.max(1, Math.round(profile.fps * config.segmentMs / 1000))),
    '-row-mt', '1',
  )
  if (!(config.sourceMode === 'screen' && !config.captureAudioDevice)) base.push('-c:a', 'libopus', '-b:a', `${config.audioBitrateKbps}k`)
  base.push(
    '-f', 'segment', '-segment_format', 'webm', '-segment_time', String(config.segmentMs / 1000),
    '-segment_start_number', String(startNumber), '-reset_timestamps', '1',
    path.join(outDir, 'capture-%06d.part.webm'),
  )
  return base
}

function partEntries() {
  return fs.readdirSync(outDir)
    .map((name) => {
      const match = name.match(/^capture-(\d+)\.part\.webm$/)
      return match ? { captureIndex: Number(match[1]), file: path.join(outDir, name) } : null
    })
    .filter(Boolean)
    .sort((left, right) => left.captureIndex - right.captureIndex)
}

function rememberOpenParts() {
  for (const part of partEntries()) {
    if (!witnessByCaptureIndex.has(part.captureIndex)) witnessByCaptureIndex.set(part.captureIndex, { ...currentWitness })
  }
}

function finalizePart(part) {
  if (part.captureIndex < manifest.nextCaptureIndex) return
  if (config.liveMaxSegments && manifest.segments.length >= config.liveMaxSegments) {
    manifest.nextCaptureIndex = part.captureIndex + 1
    fs.rmSync(part.file, { force: true })
    return
  }
  const payload = fs.readFileSync(part.file)
  const blobs = payload.length ? toBlobs({ data: bytesToHex(payload) }) : []
  const witness = witnessByCaptureIndex.get(part.captureIndex) || currentWitness
  manifest.nextCaptureIndex = part.captureIndex + 1
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
    // Treat a concurrent publisher-state replacement as no new confirmation.
  }
  const ahead = manifest.segments.length - confirmed
  const backlogFull = ahead >= Number(config.maxAheadSegments || 6)
  if (backlogFull || !payload.length || payload.length > maxBytes || blobs.length < 1 || blobs.length > config.maxBlobs) {
    const reason = backlogFull
      ? `rolling publication buffer is full at ${ahead} segment(s) ahead`
      : 'live segment exceeded its publication envelope'
    manifest.droppedSegments.push({
      captureIndex: part.captureIndex,
      bytes: payload.length,
      blobCount: blobs.length,
      reason,
      overlayBurnedIn: Boolean(config.overlay.enabled),
      witness,
      droppedAt: new Date().toISOString(),
    })
    fs.rmSync(part.file, { force: true })
    manifest.updatedAt = new Date().toISOString()
    atomicWriteJson(manifestPath, manifest)
    console.warn(`dropped capture segment ${part.captureIndex}: ${reason}; capture continues`)
    return
  }
  const sequence = Number(config.startSequence || 0) + manifest.segments.length
  const finalPath = path.join(outDir, `${filePrefix}-${String(sequence).padStart(6, '0')}.webm`)
  fs.renameSync(part.file, finalPath)
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex')
  manifest.segments.push({
    sequence,
    captureIndex: part.captureIndex,
    file: finalPath,
    bytes: payload.length,
    estimatedBlobs: blobs.length,
    payloadSha256: sha256,
    durationMs: config.segmentMs,
    overlayBurnedIn: Boolean(config.overlay.enabled),
    witness,
    createdAt: new Date().toISOString(),
  })
  manifest.updatedAt = new Date().toISOString()
  atomicWriteJson(manifestPath, manifest)
  console.log(`live segment ${sequence}: ${payload.length} bytes / ${blobs.length} blob(s), witness ${witness?.quality || 'unavailable'}`)
}

async function monitorParts(childDone) {
  while (!stopping && !childDone.done) {
    rememberOpenParts()
    const parts = partEntries()
    for (const part of parts.slice(0, -1)) finalizePart(part)
    if (config.liveMaxSegments && manifest.segments.length >= config.liveMaxSegments) {
      stopping = true
      if (ffmpeg?.stdin?.writable) ffmpeg.stdin.write('q\n')
      break
    }
    await sleep(250)
  }
  await childDone.promise
  rememberOpenParts()
  for (const part of partEntries()) finalizePart(part)
}

function startFfmpeg() {
  const startNumber = manifest.nextCaptureIndex
  const args = ['-hide_banner', '-loglevel', 'warning', '-y', ...inputArgs(), ...outputArgs(startNumber)]
  console.log(`continuous ${config.sourceMode} capture starting at capture index ${startNumber}`)
  ffmpeg = spawn(ffmpegPath, args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true })
  const done = { done: false, code: null, signal: null }
  done.promise = new Promise((resolve, reject) => {
    ffmpeg.once('error', reject)
    ffmpeg.once('exit', (code, signal) => {
      done.done = true
      done.code = code
      done.signal = signal
      resolve()
    })
  })
  return done
}

async function requestStop() {
  if (stopping) return
  stopping = true
  if (ffmpeg?.stdin?.writable) ffmpeg.stdin.write('q\n')
  setTimeout(() => {
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGTERM')
  }, 5000).unref()
}
process.on('SIGTERM', requestStop)
process.on('SIGINT', requestStop)

await updateWitness()
const witnessTimer = setInterval(updateWitness, Math.max(2000, config.segmentMs))
const childDone = startFfmpeg()
await monitorParts(childDone)
clearInterval(witnessTimer)
manifest.pausedAt = new Date().toISOString()
manifest.updatedAt = manifest.pausedAt
atomicWriteJson(manifestPath, manifest)
if (!stopping && childDone.code !== 0) throw new Error(`live ffmpeg exited with ${childDone.signal || childDone.code}`)
console.log(`live capture stopped after ${manifest.segments.length} published-ready segment(s)`)
