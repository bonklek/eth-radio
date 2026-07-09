import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

const root = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-live-segment-cli-'))
const input = path.join(tempRoot, 'input.mp4')
const outDir = path.join(tempRoot, 'segments')
const streamId = '../unsafe live stream'
const safeStreamId = '.._unsafe_live_stream'

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env,
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed with ${result.status}\n${output}`)
  }
  return { ...result, output }
}

function assertFailsWith(args, expected, env = {
  ...process.env,
  ETH_RPC_URL: '',
  BEACON_RPC_URL: '',
  PRIVATE_KEY: '',
}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env,
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (result.status === 0) throw new Error(`${args[0]} unexpectedly succeeded\n${output}`)
  if (!output.includes(expected)) {
    throw new Error(`${args[0]} did not report expected error "${expected}"\n${output}`)
  }
}

try {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve an ffmpeg binary')
  const compositorSource = fs.readFileSync(path.join(root, 'scripts', 'live-composite-rfe-segments.mjs'), 'utf8')
  if (!compositorSource.includes('function readOptionalPublisherState(filePath)')) {
    throw new Error('Proof compositor should guard optional publisher state reads')
  }
  if (!compositorSource.includes('function optionalPublishedSegmentSequence(segment, index, filePath)')
    || !compositorSource.includes('Ignoring invalid optional publisher state')
    || !compositorSource.includes("optionalPublishedSegmentSequence(segment, index, statePath) === sequence - 1")) {
    throw new Error('Proof compositor should skip malformed optional published entries with a warning')
  }
  if (!compositorSource.includes('Ignoring unreadable optional publisher state')) {
    throw new Error('Proof compositor should tolerate unreadable optional publisher state')
  }
  if (!compositorSource.includes('const published = state.published === undefined ? [] : state.published')
    || compositorSource.includes('return { ...state, published: state.published || [] }')
    || compositorSource.includes('[...(state?.published || [])]')) {
    throw new Error('Proof compositor should normalize optional publisher history without permissive fallbacks')
  }
  const manifestHelperSource = fs.readFileSync(path.join(root, 'scripts', 'lib', 'live-segment-manifest.mjs'), 'utf8')
  if (!manifestHelperSource.includes('segments must be an array')) {
    throw new Error('Live segment manifest helper should validate segment array shape')
  }
  for (const marker of [
    'function normalizeSegment(segment, index)',
    'export function segmentSequence(value, label)',
    'export function upsertSegment(segments, entry)',
    'manifest.segments.map((segment, index) => normalizeSegment(segment, index))',
  ]) {
    if (!manifestHelperSource.includes(marker)) {
      throw new Error(`Live segment manifest helper missing segment entry guard marker: ${marker}`)
    }
  }
  if (!manifestHelperSource.includes('const segments = manifest.segments === undefined')
    || !manifestHelperSource.includes(': manifest.segments.map((segment, index) => normalizeSegment(segment, index))')
    || manifestHelperSource.includes('manifest.segments || []')) {
    throw new Error('Live segment manifest helper should normalize segments without permissive fallback')
  }
  if (compositorSource.includes('...(manifest.segments || [])')) {
    throw new Error('Proof compositor should use normalized manifest segments without permissive fallback')
  }
  if (!compositorSource.includes('upsertSegment(manifest.segments, {')
    || !compositorSource.includes("segmentSequence(segment.sequence, 'manifest segment') === sequence - 1")
    || !compositorSource.includes("segmentSequence(segment.sequence, 'published segment')")
    || compositorSource.includes('Number(segment.sequence) !== sequence')
    || compositorSource.includes('Number(segment.sequence) === sequence - 1')
    || compositorSource.includes('Number(a.sequence) - Number(b.sequence)')) {
    throw new Error('Proof compositor should route manifest sequence comparisons through the shared normalizer')
  }
  const segmenterSource = fs.readFileSync(path.join(root, 'scripts', 'live-segment-av1-webm.mjs'), 'utf8')
  if (!segmenterSource.includes('upsertSegment(manifest.segments, {')
    || segmenterSource.includes('Number(segment.sequence) !== sequence')
    || segmenterSource.includes('Number(a.sequence) - Number(b.sequence)')) {
    throw new Error('Live segmenter should upsert manifest segments through the shared sequence normalizer')
  }

  assertFailsWith(['scripts/live-segment-av1-webm.mjs', '--input', '--stream-id', 'stream'], '--input requires a value')
  assertFailsWith(['scripts/live-composite-rfe-segments.mjs', '--input', '--stream-id', 'stream'], '--input requires a value')

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

  assertFailsWith([
    'scripts/live-segment-av1-webm.mjs',
    '--input',
    input,
    '--stream-id',
    'stream',
    '--max-segments=0',
  ], 'Invalid --max-segments: 0')
  assertFailsWith([
    'scripts/live-composite-rfe-segments.mjs',
    '--input',
    input,
    '--stream-id',
    'stream',
    '--max-segments=0',
  ], 'Invalid --max-segments: 0')

  const malformedManifestDir = path.join(tempRoot, 'malformed-manifest')
  fs.mkdirSync(malformedManifestDir, { recursive: true })
  fs.writeFileSync(path.join(malformedManifestDir, 'stream.segments.json'), '{ bad json')
  assertFailsWith([
    'scripts/live-segment-av1-webm.mjs',
    '--input',
    input,
    '--stream-id',
    'stream',
    '--out-dir',
    malformedManifestDir,
    '--segment-ms',
    '1000',
    '--max-segments=1',
    '--width',
    '64',
    '--height',
    '64',
    '--fps',
    '1',
    '--no-audio',
    '--allow-raw-test',
  ], 'Unreadable live segment manifest')

  const invalidSegmentManifestDir = path.join(tempRoot, 'invalid-segment-manifest')
  fs.mkdirSync(invalidSegmentManifestDir, { recursive: true })
  fs.writeFileSync(path.join(invalidSegmentManifestDir, 'stream.segments.json'), `${JSON.stringify({
    streamId: 'stream',
    filePrefix: 'stream',
    segments: [{ sequence: '1e2' }],
  })}\n`)
  assertFailsWith([
    'scripts/live-segment-av1-webm.mjs',
    '--input',
    input,
    '--stream-id',
    'stream',
    '--out-dir',
    invalidSegmentManifestDir,
    '--segment-ms',
    '1000',
    '--max-segments=1',
    '--width',
    '64',
    '--height',
    '64',
    '--fps',
    '1',
    '--no-audio',
    '--allow-raw-test',
  ], 'segments[0].sequence must be a non-negative integer')

  const staleCompositeDir = path.join(tempRoot, 'stale-composite-manifest')
  fs.mkdirSync(staleCompositeDir, { recursive: true })
  fs.writeFileSync(path.join(staleCompositeDir, 'stream.segments.json'), `${JSON.stringify({
    streamId: 'other-stream',
    filePrefix: 'stream',
    segments: [],
  })}\n`)
  assertFailsWith([
    'scripts/live-composite-rfe-segments.mjs',
    '--input',
    input,
    '--stream-id',
    'stream',
    '--out-dir',
    staleCompositeDir,
    '--segment-ms',
    '1000',
    '--max-segments=1',
    '--profile',
    '360p',
  ], 'does not match stream', {
    ...process.env,
    ETH_RPC_URL: 'http://127.0.0.1:1',
    BEACON_RPC_URL: '',
    PRIVATE_KEY: '',
    CHAIN: 'sepolia',
  })

  run(process.execPath, [
    'scripts/live-segment-av1-webm.mjs',
    '--input',
    input,
    '--stream-id',
    streamId,
    '--out-dir',
    outDir,
    '--segment-ms',
    '1000',
    '--max-segments=1',
    '--width',
    '64',
    '--height',
    '64',
    '--fps',
    '1',
    '--video-bitrate',
    '80k',
    '--max-blobs',
    '6',
    '--no-audio',
    '--allow-raw-test',
    '--reset',
  ])

  const manifestPath = path.join(outDir, `${safeStreamId}.segments.json`)
  if (!fs.existsSync(manifestPath)) throw new Error(`Expected manifest at ${manifestPath}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.streamId !== streamId) throw new Error(`Expected raw streamId ${streamId}, got ${manifest.streamId}`)
  if (manifest.filePrefix !== safeStreamId) throw new Error(`Expected filePrefix ${safeStreamId}, got ${manifest.filePrefix}`)
  if (!manifest.segments?.length) throw new Error('Expected at least one live segment')
  if (!manifest.segments.every((segment) => path.basename(segment.file).startsWith(`${safeStreamId}-`))) {
    throw new Error(`Unexpected segment file names: ${manifest.segments.map((segment) => segment.file).join(', ')}`)
  }

  console.log('live segment CLI tests ok')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
