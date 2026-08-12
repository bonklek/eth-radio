import 'dotenv/config'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import { formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { streamFilesystemIdentity } from '../../scripts/lib/filesystem-identity.mjs'
import { atomicWriteJson } from '../../scripts/lib/publisher-safety.mjs'
import { DEFAULT_CONFIG, environmentDefaults, normalizeConfig, publicConfig } from './lib/config.mjs'
import { publisherArmConsentDigest } from './lib/arm-consent.mjs'
import { mediaJobProjection, transactionJobProjection } from './lib/job-projections.mjs'
import { mediaProcessEnv, publisherProcessEnv } from './lib/process-capabilities.mjs'
import { publisherRestartDecision } from './lib/restart-policy.mjs'
import { ProcessLock } from './lib/process-lock.mjs'
import { quarantineCriticalStateTemps } from './lib/recovery-artifacts.mjs'
import { coordinateChildShutdown } from './lib/shutdown-coordinator.mjs'
import {
  readOptionalSegmentManifest,
  readPublisherJobConfig,
  readPublisherObservation,
  readSupervisorState,
} from './lib/runtime-schema.mjs'

const consoleDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(consoleDir, '../..')
const publicDir = path.join(consoleDir, 'public')
const runtimeDir = process.env.RFE_CONSOLE_RUNTIME_DIR
  ? path.resolve(process.env.RFE_CONSOLE_RUNTIME_DIR)
  : path.join(consoleDir, 'runtime')
const jobsDir = path.join(runtimeDir, 'jobs')
const statePath = path.join(runtimeDir, 'supervisor-state.json')
const lockPath = path.join(runtimeDir, 'supervisor.lock')
const shutdownAmbiguityPath = path.join(runtimeDir, 'shutdown-ambiguity.json')
const host = '127.0.0.1'
const port = Number(process.env.RFE_CONSOLE_PORT || process.argv.find((value) => value.startsWith('--port='))?.slice(7) || 8787)
const csrfToken = crypto.randomBytes(24).toString('hex')
const testMode = process.env.RFE_CONSOLE_TEST === '1'
const children = { encoder: null, publisher: null }
const restartTimers = { encoder: null, publisher: null }
const childStartedAt = { encoder: null, publisher: null }
let state = {
  version: 3,
  jobId: null,
  phase: 'idle',
  desired: 'idle',
  startedAt: null,
  updatedAt: new Date().toISOString(),
  encoderComplete: false,
  encoderFailures: 0,
  publisherRestarts: 0,
  publisherRestartHistory: [],
  recoveryRequired: false,
  recoveryPreviousDesired: null,
  lastError: null,
  metrics: emptyMetrics(),
}
let activeConfig = null
let activeMediaConfigPath = null
let activePublisherConfigPath = null
let activeLogPath = null
let server
let monitorTimer
let armedPreflight = null
let shuttingDown = false
let releaseLockAllowed = true

fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 })
const processLock = new ProcessLock(lockPath, {
  conflictMessage: (pid) => `Publisher console is already running as process ${pid}`,
  beforeAcquire: () => {
    if (fs.existsSync(shutdownAmbiguityPath)) {
      throw new Error('A prior supervisor shutdown left ambiguous child ownership; operator reconciliation is required before relaunch')
    }
  },
})

function emptyMetrics() {
  return {
    totalSegments: null,
    generatedSegments: 0,
    submittedSegments: 0,
    confirmedSegments: 0,
    pendingTransactions: 0,
    startupBufferTarget: 2,
    bufferReady: false,
    sourceComplete: false,
    actualSpendEth: '0',
    risk: 'idle',
    transactionHealth: 'idle',
    durabilityMode: null,
    blockedReason: null,
    aheadSegments: 0,
    droppedSegments: 0,
  }
}

function persistState() {
  state.updatedAt = new Date().toISOString()
  atomicWriteJson(statePath, state)
}

function redact(text) {
  let result = String(text ?? '')
  const secrets = [
    process.env.PRIVATE_KEY,
    activeConfig?.executionRpcUrl,
    activeConfig?.beaconRpcUrl,
    ...(activeConfig?.sendRpcUrls || []),
  ].filter(Boolean)
  for (const secret of secrets) result = result.split(secret).join('[redacted]')
  result = result.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[credentials]@')
  return result
}

