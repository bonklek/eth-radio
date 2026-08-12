const token = document.querySelector('meta[name="rfe-token"]').content
const $ = (selector) => document.querySelector(selector)
const form = $('#job-form')
const message = $('#form-message')
let currentStatus = null
let preflightPassed = false
let preflightTicket = ''

function storedTheme() {
  try { return localStorage.getItem('rfe-publisher-theme') } catch { return null }
}

function applyTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark'
  document.documentElement.dataset.theme = value
  const toggle = $('#theme-toggle')
  toggle.setAttribute('aria-pressed', String(value === 'light'))
  toggle.setAttribute('aria-label', value === 'light' ? 'Switch to dark mode' : 'Switch to light mode')
  try { localStorage.setItem('rfe-publisher-theme', value) } catch { /* Theme persistence is optional. */ }
}

applyTheme(storedTheme() || 'dark')

async function api(path, options = {}) {
  const mutation = options.method && options.method !== 'GET'
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(mutation ? { 'content-type': 'application/json', 'x-rfe-token': token } : {}),
      ...(options.headers || {}),
    },
  })
  const value = await response.json()
  if (!response.ok) throw new Error(value.error || `Request failed with ${response.status}`)
  return value
}

function shortAddress(value) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : 'Wallet not configured'
}

function formConfig() {
  return {
    preflightTicket,
    sourceMode: document.querySelector('input[name="sourceMode"]:checked').value,
    sourcePath: $('#source-path').value,
    liveInputUrl: $('#live-input-url').value,
    captureAudioDevice: $('#capture-audio-device').value,
    captureTarget: $('#capture-target').value,
    captureX: Number($('#capture-x').value),
    captureY: Number($('#capture-y').value),
    captureWidth: Number($('#capture-width').value),
    captureHeight: Number($('#capture-height').value),
    streamId: $('#stream-id').value,
    chain: $('#chain').value,
    stationAddress: $('#station-address').value,
    executionRpcUrl: $('#execution-rpc').value,
    beaconRpcUrl: $('#beacon-rpc').value,
    sendRpcUrls: $('#send-rpcs').value,
    profile: $('#profile').value,
    segmentMs: Number($('#segment-ms').value),
    videoBitrateKbps: Number($('#video-rate').value),
    audioBitrateKbps: Number($('#audio-rate').value),
    maxBlobs: Number($('#max-blobs').value),
    maxPending: Number($('#max-pending').value),
    maxAheadSegments: Number($('#max-ahead-segments').value),
    startupBufferSegments: Number($('#buffer-segments').value),
    maxStreamCostEth: $('#max-cost').value,
    maxSegmentCostEth: $('#max-segment-cost').value,
    maxFeePerBlobGasGwei: $('#blob-fee').value,
    maxFeePerGasGwei: $('#gas-fee').value,
    maxPriorityFeePerGasGwei: $('#priority-fee').value,
    replaceAfterSeconds: Number($('#replace-after').value),
    feeBumpPercent: Number($('#fee-bump').value),
    maxReplacements: Number($('#max-replacements').value),
    confirmationDepth: Number($('#confirmation-depth').value),
    sendRetries: Number($('#send-retries').value),
    retryMs: 5000,
    cleanupConfirmedSegments: $('#cleanup-segments').checked,
    confirmMainnet: $('#mainnet-confirm').checked,
    overlay: {
      enabled: $('#overlay-enabled').checked,
      title: $('#overlay-title').value,
      subtitle: $('#overlay-subtitle').value,
      layout: $('#overlay-layout').value,
      accent: $('#overlay-accent').value,
      opacity: Number($('#overlay-opacity').value),
      showUtc: $('#show-utc').checked,
      showNetwork: $('#show-network').checked,
      showBlockNumber: $('#show-block-number').checked,
      showBlockHash: $('#show-block-hash').checked,
      showSegment: $('#show-segment').checked,
      showStreamId: $('#show-stream-id').checked,
    },
  }
}

function updateSourceMode() {
  const mode = document.querySelector('input[name="sourceMode"]:checked').value
  const file = mode === 'file'
  const screen = mode === 'screen'
  $('#file-source-field').classList.toggle('hidden', !file)
  $('#live-url-field').classList.toggle('hidden', mode !== 'live-url')
  $('#screen-controls').classList.toggle('hidden', !screen)
  $('#source-path').required = file
  $('#live-input-url').required = mode === 'live-url'
  const notes = {
    file: 'The file is segmented progressively while confirmed segments publish in parallel. The entire encode does not run first.',
    screen: 'Desktop capture runs continuously. If publication falls behind the bounded queue, capture stays alive and reports dropped segments.',
    'live-url': 'The local supervisor ingests the remote live feed continuously; only the media source is remote.',
  }
  $('#source-mode-note').textContent = notes[mode]
}

