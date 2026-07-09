import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

const root = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-live-run-stream-id-'))
const input = path.join(tempRoot, 'input.mp4')
const outDir = path.join(tempRoot, 'segments')
const statusPath = path.join(tempRoot, 'status.json')
const streamId = '../unsafe stream'
const safeStreamId = '.._unsafe_stream'

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ETH_RPC_URL: '',
      PRIVATE_KEY: '',
      STATION_ADDRESS: '',
    },
  })
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with ${result.status}\n${result.stdout || ''}${result.stderr || ''}`)
  }
  return result
}

function assertSegmenterMissingValueGuard() {
  const result = spawnSync(process.execPath, ['scripts/segment-av1-webm.mjs', '--input', '--no-audio'], {
    cwd: root,
    encoding: 'utf8',
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (result.status === 0) throw new Error(`segmenter accepted a missing --input value\n${output}`)
  if (!output.includes('--input requires a value')) {
    throw new Error(`segmenter did not report the missing --input value clearly\n${output}`)
  }
}

function assertPublishStateSnapshotGuard() {
  const source = fs.readFileSync(path.join(root, 'scripts', 'run-live-station.mjs'), 'utf8')
  if (!source.includes('function readPublishStateSnapshot(statePath, status)')) {
    throw new Error('run-live-station should guard optional publish state status snapshots')
  }
  if (!source.includes('status.publishState = readPublishStateSnapshot(statePath, status)')) {
    throw new Error('run-live-station should not parse publish state inline after publishing')
  }
  if (source.includes("status.publishState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null")) {
    throw new Error('run-live-station reintroduced unguarded publish state parsing')
  }
}

function assertRunManifestShapeGuard() {
  const source = fs.readFileSync(path.join(root, 'scripts', 'run-live-station.mjs'), 'utf8')
  if (!source.includes('function readSegmentManifest(manifestPath)')) {
    throw new Error('run-live-station should validate segment manifest shape before use')
  }
  if (!source.includes('segments must be an array')) {
    throw new Error('run-live-station should reject segment manifests with non-array segments')
  }
  if (source.includes('return manifest.segments || []')) {
    throw new Error('run-live-station reintroduced permissive manifest segment fallback')
  }
}

try {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve an ffmpeg binary')
  assertSegmenterMissingValueGuard()
  assertPublishStateSnapshotGuard()
  assertRunManifestShapeGuard()
  run(ffmpegPath, [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x64:rate=1',
    '-t',
    '1',
    '-pix_fmt',
    'yuv420p',
    input,
  ])
  run(process.execPath, [
    'scripts/run-live-station.mjs',
    '--input',
    input,
    '--stream-id',
    streamId,
    '--out-dir',
    outDir,
    '--status',
    statusPath,
    '--segment-ms',
    '1000',
    '--profile',
    '360p24',
    '--video-bitrate',
    '180k',
    '--max-blobs',
    '6',
    '--no-audio',
    '--no-adaptive',
    '--reset',
  ])

  const manifestPath = path.join(outDir, `${safeStreamId}.segments.json`)
  if (!fs.existsSync(manifestPath)) throw new Error(`Expected manifest at ${manifestPath}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.streamId !== streamId) {
    throw new Error(`Expected manifest streamId ${streamId}, got ${manifest.streamId}`)
  }
  if (!manifest.filePrefix || manifest.filePrefix !== safeStreamId) {
    throw new Error(`Expected manifest filePrefix ${safeStreamId}, got ${manifest.filePrefix}`)
  }
  const segmentNames = fs.readdirSync(outDir).filter((name) => name.endsWith('.webm'))
  if (!segmentNames.length || !segmentNames.every((name) => name.startsWith(`${safeStreamId}-`))) {
    throw new Error(`Unexpected segment names: ${segmentNames.join(', ')}`)
  }
  console.log('live-run stream id filesystem split ok')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