function appendLog(kind, chunk) {
  if (!activeLogPath) return
  const lines = redact(chunk).replace(/\r/g, '').split('\n')
  const stamped = lines.filter(Boolean).map((line) => `${new Date().toISOString()} [${kind}] ${line}`).join('\n')
  if (stamped) fs.appendFileSync(activeLogPath, `${stamped}\n`, { encoding: 'utf8', mode: 0o600 })
}

function jobPaths(jobId = state.jobId) {
  const jobDir = path.join(jobsDir, jobId || 'none')
  const segmentDir = path.join(jobDir, 'segments')
  return {
    jobDir,
    segmentDir,
    configPath: path.join(jobDir, 'job.json'),
    mediaConfigPath: path.join(jobDir, 'media-job.json'),
    publisherConfigPath: path.join(jobDir, 'publisher-job.json'),
    publisherStatePath: path.join(jobDir, 'publisher-state.json'),
    publisherProgressPath: path.join(jobDir, 'publisher-progress.json'),
    logPath: path.join(jobDir, 'job.log'),
    manifestPath: activeConfig
      ? path.join(segmentDir, `${streamFilesystemIdentity(activeConfig.streamId).key}.segments.json`)
      : '',
  }
}

function childEnv(kind) {
  if (kind === 'encoder') {
    return mediaProcessEnv(process.env, {
      publisherAddress: process.env.PRIVATE_KEY ? privateKeyToAccount(process.env.PRIVATE_KEY).address : '',
    })
  }
  return publisherProcessEnv(process.env, { allowFaultInjection: testMode })
}

function clearRestart(kind) {
  if (restartTimers[kind]) clearTimeout(restartTimers[kind])
  restartTimers[kind] = null
}

function spawnManaged(kind, script, args) {
  if (children[kind] || !activeConfig) return
  clearRestart(kind)
  appendLog('supervisor', `starting ${kind}`)
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    env: childEnv(kind),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children[kind] = child
  childStartedAt[kind] = Date.now()
  child.stdout.on('data', (chunk) => appendLog(kind, chunk))
  child.stderr.on('data', (chunk) => appendLog(kind, chunk))
  child.once('error', (error) => appendLog(kind, error.message))
  child.once('exit', (code, signal) => {
    const runtimeMs = Math.max(0, Date.now() - Number(childStartedAt[kind] || Date.now()))
    childStartedAt[kind] = null
    children[kind] = null
    appendLog('supervisor', `${kind} exited with ${signal || code}`)
    if (shuttingDown) return persistState()
    if (kind === 'encoder' && code === 0) {
      const paths = jobPaths()
      const manifest = readOptionalSegmentManifest(paths.manifestPath, {
        streamId: activeConfig.streamId,
        segmentDir: paths.segmentDir,
      })
      state.encoderComplete = activeConfig.sourceMode === 'file' && Boolean(manifest?.completedAt)
      if (state.desired !== 'running' || state.encoderComplete) return persistState()
    }
    if (!['running', 'paused', 'draining'].includes(state.desired)) return persistState()
    if (kind === 'encoder') {
      if (state.desired !== 'running') return persistState()
      state.encoderFailures += 1
      if (state.encoderFailures >= 3) {
        state.phase = 'failed'
        state.desired = 'failed'
        state.lastError = 'Encoder failed three consecutive times. Review the job log and settings.'
        stopChild('publisher')
        return persistState()
      }
      scheduleRestart('encoder', Math.min(30000, 2000 * 2 ** (state.encoderFailures - 1)))
    } else if (kind === 'publisher' && ['running', 'paused', 'draining'].includes(state.desired)) {
      const decision = publisherRestartDecision({
        history: state.publisherRestartHistory,
        cause: signal ? `signal:${signal}` : `exit:${code}`,
        exitedAt: new Date().toISOString(),
        runtimeMs,
      })
      state.publisherRestartHistory = decision.history
      state.publisherRestarts = decision.history.length
      if (decision.circuitOpen) {
        state.phase = 'failed'
        state.desired = 'failed'
        state.lastError = decision.reason
        stopChild('encoder')
        return persistState()
      }
      scheduleRestart('publisher', decision.delayMs)
    }
    persistState()
  })
  persistState()
}

