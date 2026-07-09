import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { bytesToHex, toBlobs, zeroHash } from 'viem'
import { hasFlag, numberArg, readArg } from './lib/cli-args.mjs'
import { hasCostBudget, readSegmentFilesAsCostSegments, runCostPreflightOrExit } from './lib/cost-preflight.mjs'
import { makePublisherState, readPublisherStateWithRecovery } from './lib/publisher-state.mjs'

function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm live:publish -- --dir <segment-dir> --stream-id <id> [--segment-ms 12000] [--codec av1/webm]
                       [--start-seq 0] [--max-blobs 6] [--max-bytes 761856]
                       [--once] [--exit-when-caught-up] [--poll-ms 1000] [--pace]
                       [--publish-retries 5] [--retry-ms 12000] [--require-manifest]
                       [--state <state.json>] [--dry-run] [--recover-state]
                       [--max-cost-eth 0.1] [--stream-duration-ms 3600000] [--skip-wallet-balance-check]

Environment:
  ETH_RPC_URL, PRIVATE_KEY, STATION_ADDRESS, CHAIN=sepolia
`)
  process.exit(exitCode)
}

if (hasFlag('help')) usage(0)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function segmentEntries(dir, filePrefix) {
  const pattern = new RegExp(`^${escapeRegExp(filePrefix)}-(\\d+)\\.webm$`)
  return fs
    .readdirSync(dir)
    .map((name) => {
      const match = name.match(pattern)
      return match ? { sequence: Number(match[1]), file: path.join(dir, name) } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.sequence - b.sequence)
}

function manifestSegmentFile({ dir, filePrefix, sequence, segment }) {
  const fileValue = String(segment.file || '')
  if (!fileValue) throw new Error(`Manifest segment ${sequence} is missing file`)

  const file = path.isAbsolute(fileValue) ? path.resolve(fileValue) : path.resolve(dir, fileValue)
  const root = path.resolve(dir)
  const expectedName = `${filePrefix}-${String(sequence).padStart(6, '0')}.webm`
  if (path.dirname(file) !== root || path.basename(file) !== expectedName) {
    throw new Error(`Manifest segment ${sequence} points outside the watched segment file: ${fileValue}`)
  }
  return file
}

function manifestSegments(manifestPath, manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Manifest ${manifestPath} must be a JSON object`)
  }
  if (!Array.isArray(manifest.segments)) {
    throw new Error(`Manifest ${manifestPath} segments must be an array`)
  }
  return manifest.segments
}

function manifestNonNegativeInteger(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const number = Number(value)
    if (Number.isSafeInteger(number)) return number
  }
  throw new Error(`${label} must be a non-negative integer`)
}

function manifestSegmentSequence(entry, index, manifestPath) {
  return manifestNonNegativeInteger(entry?.sequence, `Manifest ${manifestPath} segment ${index} sequence`)
}

function manifestSegmentBytes(segment, sequence) {
  const bytes = manifestNonNegativeInteger(segment.bytes, `Manifest segment ${sequence} bytes`)
  if (bytes <= 0) throw new Error(`Manifest segment ${sequence} bytes must be greater than zero`)
  return bytes
}

async function waitForStableFile(file, pollMs) {
  let previous = null
  while (true) {
    const current = fs.statSync(file)
    if (current.size > 0 && previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
      return current
    }
    previous = { size: current.size, mtimeMs: current.mtimeMs }
    await sleep(Math.min(1000, Math.max(250, pollMs)))
  }
}

async function waitForManifestSegment(dir, filePrefix, sequence, pollMs, required) {
  const manifestPath = path.join(dir, `${filePrefix}.segments.json`)
  let warned = false
  while (required || fs.existsSync(manifestPath)) {
    if (!fs.existsSync(manifestPath)) {
      await sleep(Math.min(1000, Math.max(250, pollMs)))
      continue
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const segment = manifestSegments(manifestPath, manifest)
        .find((entry, index) => manifestSegmentSequence(entry, index, manifestPath) === sequence)
      if (segment) {
        const bytes = manifestSegmentBytes(segment, sequence)
        const file = manifestSegmentFile({ dir, filePrefix, sequence, segment })
        if (bytes > 0 && fs.existsSync(file)) {
          const stat = fs.statSync(file)
          if (stat.size === bytes) return { ...segment, file, bytes }
        }
      }
    } catch (error) {
      if (!warned) {
        const mode = required
          ? (error instanceof SyntaxError ? 'waiting for a valid manifest' : 'failing because --require-manifest is set')
          : 'falling back to segment file'
        console.warn(`Ignoring invalid segment manifest ${manifestPath}: ${error.message}; ${mode}`)
        warned = true
      }
      if (!required) return null
      if (!(error instanceof SyntaxError)) throw error
      await sleep(Math.min(1000, Math.max(250, pollMs)))
      continue
    }
    await sleep(Math.min(1000, Math.max(250, pollMs)))
  }
  return null
}

function runPublisher(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/publish-blob-chunk.mjs', ...args], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`publisher exited with code ${code}`))
    })
  })
}

async function runPublisherWithRetry(args, env, retries, retryMs) {
  let lastError = null
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      if (attempt > 1) console.log(`publisher retry ${attempt}/${retries}`)
      return await runPublisher(args, env)
    } catch (error) {
      lastError = error
      if (attempt === retries) break
      console.warn(`publisher attempt ${attempt}/${retries} failed: ${error.message}`)
      await sleep(retryMs)
    }
  }
  throw lastError
}

const dirArg = readArg('dir')
const streamId = readArg('stream-id')
if (!dirArg || !streamId) usage()
const safeStreamId = sanitize(streamId)

