import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { bytesToHex, toBlobs } from 'viem'

const profiles = {
  '360p24': { width: 640, height: 360, fps: 24, videoBitrate: '420k', maxBlobs: 6 },
  '480p24': { width: 854, height: 480, fps: 24, videoBitrate: '650k', maxBlobs: 6 },
  '720p24': { width: 1280, height: 720, fps: 24, videoBitrate: '900k', maxBlobs: 6 },
}

const profileOrder = ['360p24', '480p24', '720p24']
const bitrateLadders = {
  '360p24': ['420k', '360k', '300k', '240k', '180k'],
  '480p24': ['650k', '560k', '480k', '400k', '320k'],
  '720p24': ['900k', '760k', '640k', '520k', '420k'],
}

function usage() {
  console.error(`Usage:
  pnpm live:run -- --input <video> --stream-id <id> [--profile 360p24] [--segment-ms 12000]
                    [--publish] [--reset] [--no-audio] [--out-dir <dir>]
                    [--max-blobs 6] [--max-bytes 761856] [--no-adaptive]

Profiles:
  360p24: 640x360 AV1 WebM @ 420k, 6 blob cap
  480p24: 854x480 AV1 WebM @ 650k, 6 blob cap
  720p24: 1280x720 AV1 WebM @ 900k, 6 blob cap

By default, live:run adapts downward when encoded segments exceed the blob budget:
requested profile -> lower bitrates -> lower profiles -> shorter segment durations.
Use --no-adaptive to fail instead.

Without --publish, live:run only segments and validates local output.
With --publish, it submits produced segments through Station.
`)
  process.exit(1)
}

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return process.argv[idx + 1]
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function runStep(label, args, status, statusPath) {
  return new Promise((resolve, reject) => {
    status.phase = label
    status.updatedAt = new Date().toISOString()
    writeStatus(statusPath, status)

    console.log(`\n== ${label} ==`)
    console.log(`${process.execPath} ${args.join(' ')}`)
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, GAS_LIMIT: process.env.GAS_LIMIT || '180000' },
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} failed with exit code ${code}`))
    })
  })
}

function writeStatus(statusPath, status) {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true })
  fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`)
}

function readSegments(segmentManifestPath) {
  if (!fs.existsSync(segmentManifestPath)) return []
  const manifest = JSON.parse(fs.readFileSync(segmentManifestPath, 'utf8'))
  return manifest.segments || []
}

function estimateBlobs(file) {
  const payload = fs.readFileSync(file)
  return toBlobs({ data: bytesToHex(payload) }).length
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null))]
}

function lowerOrEqualProfiles(profileName) {
  const idx = profileOrder.indexOf(profileName)
  if (idx === -1) return [profileName]
  return profileOrder.slice(0, idx + 1).reverse()
}

function segmentDurations(baseSegmentMs) {
  const shorter = [10_000, 8_000, 6_000, 4_000].filter((value) => value < baseSegmentMs)
  return unique([baseSegmentMs, ...shorter])
}

function adaptiveCandidates({ profileName, requestedVideoBitrate, segmentMs, adaptive }) {
  if (!adaptive) {
    return [
      {
        profileName,
        profile: profiles[profileName],
        videoBitrate: requestedVideoBitrate,
        segmentMs,
      },
    ]
  }

  const candidates = []
  for (const candidateProfileName of lowerOrEqualProfiles(profileName)) {
    const candidateProfile = profiles[candidateProfileName]
    const bitrateCandidates = unique([
      candidateProfileName === profileName ? requestedVideoBitrate : undefined,
      ...(bitrateLadders[candidateProfileName] || [candidateProfile.videoBitrate]),
    ])
    for (const candidateSegmentMs of segmentDurations(segmentMs)) {
      for (const videoBitrate of bitrateCandidates) {
        candidates.push({
          profileName: candidateProfileName,
          profile: candidateProfile,
          videoBitrate,
          segmentMs: candidateSegmentMs,
        })
      }
    }
  }
  return candidates
}

function attemptDirFor(outDir, index, candidate) {
  const parent = path.dirname(outDir)
  const base = path.basename(outDir)
  const label = `${String(index).padStart(2, '0')}-${candidate.profileName}-${candidate.segmentMs}ms-${candidate.videoBitrate}`
  return path.join(parent, '.adaptive-attempts', `${base}-${label}`)
}