function scheduleRestart(kind, delay) {
  clearRestart(kind)
  appendLog('supervisor', `${kind} restart scheduled in ${delay}ms`)
  restartTimers[kind] = setTimeout(() => {
    restartTimers[kind] = null
    if (kind === 'encoder') startEncoder()
    else startPublisher()
  }, delay)
}

function startEncoder() {
  if (!activeConfig || state.desired !== 'running' || state.encoderComplete) return
  const worker = activeConfig.sourceMode === 'file' ? 'segment-worker.mjs' : 'live-capture-worker.mjs'
  spawnManaged('encoder', path.join(consoleDir, worker), [activeMediaConfigPath])
}

function startPublisher() {
  if (!activeConfig || !['running', 'paused', 'draining'].includes(state.desired)) return
  const paths = jobPaths()
  if (!fs.existsSync(paths.manifestPath)) return
  let recoveryMarker
  try {
    recoveryMarker = quarantineCriticalStateTemps(paths.publisherStatePath)
  } catch (error) {
    enterRecoveryRequired(`Critical publisher recovery artifacts could not be classified safely: ${error.message}`)
    return
  }
  if (recoveryMarker) {
    enterRecoveryRequired(`Critical temporary publisher state was quarantined; ${recoveryMarker.artifacts.length} artifact(s) require signer/nonce/chain reconciliation.`)
    return
  }
  spawnManaged('publisher', path.join(consoleDir, 'reliable-publisher.mjs'), [activePublisherConfigPath])
}

function enterRecoveryRequired(reason) {
  if (!state.recoveryRequired) state.recoveryPreviousDesired = state.desired
  state.recoveryRequired = true
  state.phase = 'recovery-required'
  state.desired = 'recovery-required'
  state.lastError = reason
  stopAll()
  appendLog('supervisor', reason)
  persistState()
}

function stopChild(kind) {
  clearRestart(kind)
  const child = children[kind]
  if (child && !child.killed) child.kill('SIGTERM')
}

function stopAll() {
  stopChild('encoder')
  stopChild('publisher')
}

function cleanupFinalized(publisherState) {
  if (!activeConfig?.cleanupConfirmedSegments || !Array.isArray(publisherState?.published)) return
  for (const item of publisherState.published) {
    if (item.finalityStatus !== 'finalized-tag-observed') continue
    if (!item?.file) continue
    const resolved = path.resolve(item.file)
    const rootDir = path.resolve(jobPaths().segmentDir)
    if (path.dirname(resolved) === rootDir && fs.existsSync(resolved)) {
      try {
        fs.rmSync(resolved, { force: true })
        appendLog('cleanup', `removed confirmed segment ${item.sequence}`)
      } catch (error) {
        appendLog('cleanup', `could not remove segment ${item.sequence}: ${error.message}`)
      }
    }
  }
}

