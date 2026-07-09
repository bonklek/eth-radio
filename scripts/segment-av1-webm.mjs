import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import { hasFlag, numberArg, readArg } from './lib/cli-args.mjs'

function usage() {
  console.error(`Usage:
  pnpm media:segment -- --input <video> [--out-dir work/blob-radio-testnet/live-segments] [--stream-id milady-mandate]
                       [--segment-ms 12000] [--width 640] [--height 360] [--fps 24] [--video-bitrate 420k]
                       [--audio-bitrate 32k] [--no-audio]
`)
  process.exit(1)
}

function sanitize(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_')
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

const input = readArg('input')
if (!input) usage()
if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve an ffmpeg binary')

const inputPath = path.resolve(input)
const streamId = readArg('stream-id', 'milady-mandate')
const safeStreamId = sanitize(streamId)
const outDir = path.resolve(readArg('out-dir', 'work/blob-radio-testnet/live-segments'))
const segmentMs = numberArg('segment-ms', '12000', { integer: true, min: 1 })
const segmentSeconds = segmentMs / 1000
const width = numberArg('width', '640', { integer: true, min: 1 })
const height = numberArg('height', '360', { integer: true, min: 1 })
const fps = numberArg('fps', '24', { min: 1 })
const videoBitrate = readArg('video-bitrate', '420k')
const audioBitrate = readArg('audio-bitrate', '32k')
const noAudio = hasFlag('no-audio')

if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`)
if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) {
  throw new Error(`Invalid segment duration: ${segmentMs}`)
}

fs.mkdirSync(outDir, { recursive: true })
const outputPattern = path.join(outDir, `${safeStreamId}-%06d.webm`)

const args = [
  '-hide_banner',
  '-y',
  '-i',
  inputPath,
  '-map',
  '0:v:0',
]

if (!noAudio) {
  args.push('-map', '0:a:0?')
}

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
  '-force_key_frames',
  `expr:gte(t,n_forced*${segmentSeconds})`,
)

if (noAudio) {
  args.push('-an')
} else {
  args.push('-c:a', 'libopus', '-b:a', audioBitrate)
}

args.push(
  '-f',
  'segment',
  '-segment_time',
  String(segmentSeconds),
  '-reset_timestamps',
  '1',
  '-segment_format',
  'webm',
  outputPattern,
)

console.log(`segmenting: ${inputPath}`)
console.log(`output: ${outputPattern}`)
console.log(`profile: ${width}x${height} ${fps}fps AV1 WebM, segment ${segmentSeconds}s, video ${videoBitrate}${noAudio ? ', no audio' : `, audio ${audioBitrate}`}`)

await run(ffmpegPath, args)

const files = fs
  .readdirSync(outDir)
  .filter((name) => name.startsWith(`${safeStreamId}-`) && name.endsWith('.webm'))
  .sort()
  .map((name, index) => {
    const filePath = path.join(outDir, name)
    return {
      sequence: index,
      file: filePath,
      bytes: fs.statSync(filePath).size,
    }
  })

const manifest = {
  app: 'eth-radio',
  kind: 'segment-set',
  streamId,
  filePrefix: safeStreamId,
  input: inputPath,
  outDir,
  segmentMs,
  width,
  height,
  fps,
  videoBitrate,
  audioBitrate: noAudio ? null : audioBitrate,
  codec: noAudio ? 'av1/webm' : 'av1-opus/webm',
  createdAt: new Date().toISOString(),
  segments: files,
}

const out = path.join(outDir, `${safeStreamId}.segments.json`)
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`segments: ${files.length}`)
for (const file of files) {
  console.log(`${file.sequence}: ${file.bytes} bytes ${file.file}`)
}
console.log(`segment manifest: ${out}`)