function updateCaptureTarget() {
  $('#capture-region-fields').classList.toggle('hidden', $('#capture-target').value !== 'region')
}

function invalidatePreflight() {
  const wasPassed = preflightPassed
  preflightPassed = false
  preflightTicket = ''
  if (wasPassed) {
    $('#preflight-results').classList.add('stale')
    message.textContent = 'Settings changed. Run preflight again to re-arm transmission.'
  }
  if (!['starting', 'running', 'paused', 'draining'].includes(currentStatus?.phase)) $('#start-button').disabled = true
}

function renderPreflight(checks) {
  const results = $('#preflight-results')
  results.replaceChildren()
  for (const check of checks) {
    const row = document.createElement('div')
    row.className = `preflight-check ${check.status}`
    const label = document.createElement('strong')
    label.textContent = check.label
    const detail = document.createElement('span')
    detail.textContent = check.detail
    row.append(label, detail)
    results.append(row)
  }
}

function updateOverlayPreview() {
  const preview = $('#overlay-preview')
  const config = formConfig()
  preview.className = `overlay-preview ${config.overlay.layout}${config.overlay.enabled ? '' : ' disabled'}`
  preview.style.setProperty('--preview-accent', config.overlay.accent)
  const opacity = Math.max(.1, config.overlay.opacity / 100)
  preview.querySelectorAll('.preview-top,.preview-bottom').forEach((element) => {
    element.style.backgroundColor = `rgba(8,9,13,${opacity})`
  })
  $('#preview-title').textContent = config.overlay.title || 'RADIO FREE ETHEREUM'
  $('#preview-subtitle').textContent = config.overlay.subtitle || 'PUBLIC SIGNAL'
  $('#preview-chain').textContent = `${config.chain.toUpperCase()} / STATION`
  $('#opacity-output').textContent = `${config.overlay.opacity}%`
  const fields = []
  if (config.overlay.showNetwork) fields.push(config.chain.toUpperCase())
  if (config.overlay.showUtc) fields.push('ENCODED 03:14:15 UTC')
  if (config.overlay.showBlockNumber) fields.push('BLOCK 9,104,322')
  if (config.overlay.showBlockHash) fields.push('HEAD 0x4c12…91aa')
  if (config.overlay.showSegment) fields.push('SEG 3/18')
  if (config.overlay.showStreamId) fields.push(`STREAM ${config.streamId || 'rfe-signal'}`)
  $('#preview-fields').textContent = fields.join(' / ')
}

function updateChainFields() {
  const mainnet = $('#chain').value === 'mainnet'
  $('#mainnet-confirm-wrap').classList.toggle('hidden', !mainnet)
  if (!mainnet) $('#mainnet-confirm').checked = false
  updateOverlayPreview()
}

function statusDetail(status) {
  const metrics = status.metrics || {}
  if (status.recoveryRequired) return status.lastError || 'Recovery classification is required before publication can resume.'
  if (status.phase === 'idle') return 'Configure a source and start a transmission.'
  if (status.phase === 'failed') return status.lastError || 'The supervisor needs operator attention.'
  if (status.phase === 'paused') return 'Source encoding is paused; already generated segments continue to publish.'
  if (status.phase === 'draining') return 'No new segments are being generated. Pending work is being confirmed.'
  if (status.phase === 'complete' || status.phase === 'drained') return 'All generated segments are confirmed and temporary media has been cleaned up.'
  if (metrics.blockedReason) return metrics.blockedReason
  if (metrics.transactionHealth === 'replacing') return 'A stale nonce is being replaced with a bounded higher-fee attempt.'
  if (metrics.transactionHealth === 'stale') return 'The lowest pending nonce is stale and approaching replacement.'
  if (metrics.durabilityMode === 'file-sync-verified-readback') return 'Critical state is file-flushed and verified after write; this filesystem does not support directory flush.'
  if (metrics.bufferReady) return `Viewer cushion established at ${metrics.confirmedSegments} confirmed segments.`
  return `Building a ${metrics.startupBufferTarget || 2}-segment viewer cushion before tune-in.`
}

function shortHash(value) {
  return value ? `${value.slice(0, 10)}…${value.slice(-6)}` : '—'
}

function gwei(value) {
  if (!value || !/^\d+$/.test(String(value))) return '—'
  const amount = BigInt(value)
  const whole = amount / 1000000000n
  const fraction = String(amount % 1000000000n).padStart(9, '0').replace(/0+$/, '').slice(0, 3)
  return `${whole}${fraction ? `.${fraction}` : ''}g`
}