function updateMetrics() {
  if (!activeConfig) return
  const paths = jobPaths()
  let manifest
  let publisherState
  try {
    manifest = readOptionalSegmentManifest(paths.manifestPath, {
      streamId: activeConfig.streamId,
      segmentDir: paths.segmentDir,
    })
    publisherState = readPublisherObservation(paths.publisherStatePath, {
      chain: activeConfig.chain,
      stationAddress: activeConfig.stationAddress,
      streamId: activeConfig.streamId,
      segmentDir: paths.segmentDir,
    })
  } catch (error) {
    state.phase = 'failed'
    state.desired = 'failed'
    state.lastError = `Persisted publisher data failed validation: ${error.message}`
    stopAll()
    persistState()
    return
  }
  const generated = Array.isArray(manifest?.segments) ? manifest.segments.length : 0
  const submitted = Array.isArray(publisherState?.items)
    ? publisherState.items.length
    : Array.isArray(publisherState?.submitted)
      ? publisherState.submitted.length
      : 0
  const confirmed = Array.isArray(publisherState?.published)
    ? publisherState.published.filter((item) => item.finalityStatus !== 'provider-disagreement').length
    : 0
  const dropped = Array.isArray(manifest?.droppedSegments) ? manifest.droppedSegments.length : 0
  const target = activeConfig.startupBufferSegments
  cleanupFinalized(publisherState)
  const transactionHealth = publisherState?.metrics?.health || 'idle'
  const blockedReason = publisherState?.metrics?.latestBlockedReason || (submitted ? publisherState?.lastLoopError : null) || null
  const publisherRisk = ['blocked', 'failed', 'replacement-exhausted'].includes(transactionHealth)
    ? 'failed'
    : ['stale', 'replacing'].includes(transactionHealth)
      ? transactionHealth
      : null
  const durabilityMode = publisherState?.durabilityMode || publisherState?.metrics?.durabilityMode || null
  state.lineages = Array.isArray(publisherState?.publicLineages) ? publisherState.publicLineages : []
  state.metrics = {
    totalSegments: manifest?.totalSegments ?? null,
    generatedSegments: generated,
    submittedSegments: Number(publisherState?.metrics?.submittedCount || 0),
    confirmedSegments: confirmed,
    pendingTransactions: submitted,
    startupBufferTarget: target,
    bufferReady: confirmed >= target,
    sourceComplete: Boolean(manifest?.completedAt),
    actualSpendEth: publisherState?.metrics?.actualSpendEth || '0',
    transactionHealth,
    durabilityMode,
    blockedReason,
    aheadSegments: Math.max(0, generated - confirmed),
    droppedSegments: dropped,
    sourceMode: activeConfig.sourceMode,
    risk: state.phase === 'failed' || publisherRisk === 'failed'
      ? 'failed'
      : publisherRisk
        ? publisherRisk
      : durabilityMode === 'file-sync-verified-readback'
        ? 'durability-degraded'
      : dropped > 0
        ? 'stale'
      : confirmed >= target
        ? 'buffered'
        : generated || submitted || confirmed
          ? 'building-buffer'
          : 'starting',
  }
  if (activeConfig.sourceMode === 'file' && manifest?.completedAt) state.encoderComplete = true
  if (state.desired === 'running') {
    if (!children.encoder && !state.encoderComplete && !restartTimers.encoder) startEncoder()
    if (!children.publisher && !restartTimers.publisher) startPublisher()
  } else if (['paused', 'draining'].includes(state.desired) && !children.publisher && !restartTimers.publisher) {
    startPublisher()
  }
  if ((state.encoderComplete || state.desired === 'draining') && generated > 0 && confirmed >= generated && submitted === 0) {
    state.phase = state.desired === 'draining' ? 'drained' : 'complete'
    state.desired = state.phase
    stopChild('publisher')
  }
  persistState()
}

