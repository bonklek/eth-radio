import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import { hasFlag, numberArg, readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import { sha256FileSync } from './lib/bounded-files.mjs'
import { readExistingSegmentManifest, serializeSegmentManifest, upsertSegment } from './lib/live-segment-manifest.mjs'
import { blobCountForPayloadBytes, maxBlobsArg, segmentMsArg } from './lib/station-cli.mjs'
import { resolveSegmentSet, withFilesystemIdentity } from './lib/filesystem-identity.mjs'

const ffmpegExecutable = /** @type {string | null} */ (/** @type {unknown} */ (ffmpegPath))

function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm live:segment -- --input <video> --out-dir <segment-dir> --stream-id <id>
                       [--segment-ms 24000] [--start-seq 0] [--max-segments <count>]
                       [--width 640] [--height 360] [--fps 24]
                       [--video-bitrate 360k] [--audio-bitrate 32k] [--no-audio]
                       [--max-blobs 6] [--max-bytes 761856] [--pace] [--reset]
                       (--input-has-overlay | --allow-raw-test)

Writes one slot-aligned segment at a time and updates <stream-id>.segments.json
after each segment. Start the pipelined publisher before this generator when
running a live publish.

Overlay is mandatory for broadcast publishing. Use --input-has-overlay only
when the input video already contains the required RFE overlay in its pixels.
Use --allow-raw-test only for an explicitly approved raw publish test.
`)
  process.exit(exitCode)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temp, serializeSegmentManifest(value, filePath))
  fs.renameSync(temp, filePath)
}

function probeDurationMs(inputPath) {
  const result = spawnSync(ffmpegExecutable, ['-hide_banner', '-i', inputPath], {
    encoding: 'utf8',
  })
  const text = `${result.stderr || ''}\n${result.stdout || ''}`
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return null
  const [, hours, minutes, seconds] = match
  return Math.round(
    ((Number(hours) * 60 * 60) + (Number(minutes) * 60) + Number(seconds)) * 1000,
  )
}

function sha256(filePath, maxBytes) {
  return sha256FileSync(filePath, {
    maxBytes,
    label: `encoded segment ${filePath}`,
  })
}

if (helpRequested()) usage(0)
const input = readArg('input')
const streamId = readArg('stream-id')
if (!input || !streamId) usage()
if (!ffmpegExecutable) throw new Error('ffmpeg-static did not resolve an ffmpeg binary')

const inputPath = path.resolve(input)
if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`)

const outDir = path.resolve(readArg('out-dir', 'work/blob-radio-testnet/live-segments'))
const segmentSet = resolveSegmentSet({ directory: outDir, streamId })
const filePrefix = segmentSet.identity.key
const manifestPath = path.join(outDir, `${filePrefix}.segments.json`)
const segmentMs = segmentMsArg('24000')
const startSeq = numberArg('start-seq', '0', { integer: true, min: 0 })
const width = numberArg('width', '640', { integer: true, min: 1 })
const height = numberArg('height', '360', { integer: true, min: 1 })
const fps = numberArg('fps', '24', { min: 1 })
const videoBitrate = readArg('video-bitrate', '360k')
const audioBitrate = readArg('audio-bitrate', '32k')
const maxBlobs = maxBlobsArg('6')
const maxBytes = numberArg('max-bytes', String(maxBlobs * 126_976), { integer: true, min: 1 })
const noAudio = hasFlag('no-audio')
const pace = hasFlag('pace')
const reset = hasFlag('reset')
const inputHasOverlay = hasFlag('input-has-overlay')
const allowRawTest = hasFlag('allow-raw-test')
const maxSegmentsArg = readArg('max-segments')
const maxSegments = maxSegmentsArg !== undefined
  ? numberArg('max-segments', undefined, { integer: true, min: 1 })
  : null
const segmentSeconds = segmentMs / 1000
const durationMs = probeDurationMs(inputPath)
const manifestInvariants = {
  input: inputPath,
  outDir,
  segmentMs,
  width,
  height,
  fps,
  videoBitrate,
  audioBitrate: noAudio ? null : audioBitrate,
  codec: noAudio ? 'av1/webm' : 'av1-opus/webm',
  overlay: inputHasOverlay ? 'input-has-overlay' : 'raw-test-approved',
}

