import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { bytesToHex, toBlobs, zeroHash } from 'viem'
import { hasCostBudget, readSegmentFilesAsCostSegments, runCostPreflightOrExit } from './lib/cost-preflight.mjs'

function usage() {
  console.error(`Usage:
  pnpm live:publish -- --dir <segment-dir> --stream-id <id> [--segment-ms 12000] [--codec av1/webm]
                       [--start-seq 0] [--max-blobs 6] [--max-bytes 761856]
                       [--once] [--exit-when-caught-up] [--poll-ms 1000] [--pace]
                       [--publish-retries 5] [--retry-ms 12000] [--require-manifest]
                       [--max-cost-eth 0.1] [--stream-duration-ms 3600000]

Environment:
  ETH_RPC_URL, PRIVATE_KEY, STATION_ADDRESS, CHAIN=sepolia
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function segmentFiles(dir, streamId) {
  const prefix = `${streamId}-`
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.webm'))
    .sort()
    .map((name) => path.join(dir, name))
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

async function waitForManifestSegment(dir, streamId, sequence, pollMs, required) {
  const manifestPath = path.join(dir, `${streamId}.segments.json`)
  while (required || fs.existsSync(manifestPath)) {
    try {
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        const segment = (manifest.segments || []).find((entry) => Number(entry.sequence) === sequence)
        if (segment && segment.bytes > 0 && fs.existsSync(segment.file)) {
          const stat = fs.statSync(segment.file)
          if (stat.size === segment.bytes) return segment
        }
      }
    } catch {
      // The generator may be rewriting the manifest while we poll.
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

const dirArg = arg('dir')
const streamId = arg('stream-id')
if (!dirArg || !streamId) usage()

const dir = path.resolve(dirArg)
const segmentMs = Number(arg('segment-ms', '12000'))
const codec = arg('codec', 'av1/webm')
const startSeq = Number(arg('start-seq', '0'))
const maxBlobs = Number(arg('max-blobs', '6'))
const maxBytes = Number(arg('max-bytes', String(maxBlobs * 126_976)))
const pollMs = Number(arg('poll-ms', '1000'))
const publishRetries = Number(arg('publish-retries', '5'))
const retryMs = Number(arg('retry-ms', '12000'))
const once = hasFlag('once')
const exitWhenCaughtUp = hasFlag('exit-when-caught-up')
const pace = hasFlag('pace')
const requireManifest = hasFlag('require-manifest')
const statePath = path.resolve(arg('state', `work/blob-radio-testnet/live-state/${sanitize(streamId)}.json`))

if (!fs.existsSync(dir)) throw new Error(`Segment directory not found: ${dir}`)
if (!process.env.STATION_ADDRESS) throw new Error('STATION_ADDRESS is required for live publish discovery')

fs.mkdirSync(path.dirname(statePath), { recursive: true })

let state = {
  streamId,
  nextSequence: startSeq,
  previousSegmentHash: zeroHash,
  published: [],
}
if (fs.existsSync(statePath) && !hasFlag('reset')) {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
}

function saveState() {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

console.log(`live publisher watching ${dir}`)
console.log(`stream: ${streamId}`)
console.log(`next sequence: ${state.nextSequence}`)
console.log(`max blobs: ${maxBlobs}, max bytes: ${maxBytes}`)
console.log(`publish retries: ${publishRetries}, retry ms: ${retryMs}`)
console.log(`require manifest: ${requireManifest}`)

if (hasCostBudget()) {
  await runCostPreflightOrExit({
    segments: readSegmentFilesAsCostSegments(segmentFiles(dir, streamId).slice(startSeq)),
    segmentMs,
  })
}

while (true) {
  const files = segmentFiles(dir, streamId)
  const file = files[state.nextSequence]
  if (!file) {
    if (once || exitWhenCaughtUp) break
    await sleep(pollMs)
    continue
  }

  const manifestSegment = await waitForManifestSegment(dir, streamId, state.nextSequence, pollMs, requireManifest)
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
  console.log(`publishing seq ${state.nextSequence}: ${payload.length} bytes, ${blobs.length} blob(s), previous ${state.previousSegmentHash}`)

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
console.log(`state: ${statePath}`)