function newJobId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`
}

function preflightFingerprint(config) {
  return publisherArmConsentDigest(config)
}

async function startJob(input) {
  if (state.recoveryRequired) throw new Error('Recovery classification is required before a new publisher job can start')
  if (!['idle', 'stopped', 'complete', 'drained', 'failed'].includes(state.phase)) {
    throw new Error('A publisher job is already active')
  }
  const normalized = normalizeConfig(input)
  const fingerprint = preflightFingerprint(normalized)
  if (!armedPreflight || input.preflightTicket !== armedPreflight.ticket || fingerprint !== armedPreflight.fingerprint || Date.now() > armedPreflight.expiresAt) {
    throw new Error('Run preflight again before starting; the arm ticket is missing, expired, or belongs to different settings')
  }
  armedPreflight = null
  delete normalized.preflightTicket
  const jobId = newJobId()
  state = {
    version: 3,
    jobId,
    phase: 'starting',
    desired: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    encoderComplete: false,
    encoderFailures: 0,
    publisherRestarts: 0,
    publisherRestartHistory: [],
    recoveryRequired: false,
    recoveryPreviousDesired: null,
    lastError: null,
    metrics: { ...emptyMetrics(), startupBufferTarget: normalized.startupBufferSegments },
  }
  const paths = jobPaths(jobId)
  fs.mkdirSync(paths.segmentDir, { recursive: true, mode: 0o700 })
  activeConfig = {
    ...normalized,
    segmentDir: paths.segmentDir,
    publisherStatePath: paths.publisherStatePath,
    publisherProgressPath: paths.publisherProgressPath,
    startSequence: 0,
  }
  activeMediaConfigPath = paths.mediaConfigPath
  activePublisherConfigPath = paths.publisherConfigPath
  activeLogPath = paths.logPath
  atomicWriteJson(paths.configPath, activeConfig)
  atomicWriteJson(activeMediaConfigPath, mediaJobProjection(normalized, paths))
  atomicWriteJson(activePublisherConfigPath, transactionJobProjection(normalized, paths))
  persistState()
  appendLog('supervisor', `job ${jobId} accepted for ${activeConfig.chain}`)
  state.phase = 'running'
  persistState()
  startEncoder()
  return statusPayload()
}

function controlJob(action) {
  if (!activeConfig) throw new Error('There is no current job')
  if (state.recoveryRequired && action !== 'stop') {
    throw new Error('Recovery-required jobs cannot resume, pause, or drain before explicit reconciliation')
  }
  if (action === 'pause') {
    state.desired = 'paused'
    state.phase = 'paused'
    stopChild('encoder')
  } else if (action === 'resume') {
    state.desired = 'running'
    state.phase = 'running'
    state.encoderFailures = 0
    startEncoder()
    startPublisher()
  } else if (action === 'drain') {
    state.desired = 'draining'
    state.phase = 'draining'
    stopChild('encoder')
    startPublisher()
  } else if (action === 'stop') {
    state.desired = 'stopped'
    state.phase = 'stopped'
    stopAll()
  } else {
    throw new Error('Unsupported job action')
  }
  persistState()
  return statusPayload()
}

function statusPayload() {
  return {
    ...state,
    config: publicConfig(activeConfig),
    processes: {
      encoder: children.encoder ? 'running' : restartTimers.encoder ? 'restarting' : 'stopped',
      publisher: children.publisher ? 'running' : restartTimers.publisher ? 'restarting' : 'stopped',
    },
  }
}

function loadPersistedJob() {
  if (!fs.existsSync(statePath)) return
  const previous = readSupervisorState(statePath)
  if (!previous?.jobId) return
  const paths = jobPaths(previous.jobId)
  const config = readPublisherJobConfig(paths.configPath)
  if (!fs.existsSync(paths.mediaConfigPath) || !fs.existsSync(paths.publisherConfigPath)) {
    throw new Error('Persisted publisher job predates role-isolated configuration; explicit migration is required')
  }
  readPublisherJobConfig(paths.mediaConfigPath, { role: 'media' })
  readPublisherJobConfig(paths.publisherConfigPath, { role: 'publisher' })
  state = previous
  activeConfig = config
  activeMediaConfigPath = paths.mediaConfigPath
  activePublisherConfigPath = paths.publisherConfigPath
  activeLogPath = paths.logPath
  if (['running', 'paused', 'draining'].includes(state.desired)) {
    const previousDesired = state.desired
    enterRecoveryRequired(`Service restarted while job desired ${previousDesired}; source, signer, chain, policy, durable lineage, and sleep-gap reconciliation are required before further publication.`)
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function securityHeaders(response) {
  response.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('x-frame-options', 'DENY')
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) reject(new Error('Request body is too large'))
    })
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('Request body must be valid JSON'))
      }
    })
    request.on('error', reject)
  })
}

function assertMutationRequest(request) {
  const origin = request.headers.origin
  if (origin && origin !== `http://${host}:${port}`) throw new Error('Request origin was rejected')
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('JSON content type is required')
  if (request.headers['x-rfe-token'] !== csrfToken) throw new Error('Local session token is invalid')
}

function tailLog() {
  if (!activeLogPath || !fs.existsSync(activeLogPath)) return []
  return fs.readFileSync(activeLogPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-250)
}

function pickFile() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Native file selection is only available on Windows'))
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      "$dialog.Filter = 'Video files|*.mp4;*.mkv;*.mov;*.webm;*.avi|All files|*.*'",
      '$dialog.Multiselect = $false',
      "if ($dialog.ShowDialog() -eq 'OK') { [Console]::Out.Write($dialog.FileName) }",
    ].join('; ')
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let error = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(output.trim())
      else reject(new Error(error.trim() || 'File picker failed'))
    })
  })
}