if (!inputHasOverlay && !allowRawTest) {
  throw new Error(
    'Overlay is mandatory by default. Pass --input-has-overlay for already-overlaid input, or --allow-raw-test only for an explicitly approved raw publish test.',
  )
}
if (inputHasOverlay && allowRawTest) {
  throw new Error('Choose only one of --input-has-overlay or --allow-raw-test')
}
if (!Number.isFinite(segmentMs) || segmentMs <= 0) throw new Error(`Invalid --segment-ms ${segmentMs}`)
if (!Number.isInteger(startSeq) || startSeq < 0) throw new Error(`Invalid --start-seq ${startSeq}`)
let manifest = reset
  ? null
  : readExistingSegmentManifest(manifestPath, {
      streamId,
      filePrefix,
      invariants: manifestInvariants,
    })
fs.mkdirSync(outDir, { recursive: true })
if (reset && fs.existsSync(manifestPath)) fs.rmSync(manifestPath, { force: true })

manifest ||= {
      app: 'eth-radio',
      kind: 'live-segment-set',
      streamId,
      filePrefix,
      ...manifestInvariants,
      createdAt: new Date().toISOString(),
      segments: [],
    }

manifest = withFilesystemIdentity({
  ...manifest,
  ...manifestInvariants,
  streamId,
  filePrefix,
  updatedAt: new Date().toISOString(),
}, segmentSet.identity)
atomicWriteJson(manifestPath, manifest)

console.log(`live segment generator: ${inputPath}`)
console.log(`output: ${outDir}`)
console.log(`manifest: ${manifestPath}`)
console.log(`profile: ${width}x${height} ${fps}fps AV1 WebM, segment ${segmentSeconds}s, video ${videoBitrate}${noAudio ? ', no audio' : `, audio ${audioBitrate}`}`)
if (durationMs != null) console.log(`source duration: ${durationMs}ms`)
if (pace) console.log('pace: enabled')

const wallStart = Date.now()
let generated = 0

for (let sequence = startSeq; ; sequence += 1) {
  if (maxSegments != null && generated >= maxSegments) break

  const startMs = sequence * segmentMs
  if (durationMs != null && startMs >= durationMs) break

  const finalPath = path.join(outDir, `${filePrefix}-${String(sequence).padStart(6, '0')}.webm`)
  const tempPath = `${finalPath}.tmp`

  if (fs.existsSync(finalPath) && !reset) {
    throw new Error(`Refusing to overwrite existing segment without --reset: ${finalPath}`)
  }
  if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })

  const args = [
    '-hide_banner',
    '-y',
    '-ss',
    String(startMs / 1000),
    '-t',
    String(segmentSeconds),
    '-i',
    inputPath,
    '-map',
    '0:v:0',
  ]

  if (!noAudio) args.push('-map', '0:a:0?')

  args.push(
    '-vf',
    `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
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
  )

  if (noAudio) {
    args.push('-an')
  } else {
    args.push('-c:a', 'libopus', '-b:a', audioBitrate)
  }

  args.push('-f', 'webm', tempPath)

  console.log(`\n== generating seq ${sequence} @ ${startMs}ms ==`)
  await run(ffmpegExecutable, args)

  if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size === 0) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
    console.log(`no segment produced for seq ${sequence}; stopping`)
    break
  }

  fs.renameSync(tempPath, finalPath)

  const bytes = fs.statSync(finalPath).size
  const estimatedBlobs = blobCountForPayloadBytes(bytes)
  if (bytes > maxBytes || estimatedBlobs > maxBlobs) {
    throw new Error(
      `Segment ${sequence} exceeds cap: ${bytes} bytes / ${estimatedBlobs} blob(s), cap ${maxBytes} bytes / ${maxBlobs} blob(s)`,
    )
  }

  manifest.segments = upsertSegment(manifest.segments, {
      sequence,
      file: finalPath,
      bytes,
      estimatedBlobs,
      payloadSha256: sha256(finalPath, maxBytes),
      startMs,
      durationMs: Math.min(segmentMs, durationMs == null ? segmentMs : Math.max(0, durationMs - startMs)),
    })
  manifest.updatedAt = new Date().toISOString()
  atomicWriteJson(manifestPath, manifest)
  console.log(`seq ${sequence}: ${bytes} bytes / ${estimatedBlobs} blob(s)`)

  generated += 1

  if (pace) {
    const nextDue = wallStart + ((sequence - startSeq + 1) * segmentMs)
    const waitMs = nextDue - Date.now()
    if (waitMs > 0) await sleep(waitMs)
  }
}

manifest.completedAt = new Date().toISOString()
manifest.updatedAt = manifest.completedAt
atomicWriteJson(manifestPath, manifest)
console.log(`complete: ${generated} segment(s) generated`)