const dir = path.resolve(dirArg)
const segmentMs = numberArg('segment-ms', '12000', { min: 1 })
const codec = readArg('codec', 'av1-opus/webm')
const startSeq = numberArg('start-seq', '0', { integer: true, min: 0 })
const maxBlobs = numberArg('max-blobs', '6', { integer: true, min: 1 })
const maxBytes = numberArg('max-bytes', String(maxBlobs * 126_976), { integer: true, min: 1 })
const pollMs = numberArg('poll-ms', '1000', { integer: true, min: 1 })
const publishRetries = numberArg('publish-retries', '5', { integer: true, min: 1 })
const retryMs = numberArg('retry-ms', '12000', { integer: true, min: 0 })
const once = hasFlag('once')
const exitWhenCaughtUp = hasFlag('exit-when-caught-up')
const pace = hasFlag('pace')
const requireManifest = hasFlag('require-manifest')
const dryRun = hasFlag('dry-run')
const recoverState = hasFlag('recover-state')
const statePath = path.resolve(readArg('state', `work/blob-radio-testnet/live-state/${safeStreamId}.json`))

if (!fs.existsSync(dir)) throw new Error(`Segment directory not found: ${dir}`)
if (!dryRun && !process.env.STATION_ADDRESS) throw new Error('STATION_ADDRESS is required for live publish discovery')

if (!dryRun) fs.mkdirSync(path.dirname(statePath), { recursive: true })

let state = makePublisherState({
  streamId,
  nextSequence: startSeq,
  startSeq,
  previousSegmentHash: zeroHash,
})
if (!dryRun && fs.existsSync(statePath) && !hasFlag('reset')) {
  const recoveredState = readPublisherStateWithRecovery(statePath, state, { recover: recoverState })
  state = recoveredState.state
  if (recoveredState.recovered) {
    console.warn(`Recovered from invalid publisher state: moved ${statePath} to ${recoveredState.quarantinePath}`)
    console.warn(`Recovery status written to ${recoveredState.statusPath}`)
  }
}

function saveState() {
  if (dryRun) return
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

console.log(`live publisher watching ${dir}`)
console.log(`stream: ${streamId}`)
console.log(`next sequence: ${state.nextSequence}`)
console.log(`max blobs: ${maxBlobs}, max bytes: ${maxBytes}`)
console.log(`publish retries: ${publishRetries}, retry ms: ${retryMs}`)
console.log(`require manifest: ${requireManifest}`)
if (dryRun) console.log('dry run: validating local segment discovery and guardrails without publishing')

if (!dryRun && hasCostBudget()) {
  await runCostPreflightOrExit({
    segments: readSegmentFilesAsCostSegments(
      segmentEntries(dir, safeStreamId)
        .filter((entry) => entry.sequence >= startSeq)
        .map((entry) => entry.file),
    ),
    segmentMs,
  })
}

while (true) {
  const entry = segmentEntries(dir, safeStreamId).find((candidate) => candidate.sequence === state.nextSequence)
  if (!entry) {
    if (once || exitWhenCaughtUp) break
    await sleep(pollMs)
    continue
  }

  const manifestSegment = await waitForManifestSegment(dir, safeStreamId, state.nextSequence, pollMs, requireManifest)
  const file = manifestSegment?.file || entry.file
  if (!manifestSegment) await waitForStableFile(file, pollMs)
  const payload = fs.readFileSync(file)
  const blobs = toBlobs({ data: bytesToHex(payload) })
  const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex')

  if (payload.length > maxBytes || blobs.length > maxBlobs) {
    throw new Error(
      `Segment ${state.nextSequence} exceeds guardrails: ${payload.length} bytes, ${blobs.length} blobs; limits ${maxBytes} bytes, ${maxBlobs} blobs`,
    )
  }

  const startedAt = new Date()
  const sequence = state.nextSequence
  console.log(`${dryRun ? 'would publish' : 'publishing'} seq ${sequence}: ${payload.length} bytes, ${blobs.length} blob(s), previous ${state.previousSegmentHash}`)

  if (dryRun) {
    state.previousSegmentHash = `0x${payloadSha256}`
    state.nextSequence += 1
    if (pace) await sleep(segmentMs)
    if (once) break
    continue
  }

  const env = {
    ...process.env,
    GAS_LIMIT: process.env.GAS_LIMIT || '180000',
  }
  await runPublisherWithRetry(
    [
      '--input',
      file,
      '--stream-id',
      streamId,
      '--seq',
      String(state.nextSequence),
      '--duration-ms',
      String(segmentMs),
      '--codec',
      codec,
      '--previous-hash',
      state.previousSegmentHash,
    ],
    env,
    publishRetries,
    retryMs,
  )

  const manifestPath = path.resolve(
    `work/blob-radio-testnet/manifests/${sanitize(streamId)}-${state.nextSequence}.json`,
  )
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  state.published.push({
    sequence: state.nextSequence,
    file,
    payloadBytes: payload.length,
    payloadSha256,
    blobCount: blobs.length,
    previousSegmentHash: state.previousSegmentHash,
    txHash: manifest.txHash,
    blockNumber: manifest.blockNumber,
    startedAt: startedAt.toISOString(),
    includedAt: manifest.createdAt,
  })
  state.previousSegmentHash = `0x${payloadSha256}`
  state.nextSequence += 1
  saveState()

  if (pace) await sleep(segmentMs)
  if (once) break
}

saveState()
console.log(dryRun ? 'dry run complete: no state written' : `state: ${statePath}`)