function runFfmpeg(args, { timeoutMs = 12000, maxOutputBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('FFmpeg is unavailable'))
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks = []
    let size = 0
    let error = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGTERM')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > maxOutputBytes) child.kill('SIGTERM')
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      settled = true
      clearTimeout(timer)
      const output = Buffer.concat(chunks)
      if (code === 0 && output.length) resolve({ output, error })
      else reject(new Error(error.trim().split('\n').slice(-2).join(' ') || 'Source preview failed or timed out'))
    })
  })
}

function previewInput(input) {
  const mode = String(input.sourceMode || 'file')
  if (mode === 'file') {
    const source = path.resolve(String(input.sourcePath || ''))
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('Select an existing source file first')
    return ['-ss', '1', '-i', source]
  }
  if (mode === 'live-url') {
    const source = String(input.liveInputUrl || '').trim()
    let parsed
    try { parsed = new URL(source) } catch { throw new Error('Enter a valid live input URL first') }
    if (!['http:', 'https:', 'rtmp:', 'rtmps:', 'srt:', 'udp:'].includes(parsed.protocol)) throw new Error('Unsupported live input protocol')
    return ['-i', source]
  }
  if (mode !== 'screen' || process.platform !== 'win32') throw new Error('Desktop preview is only available on Windows')
  const args = ['-f', 'gdigrab', '-framerate', '1']
  if (input.captureTarget === 'region') {
    const x = Number(input.captureX)
    const y = Number(input.captureY)
    const width = Number(input.captureWidth)
    const height = Number(input.captureHeight)
    if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 160 || height < 90) {
      throw new Error('Capture region coordinates or dimensions are invalid')
    }
    args.push('-offset_x', String(x), '-offset_y', String(y), '-video_size', `${width}x${height}`)
  }
  return [...args, '-i', 'desktop']
}

async function createSourcePreview(input) {
  const { output } = await runFfmpeg([
    ...previewInput(input), '-frames:v', '1', '-vf', 'scale=960:-2',
    '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ])
  return { image: `data:image/jpeg;base64,${output.toString('base64')}`, capturedAt: new Date().toISOString() }
}

function discoverAudioDevices() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !ffmpegPath) return resolve({ devices: [], supported: false })
    const child = spawn(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let output = ''
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', () => resolve({ devices: [], supported: true }))
    child.once('exit', () => {
      const devices = []
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/"([^"]+)"\s+\(audio\)/i)
        if (match && !devices.includes(match[1])) devices.push(match[1])
      }
      resolve({ devices, supported: true })
    })
  })
}