function renderLineages(lineages = []) {
  const list = $('#lineage-list')
  $('#lineage-count').textContent = String(lineages.length)
  list.replaceChildren()
  if (!lineages.length) {
    const empty = document.createElement('p')
    empty.textContent = 'No pending nonces.'
    list.append(empty)
    return
  }
  for (const lineage of lineages) {
    const card = document.createElement('article')
    card.className = 'lineage-card'
    const header = document.createElement('header')
    const identity = document.createElement('strong')
    identity.textContent = `SEQ ${lineage.sequence} / NONCE ${lineage.nonce}`
    const health = document.createElement('span')
    health.textContent = lineage.health || lineage.status
    header.append(identity, health)
    card.append(header)
    if (lineage.blockedReason) {
      const reason = document.createElement('p')
      reason.className = 'lineage-reason'
      reason.textContent = lineage.blockedReason
      card.append(reason)
    }
    const attempts = document.createElement('div')
    attempts.className = 'attempt-list'
    for (const attempt of lineage.attempts || []) {
      const row = document.createElement('div')
      row.className = 'attempt-row'
      const index = document.createElement('span')
      index.textContent = `#${Number(attempt.index) + 1}`
      const hash = document.createElement('code')
      hash.textContent = shortHash(attempt.txHash)
      const fees = document.createElement('span')
      fees.textContent = `${gwei(attempt.maxFeePerGas)} / blob ${gwei(attempt.maxFeePerBlobGas)}`
      row.append(index, hash, fees)
      attempts.append(row)
    }
    card.append(attempts)
    list.append(card)
  }
}

function renderStatus(status) {
  currentStatus = status
  const metrics = status.metrics || {}
  const phase = status.phase || 'idle'
  const risk = metrics.risk || (phase === 'failed' ? 'failed' : 'idle')
  $('#status-heading').textContent = phase.replace(/-/g, ' ').replace(/^./, (value) => value.toUpperCase())
  $('#risk-badge').textContent = risk.replace(/-/g, ' ').toUpperCase()
  $('#risk-badge').className = `badge ${risk}`
  $('#status-detail').textContent = statusDetail(status)
  $('#metric-generated').textContent = metrics.totalSegments == null ? metrics.generatedSegments || 0 : `${metrics.generatedSegments || 0}/${metrics.totalSegments}`
  $('#metric-confirmed').textContent = metrics.confirmedSegments || 0
  $('#metric-pending').textContent = metrics.pendingTransactions || 0
  $('#metric-ahead').textContent = metrics.aheadSegments || 0
  $('#metric-dropped').textContent = metrics.droppedSegments || 0
  $('#metric-spend').textContent = `${metrics.actualSpendEth || '0'} ETH`
  $('#encoder-state').textContent = status.processes?.encoder || 'stopped'
  $('#publisher-state').textContent = status.processes?.publisher || 'stopped'
  $('#transaction-state').textContent = metrics.durabilityMode === 'file-sync-verified-readback'
    ? `${metrics.transactionHealth || 'idle'} / durability degraded`
    : metrics.transactionHealth || 'idle'
  $('#buffer-state').textContent = metrics.bufferReady ? 'ready' : 'not ready'
  const denominator = metrics.totalSegments || Math.max(1, metrics.generatedSegments || 1)
  $('#progress-fill').style.width = `${Math.min(100, ((metrics.confirmedSegments || 0) / denominator) * 100)}%`
  renderLineages(status.lineages)
  const recoveryRequired = Boolean(status.recoveryRequired)
  const active = recoveryRequired || ['starting', 'running', 'paused', 'draining'].includes(phase)
  $('.control-row').classList.toggle('active', active)
  $('#pause-button').disabled = phase !== 'running'
  $('#resume-button').disabled = phase !== 'paused'
  $('#drain-button').disabled = !['running', 'paused'].includes(phase)
  $('#stop-button').disabled = !active
  if (recoveryRequired) $('#start-button').disabled = true
  document.querySelectorAll('.configuration-panel input,.configuration-panel select,.configuration-panel textarea,.configuration-panel button,.visual-panel input,.visual-panel select').forEach((element) => {
    element.disabled = active
  })
  if (!active) $('#start-button').disabled = !preflightPassed
}

async function refreshStatus() {
  try {
    const status = await api('/api/status')
    renderStatus(status)
    $('#supervisor-dot').classList.add('good')
    $('#supervisor-copy').textContent = 'Supervisor online / tab-safe'
  } catch {
    $('#supervisor-dot').classList.remove('good')
    $('#supervisor-copy').textContent = 'Supervisor unavailable'
  }
}

async function refreshLogs() {
  try {
    const value = await api('/api/logs')
    const output = $('#log-output')
    output.textContent = value.lines.length ? value.lines.join('\n') : 'No active job.'
    output.scrollTop = output.scrollHeight
  } catch (error) {
    $('#log-output').textContent = error.message
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  message.textContent = 'Validating and starting the local supervisor…'
  $('#start-button').disabled = true
  try {
    const status = await api('/api/jobs/start', { method: 'POST', body: JSON.stringify(formConfig()) })
    renderStatus(status)
    message.textContent = 'Transmission accepted. The browser may now be closed without stopping it.'
    await refreshLogs()
  } catch (error) {
    message.textContent = error.message
    $('#start-button').disabled = false
  }
})