function removeDirIfExists(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

function copyChosenAttempt({ attemptDir, outDir, streamId }) {
  removeDirIfExists(outDir)
  fs.mkdirSync(outDir, { recursive: true })

  const files = fs.readdirSync(attemptDir)
  for (const name of files) {
    const source = path.join(attemptDir, name)
    const target = path.join(outDir, name)
    if (fs.statSync(source).isFile()) fs.copyFileSync(source, target)
  }

  const manifestPath = path.join(outDir, `${streamId}.segments.json`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.outDir = outDir
  manifest.segments = manifest.segments.map((segment) => ({
    ...segment,
    file: path.join(outDir, path.basename(segment.file)),
  }))
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function summarizeSegments({ segments, maxBytes, maxBlobs }) {
  return segments.map((segment) => {
    const estimatedBlobs = estimateBlobs(segment.file)
    return {
      ...segment,
      estimatedBlobs,
      overBudget: segment.bytes > maxBytes || estimatedBlobs > maxBlobs,
    }
  })
}

const input = arg('input')
const streamId = arg('stream-id')
if (!input || !streamId) usage()

const profileName = arg('profile', '360p24')
const profile = profiles[profileName]
if (!profile) throw new Error(`Unknown profile "${profileName}". Choose one of: ${Object.keys(profiles).join(', ')}`)

const segmentMs = Number(arg('segment-ms', '12000'))
const publish = hasFlag('publish')
const reset = hasFlag('reset')
const noAudio = hasFlag('no-audio')
const adaptive = !hasFlag('no-adaptive')
const codec = noAudio ? 'av1/webm' : 'av1-opus/webm'
const safeStreamId = sanitize(streamId)
const outDir = path.resolve(arg('out-dir', `work/blob-radio-testnet/live-runs/${safeStreamId}/segments`))
const statusPath = path.resolve(arg('status', `work/blob-radio-testnet/live-runs/${safeStreamId}/status.json`))
const statePath = path.resolve(arg('state', `work/blob-radio-testnet/live-runs/${safeStreamId}/publish-state.json`))
const segmentManifestPath = path.join(outDir, `${safeStreamId}.segments.json`)
const maxBlobs = Number(arg('max-blobs', String(profile.maxBlobs)))
const maxBytes = Number(arg('max-bytes', String(maxBlobs * 126_976)))
const requestedVideoBitrate = arg('video-bitrate', profile.videoBitrate)
const audioBitrate = arg('audio-bitrate', '32k')

if (!fs.existsSync(path.resolve(input))) throw new Error(`Input not found: ${path.resolve(input)}`)
if (publish && !process.env.STATION_ADDRESS) throw new Error('STATION_ADDRESS is required when using --publish')

if (reset && fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true })
}
if (reset && fs.existsSync(statePath)) {
  fs.rmSync(statePath, { force: true })
}

const status = {
  app: 'eth-radio',
  kind: 'live-run',
  streamId,
  profile: profileName,
  input: path.resolve(input),
  outDir,
  statusPath,
  statePath,
  segmentMs,
  codec,
  publish,
  adaptive,
  requestedProfile: profileName,
  requestedVideoBitrate,
  maxBlobs,
  maxBytes,
  phase: 'starting',
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  attempts: [],
  segments: [],
  warnings: [],
}
writeStatus(statusPath, status)

try {
  const candidates = adaptiveCandidates({
    profileName,
    requestedVideoBitrate,
    segmentMs,
    adaptive,
  })

  let chosen = null
  for (const [index, candidate] of candidates.entries()) {
    const attemptDir = attemptDirFor(outDir, index, candidate)
    removeDirIfExists(attemptDir)

    const segmentArgs = [
      'scripts/segment-av1-webm.mjs',
      '--input',
      input,
      '--out-dir',
      attemptDir,
      '--stream-id',
      safeStreamId,
      '--segment-ms',
      String(candidate.segmentMs),
      '--width',
      String(candidate.profile.width),
      '--height',
      String(candidate.profile.height),
      '--fps',
      String(candidate.profile.fps),
      '--video-bitrate',
      candidate.videoBitrate,
    ]
    if (noAudio) segmentArgs.push('--no-audio')
    else segmentArgs.push('--audio-bitrate', audioBitrate)

    const attempt = {
      index,
      profile: candidate.profileName,
      segmentMs: candidate.segmentMs,
      videoBitrate: candidate.videoBitrate,
      width: candidate.profile.width,
      height: candidate.profile.height,
      fps: candidate.profile.fps,
      outDir: attemptDir,
      startedAt: new Date().toISOString(),
      phase: 'segmenting',
    }
    status.attempts.push(attempt)
    writeStatus(statusPath, status)

    await runStep(`segmenting attempt ${index + 1}/${candidates.length}`, segmentArgs, status, statusPath)

    const attemptManifestPath = path.join(attemptDir, `${safeStreamId}.segments.json`)
    const attemptSegments = summarizeSegments({
      segments: readSegments(attemptManifestPath),
      maxBytes,
      maxBlobs,
    })
    const overBudget = attemptSegments.filter((segment) => segment.overBudget)
    attempt.phase = overBudget.length ? 'over-budget' : 'accepted'
    attempt.completedAt = new Date().toISOString()
    attempt.segmentCount = attemptSegments.length
    attempt.maxSegmentBytes = Math.max(0, ...attemptSegments.map((segment) => segment.bytes))
    attempt.maxEstimatedBlobs = Math.max(0, ...attemptSegments.map((segment) => segment.estimatedBlobs))
    attempt.overBudgetSequences = overBudget.map((segment) => segment.sequence)
    writeStatus(statusPath, status)

    if (!overBudget.length) {
      chosen = { candidate, attemptDir, segments: attemptSegments }
      break
    }
  }

  if (!chosen) {
    status.warnings.push(
      `No adaptive candidate fit within ${maxBlobs} blob(s) / ${maxBytes} byte(s). Try a lower source complexity, lower --max-blobs cap only if the chain budget allows it, or use shorter/manual settings.`,
    )
    throw new Error(`No adaptive encode fit within budget. See ${statusPath}`)
  }

  copyChosenAttempt({ attemptDir: chosen.attemptDir, outDir, streamId: safeStreamId })
  status.profile = chosen.candidate.profileName
  status.videoBitrate = chosen.candidate.videoBitrate
  status.segmentMs = chosen.candidate.segmentMs
  status.width = chosen.candidate.profile.width
  status.height = chosen.candidate.profile.height
  status.fps = chosen.candidate.profile.fps
  status.chosenAttempt = {
    profile: chosen.candidate.profileName,
    videoBitrate: chosen.candidate.videoBitrate,
    segmentMs: chosen.candidate.segmentMs,
    width: chosen.candidate.profile.width,
    height: chosen.candidate.profile.height,
    fps: chosen.candidate.profile.fps,
  }
  status.segments = summarizeSegments({
    segments: readSegments(segmentManifestPath),
    maxBytes,
    maxBlobs,
  })

  if (
    chosen.candidate.profileName !== profileName ||
    chosen.candidate.videoBitrate !== requestedVideoBitrate ||
    chosen.candidate.segmentMs !== segmentMs
  ) {
    status.warnings.push(
      `Adapted from ${profileName} ${requestedVideoBitrate} ${segmentMs}ms to ${chosen.candidate.profileName} ${chosen.candidate.videoBitrate} ${chosen.candidate.segmentMs}ms.`,
    )
  }

  status.phase = publish ? 'segmented' : 'complete'
  status.updatedAt = new Date().toISOString()
  writeStatus(statusPath, status)

  if (publish) {
    await runStep(
      'publishing',
      [
        'scripts/publish-live-segments.mjs',
        '--dir',
        outDir,
        '--stream-id',
        safeStreamId,
        '--segment-ms',
        String(chosen.candidate.segmentMs),
        '--codec',
        codec,
        '--max-blobs',
        String(maxBlobs),
        '--max-bytes',
        String(maxBytes),
        '--state',
        statePath,
        '--exit-when-caught-up',
        ...(reset ? ['--reset'] : []),
      ],
      status,
      statusPath,
    )
    status.publishState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null
  }

  status.phase = 'complete'
  status.completedAt = new Date().toISOString()
  status.updatedAt = status.completedAt
  writeStatus(statusPath, status)
  console.log(`status: ${statusPath}`)
} catch (error) {
  status.phase = 'failed'
  status.error = error.message
  status.updatedAt = new Date().toISOString()
  writeStatus(statusPath, status)
  throw error
}
