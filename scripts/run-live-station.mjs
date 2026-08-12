import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { privateKeyToAccount } from 'viem/accounts'
import { hasFlag, numberArg, readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import { runCostPreflightOrExit, serializableCostReport } from './lib/cost-preflight.mjs'
import { blobCountForPayloadBytes, maxBlobsArg, segmentMsArg } from './lib/station-cli.mjs'
import { resolveRunDirectory, scopedStreamFilesystemIdentity, streamFilesystemIdentity, withFilesystemIdentity } from './lib/filesystem-identity.mjs'
import { installEndpointSafeProcessHandlers } from './lib/endpoint-privacy.mjs'
import { readBoundedSegmentManifest, segmentManifestEntries, serializeSegmentManifest } from './lib/live-segment-manifest.mjs'
import { readPublisherStateSnapshot } from './lib/publisher-state.mjs'
import { prepareSegmentOutputDirectory, segmentOutputEntries } from './lib/segment-output.mjs'

installEndpointSafeProcessHandlers(() => [process.env.ETH_RPC_URL, process.env.BEACON_RPC_URL].filter(Boolean))

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

function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm live:run -- --input <video> --stream-id <id> [--profile 360p24] [--segment-ms 12000]
                    [--publish] [--reset] [--no-audio] [--out-dir <dir>]
                    [--max-blobs 6] [--max-bytes 761856] [--no-adaptive]
                    [--max-cost-eth 0.1] [--cost-safety-multiplier 1.25]

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
  process.exit(exitCode)
}

if (helpRequested()) usage(0)
dotenv.config({ quiet: true })

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
  return readSegmentManifest(segmentManifestPath).segments
}

function readSegmentManifest(manifestPath) {
  const manifest = readBoundedSegmentManifest(manifestPath)
  segmentManifestEntries(manifest, manifestPath)
  return manifest
}

function readPublishStateSnapshot(statePath, status) {
  if (!fs.existsSync(statePath)) return null
  try {
    return readPublisherStateSnapshot(statePath)
  } catch (error) {
    status.warnings.push(`Could not read publisher state snapshot for status output: ${error.message}`)
    return null
  }
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

function prepareOwnedSegmentDirectory(dir, filePrefix) {
  prepareSegmentOutputDirectory(dir, filePrefix)
}

function copyChosenAttempt({ attemptDir, outDir, filePrefix }) {
  prepareOwnedSegmentDirectory(outDir, filePrefix)
  fs.mkdirSync(outDir, { recursive: true })

  for (const entry of segmentOutputEntries(attemptDir, filePrefix)) {
    fs.copyFileSync(entry.file, path.join(outDir, path.basename(entry.file)))
  }
  const sourceManifest = path.join(attemptDir, `${filePrefix}.segments.json`)
  if (!fs.existsSync(sourceManifest)) throw new Error(`Chosen attempt manifest is missing: ${sourceManifest}`)
  fs.copyFileSync(sourceManifest, path.join(outDir, path.basename(sourceManifest)))

  const manifestPath = path.join(outDir, `${filePrefix}.segments.json`)
  const manifest = readSegmentManifest(manifestPath)
  manifest.outDir = outDir
  manifest.segments = manifest.segments.map((segment) => ({
    ...segment,
    file: path.join(outDir, path.basename(segment.file)),
  }))
  fs.writeFileSync(manifestPath, serializeSegmentManifest(manifest, manifestPath))
}

function summarizeSegments({ segments, maxBytes, maxBlobs }) {
  return segments.map((segment) => {
    const bytes = fs.statSync(segment.file).size
    const estimatedBlobs = blobCountForPayloadBytes(bytes)
    return {
      ...segment,
      bytes,
      estimatedBlobs,
      overBudget: bytes > maxBytes || estimatedBlobs > maxBlobs,
    }
  })
}

const input = readArg('input')
const streamId = readArg('stream-id')
if (!input || !streamId) usage()

const profileName = readArg('profile', '360p24')
const profile = profiles[profileName]
if (!profile) throw new Error(`Unknown profile "${profileName}". Choose one of: ${Object.keys(profiles).join(', ')}`)

const segmentMs = segmentMsArg('12000')
const publish = hasFlag('publish')
const reset = hasFlag('reset')
const noAudio = hasFlag('no-audio')
const adaptive = !hasFlag('no-adaptive')
const codec = noAudio ? 'av1/webm' : 'av1-opus/webm'
const filePrefix = streamFilesystemIdentity(streamId).key
const publisher = process.env.PRIVATE_KEY
  ? privateKeyToAccount(/** @type {`0x${string}`} */ (process.env.PRIVATE_KEY)).address
  : process.env.PUBLISHER_ADDRESS
const runIdentity = scopedStreamFilesystemIdentity({ chain: process.env.CHAIN || 'sepolia', station: process.env.STATION_ADDRESS, publisher, streamId })
const outDirArg = readArg('out-dir')
const statusArg = readArg('status')
const stateArg = readArg('state')
const defaultRunDir = outDirArg && statusArg && stateArg
  ? path.join(path.resolve('work/blob-radio-testnet/live-runs'), runIdentity.key)
  : resolveRunDirectory({ baseDir: path.resolve('work/blob-radio-testnet/live-runs'), streamId, identity: runIdentity })
const outDir = path.resolve(outDirArg || path.join(defaultRunDir, 'segments'))
const statusPath = path.resolve(statusArg || path.join(defaultRunDir, 'status.json'))
const statePath = path.resolve(stateArg || path.join(defaultRunDir, 'publish-state.json'))
const segmentManifestPath = path.join(outDir, `${filePrefix}.segments.json`)
const maxBlobs = maxBlobsArg(String(profile.maxBlobs))
const maxBytes = numberArg('max-bytes', String(maxBlobs * 126_976), { integer: true, min: 1 })
const requestedVideoBitrate = readArg('video-bitrate', profile.videoBitrate)
const audioBitrate = readArg('audio-bitrate', '32k')

if (!fs.existsSync(path.resolve(input))) throw new Error(`Input not found: ${path.resolve(input)}`)
if (publish && !process.env.STATION_ADDRESS) throw new Error('STATION_ADDRESS is required when using --publish')

if (reset && fs.existsSync(outDir)) {
  prepareOwnedSegmentDirectory(outDir, filePrefix)
}
if (reset && fs.existsSync(statePath)) {
  fs.rmSync(statePath, { force: true })
}

const status = withFilesystemIdentity({
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
}, runIdentity)
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
    prepareOwnedSegmentDirectory(attemptDir, filePrefix)

    const segmentArgs = [
      'scripts/segment-av1-webm.mjs',
      '--input',
      input,
      '--out-dir',
      attemptDir,
      '--stream-id',
      streamId,
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

    const attemptManifestPath = path.join(attemptDir, `${filePrefix}.segments.json`)
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

  copyChosenAttempt({ attemptDir: chosen.attemptDir, outDir, filePrefix })
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
  const costReport = await runCostPreflightOrExit({ segments: status.segments, segmentMs: chosen.candidate.segmentMs })
  if (costReport) status.costPreflight = serializableCostReport(costReport)

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
        streamId,
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
    status.publishState = readPublishStateSnapshot(statePath, status)
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