$('#browse-button').addEventListener('click', async () => {
  message.textContent = 'Opening the local file picker…'
  try {
    const value = await api('/api/pick-file', { method: 'POST', body: '{}' })
    if (value.path) $('#source-path').value = value.path
    if (value.path) invalidatePreflight()
    message.textContent = value.path ? 'Source selected.' : 'File selection cancelled.'
  } catch (error) {
    message.textContent = error.message
  }
})

$('#capture-target').addEventListener('change', updateCaptureTarget)
$('#theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'))

$('#discover-audio').addEventListener('click', async () => {
  message.textContent = 'Discovering Windows audio capture devices…'
  try {
    const value = await api('/api/audio-devices', { method: 'POST', body: '{}' })
    const list = $('#audio-device-list')
    list.replaceChildren(...value.devices.map((device) => {
      const option = document.createElement('option')
      option.value = device
      return option
    }))
    message.textContent = value.devices.length ? `Found ${value.devices.length} audio capture device(s).` : 'No DirectShow audio capture devices were reported; video-only capture remains available.'
  } catch (error) { message.textContent = error.message }
})

$('#preview-button').addEventListener('click', async () => {
  message.textContent = 'Capturing a source preview…'
  $('#preview-button').disabled = true
  try {
    const value = await api('/api/source-preview', { method: 'POST', body: JSON.stringify(formConfig()) })
    const image = $('#source-preview-image')
    image.src = value.image
    image.classList.remove('hidden')
    message.textContent = `Source preview captured at ${new Date(value.capturedAt).toLocaleTimeString()}.`
  } catch (error) { message.textContent = error.message }
  finally { $('#preview-button').disabled = false }
})

$('#preflight-button').addEventListener('click', async () => {
  message.textContent = 'Checking source, RPC, station, wallet, and queue policy…'
  $('#preflight-button').disabled = true
  try {
    const value = await api('/api/preflight', { method: 'POST', body: JSON.stringify(formConfig()) })
    renderPreflight(value.checks)
    $('#preflight-results').classList.remove('stale')
    preflightPassed = value.ok
    preflightTicket = value.ticket
    $('#start-button').disabled = !preflightPassed
    message.textContent = 'Preflight passed. Transmission controls are armed.'
  } catch (error) {
    preflightPassed = false
    $('#start-button').disabled = true
    renderPreflight([{ label: 'Preflight', status: 'failed', detail: error.message }])
    message.textContent = error.message
  } finally { $('#preflight-button').disabled = false }
})

for (const action of ['pause', 'resume', 'drain', 'stop']) {
  $(`#${action}-button`).addEventListener('click', async () => {
    try {
      renderStatus(await api('/api/jobs/control', { method: 'POST', body: JSON.stringify({ action }) }))
      await refreshLogs()
    } catch (error) {
      message.textContent = error.message
    }
  })
}

$('#refresh-log').addEventListener('click', refreshLogs)
$('#chain').addEventListener('change', updateChainFields)
for (const element of document.querySelectorAll('input[name="sourceMode"]')) element.addEventListener('change', updateSourceMode)
for (const element of document.querySelectorAll('#job-form input,#job-form select,#job-form textarea')) element.addEventListener('input', invalidatePreflight)
for (const element of document.querySelectorAll('#overlay-enabled,#overlay-title,#overlay-subtitle,#overlay-layout,#overlay-accent,#overlay-opacity,#show-utc,#show-network,#show-block-number,#show-block-hash,#show-segment,#show-stream-id,#stream-id')) {
  element.addEventListener('input', updateOverlayPreview)
  element.addEventListener('change', updateOverlayPreview)
}

async function bootstrap() {
  try {
    const data = await api('/api/bootstrap')
    $('#wallet-copy').textContent = data.walletAddress ? `Wallet ${shortAddress(data.walletAddress)}` : 'Wallet not configured in .env'
    renderStatus(data.status)
    updateSourceMode()
    updateCaptureTarget()
    updateChainFields()
    await refreshLogs()
    $('#supervisor-dot').classList.add('good')
    $('#supervisor-copy').textContent = 'Supervisor online / tab-safe'
    setInterval(refreshStatus, 1500)
    setInterval(refreshLogs, 5000)
  } catch (error) {
    message.textContent = error.message
  }
}

function updateClock() {
  $('#utc-clock').textContent = `${new Date().toISOString().slice(11, 19)} UTC`
}

updateClock()
setInterval(updateClock, 1000)

bootstrap()