async function rpcCall(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`)
  const value = await response.json()
  if (value.error) throw new Error(value.error.message || 'RPC request failed')
  return value.result
}

async function preflight(input) {
  const config = normalizeConfig(input)
  const account = privateKeyToAccount(process.env.PRIVATE_KEY)
  const expectedChainId = config.chain === 'mainnet' ? 1 : 11155111
  const chainId = Number(await rpcCall(config.executionRpcUrl, 'eth_chainId'))
  if (chainId !== expectedChainId) throw new Error(`Execution RPC is on chain ${chainId}, expected ${expectedChainId}`)
  const [balanceHex, stationCode] = await Promise.all([
    rpcCall(config.executionRpcUrl, 'eth_getBalance', [account.address, 'latest']),
    rpcCall(config.executionRpcUrl, 'eth_getCode', [config.stationAddress, 'latest']),
  ])
  if (!stationCode || stationCode === '0x') throw new Error('No station contract code exists at the configured address')
  const balanceWei = BigInt(balanceHex)
  const fingerprint = preflightFingerprint(config)
  const ticket = crypto.randomBytes(18).toString('hex')
  armedPreflight = { ticket, fingerprint, expiresAt: Date.now() + 10 * 60 * 1000 }
  return {
    ok: true,
    ticket,
    expiresAt: new Date(armedPreflight.expiresAt).toISOString(),
    checks: [
      { label: 'Source', status: 'ready', detail: config.sourceMode === 'file' ? path.basename(config.sourcePath) : config.sourceMode },
      { label: 'Execution RPC', status: 'ready', detail: `${config.chain} / chain ${chainId}` },
      { label: 'Station', status: 'ready', detail: `${config.stationAddress.slice(0, 8)}…${config.stationAddress.slice(-6)}` },
      { label: 'Publisher wallet', status: balanceWei > 0n ? 'ready' : 'warning', detail: `${account.address.slice(0, 8)}…${account.address.slice(-6)} / ${formatEther(balanceWei)} ETH` },
      { label: 'Queue policy', status: 'ready', detail: `${config.maxAheadSegments} ahead / ${config.maxPending} pending` },
    ],
  }
}

function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
  const filePath = path.resolve(publicDir, relative)
  if (!filePath.startsWith(`${path.resolve(publicDir)}${path.sep}`) && filePath !== path.join(publicDir, 'index.html')) {
    return sendJson(response, 404, { error: 'Not found' })
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendJson(response, 404, { error: 'Not found' })
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
  let body = fs.readFileSync(filePath)
  if (path.extname(filePath) === '.html') body = Buffer.from(body.toString('utf8').replace('__RFE_TOKEN__', csrfToken))
  response.writeHead(200, {
    'content-type': types[path.extname(filePath)] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function handle(request, response) {
  securityHeaders(response)
  const url = new URL(request.url, `http://${host}:${port}`)
  try {
    if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
      const walletAddress = process.env.PRIVATE_KEY ? privateKeyToAccount(process.env.PRIVATE_KEY).address : null
      return sendJson(response, 200, {
        defaults: DEFAULT_CONFIG,
        environment: environmentDefaults(),
        walletAddress,
        status: statusPayload(),
        testMode,
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/status') return sendJson(response, 200, statusPayload())
    if (request.method === 'GET' && url.pathname === '/api/logs') return sendJson(response, 200, { lines: tailLog() })
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) assertMutationRequest(request)
    if (request.method === 'POST' && url.pathname === '/api/pick-file') {
      await readBody(request)
      return sendJson(response, 200, { path: await pickFile() })
    }
    if (request.method === 'POST' && url.pathname === '/api/source-preview') {
      return sendJson(response, 200, await createSourcePreview(await readBody(request)))
    }
    if (request.method === 'POST' && url.pathname === '/api/audio-devices') {
      await readBody(request)
      return sendJson(response, 200, await discoverAudioDevices())
    }
    if (request.method === 'POST' && url.pathname === '/api/preflight') {
      if (testMode) throw new Error('Network preflight is disabled in console test mode')
      return sendJson(response, 200, await preflight(await readBody(request)))
    }
    if (request.method === 'POST' && url.pathname === '/api/jobs/start') {
      if (testMode) throw new Error('Job start is disabled in console test mode')
      return sendJson(response, 202, await startJob(await readBody(request)))
    }
    if (request.method === 'POST' && url.pathname === '/api/jobs/control') {
      const body = await readBody(request)
      return sendJson(response, 200, controlJob(body.action))
    }
    if (request.method === 'POST' && url.pathname === '/api/config/validate') {
      const body = await readBody(request)
      normalizeConfig(body, { requireSource: false })
      return sendJson(response, 200, { ok: true })
    }
    if (request.method === 'GET') return serveStatic(request, response, url.pathname)
    return sendJson(response, 404, { error: 'Not found' })
  } catch (error) {
    return sendJson(response, 400, { error: redact(error.message || error) })
  }
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(monitorTimer)
  server?.close()
  const outcome = await coordinateChildShutdown(children)
  if (outcome.clean) {
    processLock.release()
  } else {
    releaseLockAllowed = false
    atomicWriteJson(shutdownAmbiguityPath, {
      schema: 'rfe/publisher-shutdown-ambiguity@1',
      detectedAt: new Date().toISOString(),
      reasonCode: 'CHILD_EXIT_UNCONFIRMED',
      children: outcome.ambiguous,
    })
  }
  server?.closeAllConnections?.()
  process.exit(outcome.clean ? 0 : 2)
}

processLock.acquire()
loadPersistedJob()
server = http.createServer(handle)
server.listen(port, host, () => {
  console.log(`RFE publisher console: http://${host}:${port}`)
  console.log('Closing the browser tab will not stop the supervisor.')
})
monitorTimer = setInterval(updateMetrics, 1000)
monitorTimer.unref()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => { if (releaseLockAllowed) processLock.release() })

export { handle, statusPayload }
