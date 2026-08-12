export function createLiveDemoPages(options) {
  return {
    overlayHtml: () => overlayHtml(options),
    overlayPreviewHtml: () => overlayPreviewHtml(options),
  }
}

function serializeScriptData(value) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('Inline script data must be JSON-serializable')
  return serialized
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function encodeHtmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function overlayHtml({ defaultNetwork, networkLabel, streamId }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Radio Free Ethereum Overlay</title>
  <style>
    :root {
      color-scheme: dark;
      --accent: #8f97e8;
      --link: #c6ccff;
      --text: #f0f1f8;
      --muted: rgba(186, 190, 214, .82);
      --surface-1: rgba(17, 19, 26, .95);
      --surface-2: rgba(48, 51, 67, .92);
      --surface-3: rgba(24, 26, 36, .97);
      --border: #252838;
      --bevel: #06070c;
      --highlight: rgba(255, 255, 255, .07);
      --shadow: rgba(0, 0, 0, .42);
      --other-blob: rgba(198, 204, 255, .42);
      --empty-blob: rgba(198, 204, 255, .095);
      --ui: Arial, "Segoe UI", sans-serif;
      --mono: Consolas, ui-monospace, "SFMono-Regular", Menlo, Monaco, monospace;
    }

    * { box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: transparent;
      font-family: var(--ui);
      color: var(--text);
    }

    body.preview {
      background:
        linear-gradient(135deg, rgba(23, 25, 36, .92), rgba(8, 9, 14, .96)),
        #08090e;
    }

    .viewport {
      position: fixed;
      inset: 0;
      overflow: hidden;
    }

    .overlay {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 1920px;
      height: 1080px;
      transform-origin: 0 0;
      transform: translate(-50%, -50%) scale(var(--scale, 1));
      background: transparent;
    }

    .reference {
      position: absolute;
      inset: 0;
      width: 1920px;
      height: 1080px;
      clip-path: inset(0 0 188px 0);
      pointer-events: none;
      user-select: none;
    }

    .chip, .telemetry-card {
      border: 1px solid var(--border);
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        var(--surface-2);
      background-size: 8px 8px, 8px 8px, auto;
      box-shadow:
        inset 1px 1px 0 var(--highlight),
        3px 0 0 var(--bevel),
        0 4px 0 var(--bevel),
        6px 6px 0 var(--shadow);
    }

    .topbar {
      position: absolute;
      left: 0;
      top: 0;
      width: 1920px;
      height: 112px;
      pointer-events: none;
    }

    .chip {
      position: absolute;
      top: 31px;
      height: 48px;
      display: grid;
      place-items: center;
      padding: 0 13px;
      background-color: var(--surface-2);
      color: var(--link);
      font: 700 29px/1 var(--mono);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: 0;
      z-index: 2;
    }

    .top-telemetry-mask {
      position: absolute;
      left: 660px;
      top: 24px;
      width: 1168px;
      height: 64px;
      background: #181a24;
      z-index: 1;
    }

    #timeUtc { left: 672px; width: 236px; }
    .chip:not(#timeUtc) {
      top: 35px;
      height: 40px;
      padding: 0 11px;
      font-size: 22px;
    }
    #slot { left: 922px; width: 238px; }
    #nonce { left: 1174px; width: 252px; }
    #blockHash { left: 1440px; width: 374px; }

    .network-signal {
      position: absolute;
      left: 113px;
      top: 66px;
      width: 520px;
      height: 31px;
      display: flex;
      align-items: center;
      background: #181a24;
      color: var(--link);
      font: 700 26px/1 var(--mono);
      letter-spacing: 0;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      z-index: 2;
    }

    .lower {
      position: absolute;
      left: 36px;
      top: 948px;
      width: 1848px;
      height: 112px;
      pointer-events: none;
      z-index: 3;
    }

    .lower-panel-mask {
      position: absolute;
      inset: 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        var(--surface-1);
      background-size: 8px 8px, 8px 8px, auto;
      box-shadow: inset -3px -3px 0 rgba(0, 0, 0, .42), inset 2px 2px 0 rgba(255, 255, 255, .04);
      z-index: 0;
    }

    .status-label {
      position: absolute;
      left: 28px;
      top: 18px;
      display: block;
      color: var(--accent);
      font: 900 24px/1 var(--ui);
      text-transform: uppercase;
      letter-spacing: 0;
      z-index: 1;
    }

    .reading-title {
      position: absolute;
      left: 28px;
      top: 59px;
      width: 690px;
      display: block;
      color: var(--text);
      font: 900 42px/1 var(--ui);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: 2px 2px 0 #000;
      z-index: 1;
    }

    .telemetry {
      position: absolute;
      inset: 0;
      margin: 0;
      z-index: 3;
    }

    .telemetry-mask {
      position: absolute;
      left: 792px;
      top: 39px;
      width: 1040px;
      height: 72px;
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        var(--surface-1);
      background-size: 8px 8px, 8px 8px, auto;
      z-index: 0;
    }

    .telemetry-card {
      position: absolute;
      top: 50px;
      height: 54px;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      font-family: var(--mono);
      overflow: hidden;
      z-index: 1;
    }

    .telemetry-card.tx { left: 748px; width: 252px; }
    .telemetry-card.payload { left: 1024px; width: 196px; }
    .telemetry-card.hash { left: 1244px; width: 244px; }
    .telemetry-card.prev { left: 1512px; width: 244px; }

    .telemetry-card dt {
      margin: 0 0 7px;
      color: var(--muted);
      text-transform: uppercase;
      font: 800 15px/1 var(--mono);
    }

    .telemetry-card dd {
      margin: 0;
      min-width: 0;
      color: var(--link);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 800 21px/1 var(--mono);
    }

    .ticker-viewport {
      position: absolute;
      left: 36px;
      top: 876px;
      width: 1242px;
      height: 28px;
      overflow: hidden;
      color: rgba(198, 204, 255, .72);
      font: 700 20px/28px var(--mono);
      white-space: nowrap;
    }

    .ticker-track {
      display: inline-flex;
      gap: 48px;
      min-width: max-content;
      animation: rfe-ticker 34s linear infinite;
    }

    @keyframes rfe-ticker {
      from { transform: translateX(0); }
      to { transform: translateX(-50%); }
    }

    .offline .chip, .offline .telemetry dd {
      color: rgba(198, 204, 255, .52);
    }
  </style>
</head>
<body>
  <div class="viewport">
    <main id="overlay" class="overlay" aria-label="Radio Free Ethereum livestream overlay">
      <img id="overlayShell" class="reference" src="/rfe-assets/overlays/rfe-terminal-1080p.png" alt="" aria-hidden="true" />
      <div id="networkSignal" class="network-signal">PUBLIC SIGNAL / ${encodeHtmlText(networkLabel(defaultNetwork).toUpperCase())}</div>
      <section class="topbar" aria-label="Live stream telemetry">
        <div class="top-telemetry-mask" aria-hidden="true"></div>
        <div id="timeUtc" class="chip">--:--:-- UTC</div>
        <div id="slot" class="chip">SLOT --</div>
        <div id="nonce" class="chip">SEQ --</div>
        <div id="blockHash" class="chip">BLOCK --</div>
      </section>

      <div class="ticker-viewport" aria-hidden="true">
        <div id="ticker" class="ticker-track"><span>Waiting for Station telemetry</span><span>Waiting for Station telemetry</span></div>
      </div>

      <section class="lower" aria-label="Current segment">
        <div class="lower-panel-mask" aria-hidden="true"></div>
        <div class="status-label">Now Reading</div>
        <div id="readingTitle" class="reading-title">The EF Mandate</div>
        <dl class="telemetry">
          <div class="telemetry-mask" aria-hidden="true"></div>
          <div class="telemetry-card tx"><dt>Prev TX</dt><dd id="txHash">--</dd></div>
          <div class="telemetry-card payload"><dt>Payload</dt><dd id="payloadSize">--</dd></div>
          <div class="telemetry-card hash"><dt>Hash</dt><dd id="contentHash">--</dd></div>
          <div class="telemetry-card prev"><dt>Prev</dt><dd id="previousHash">--</dd></div>
        </dl>
      </section>
    </main>
  </div>

  <script>
    const params = new URLSearchParams(location.search)
    const streamId = params.get('streamId') || ${serializeScriptData(streamId)}
    let publisher = params.get('publisher') || ''
    let selectedNetwork = (params.get('network') || ${serializeScriptData(defaultNetwork)}).toLowerCase() === 'mainnet' ? 'mainnet' : 'sepolia'
    const endpointPreset = params.get('endpointPreset') === 'public' ? 'public' : ''
    let selectedNetworkLabel = selectedNetwork === 'mainnet' ? 'Mainnet' : 'Sepolia'
    const preview = params.has('preview')
    const overlay = document.getElementById('overlay')
    const overlayShell = document.getElementById('overlayShell')
    if (preview) document.body.classList.add('preview')

    const overlayProfiles = {
      '360p': { width: 640, height: 360, src: '/rfe-assets/overlays/rfe-terminal-360p.png' },
      '420p': { width: 746, height: 420, src: '/rfe-assets/overlays/rfe-terminal-420p.png' },
      '480p': { width: 854, height: 480, src: '/rfe-assets/overlays/rfe-terminal-480p.png' },
      '720p': { width: 1280, height: 720, src: '/rfe-assets/overlays/rfe-terminal-720p.png' },
      '1080p': { width: 1920, height: 1080, src: '/rfe-assets/overlays/rfe-terminal-1080p.png' },
    }

    function overlayShellFor(width, height) {
      const explicitProfile = (params.get('profile') || '').toLowerCase()
      if (overlayProfiles[explicitProfile]) return overlayProfiles[explicitProfile].src
      const explicitWidth = Number(params.get('width') || width || 0)
      const explicitHeight = Number(params.get('height') || height || 0)
      const exact = Object.values(overlayProfiles).find((profile) => profile.width === explicitWidth && profile.height === explicitHeight)
      if (exact) return exact.src
      return overlayProfiles['1080p'].src
    }

    overlayShell.src = overlayShellFor()

    function scaleOverlay() {
      const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
      overlay.style.setProperty('--scale', String(scale))
    }

    function utcClock() {
      document.getElementById('timeUtc').textContent = streamClockText()
    }

    function apiUrl(path) {
      const url = new URL(path, location.origin)
      url.searchParams.set('network', selectedNetwork)
      if (publisher) url.searchParams.set('publisher', publisher)
      if (endpointPreset) url.searchParams.set('endpointPreset', endpointPreset)
      return url.pathname + url.search
    }

    function liveResponseSegments(data) {
      if (!data || typeof data !== 'object' || !Array.isArray(data.segments)) {
        throw new Error('Live response segments must be an array')
      }
      return data.segments.filter((segment) => !segment.quarantined)
    }

    function updateNetworkSignal(data) {
      const label = data?.networkLabel || data?.transport?.networkLabel || data?.blobspace?.networkLabel || selectedNetworkLabel
      selectedNetworkLabel = label
      selectedNetwork = (data?.network || data?.transport?.network || data?.blobspace?.chain || selectedNetwork) === 'mainnet' ? 'mainnet' : 'sepolia'
      document.getElementById('networkSignal').textContent = 'PUBLIC SIGNAL / ' + String(label).toUpperCase()
    }

    function shorten(value, head, tail) {
      if (!value) return '--'
      const text = String(value)
      if (text.length <= head + tail + 3) return text
      return text.slice(0, head) + '...' + text.slice(-tail)
    }

    function publicErrorMessage(error) {
      return String(error?.message || error || 'Request failed').replace(/https?:\\/\\/[^\\s"'<>)}\\]]+/g, '[redacted endpoint]')
    }

    function formatBytes(value) {
      const n = Number(value || 0)
      return n ? new Intl.NumberFormat('en-US').format(n) + ' B' : '--'
    }

    function proofOrSequenceLabel(segment, proof) {
      if (proof && proof.nonce) return 'PROOF ' + proof.nonce
      if (segment && segment.sequence != null) return 'SEQ #' + segment.sequence
      return 'SEQ --'
    }

    function latestSegment(segments) {
      return [...(segments || [])].sort((a, b) => Number(a.sequence) - Number(b.sequence)).at(-1) || null
    }

    let streamClock = {
      key: null,
      startMs: null,
      durationMs: null,
      anchorWallMs: null,
    }

    function streamClockText() {
      if (!streamClock.startMs) return new Date().toISOString().slice(11, 19) + ' UTC'
      const elapsed = Math.max(0, Date.now() - streamClock.anchorWallMs)
      const capped = streamClock.durationMs ? Math.min(elapsed, streamClock.durationMs) : elapsed
      return new Date(streamClock.startMs + capped).toISOString().slice(11, 19) + ' UTC'
    }

    function updateStreamClock(segment) {
      if (!segment || !segment.proof || !segment.proof.generatedAt) return
      const key = segment.streamId + ':' + segment.sequence + ':' + segment.proof.generatedAt
      if (streamClock.key === key) return
      const startMs = Date.parse(segment.proof.generatedAt)
      if (!Number.isFinite(startMs)) return
      streamClock = {
        key,
        startMs,
        durationMs: Number(segment.durationMs || 0) || null,
        anchorWallMs: Date.now(),
      }
      utcClock()
    }

    function updateTicker(segment, blobspace, segments) {
      const proof = segment && segment.proof ? segment.proof : {}
      const blockHash = segment && segment.blockHash ? segment.blockHash : proof.block && proof.block.hash
      const content = segment && (segment.payloadSha256Hex || segment.payloadSha256)
      const previous = previousSegment(segment, segments)
      const text = [
        document.getElementById('timeUtc').textContent,
        'SLOT ' + ((segment && segment.slot) || (blobspace && blobspace.latestSlot) || '--'),
        'BLOCK ' + shorten(blockHash, 8, 4),
        proofOrSequenceLabel(segment, proof),
        'PREV TX ' + shorten(previous && previous.txHash, 8, 4),
        'PREV ' + shorten(segment && segment.previousSegmentHash, 8, 4),
        'CONTENT ' + shorten(content, 8, 4),
      ].join(' / ')
      const ticker = document.getElementById('ticker')
      const primary = document.createElement('span')
      const duplicate = document.createElement('span')
      primary.textContent = text
      duplicate.textContent = text
      duplicate.setAttribute('aria-hidden', 'true')
      ticker.replaceChildren(primary, duplicate)
    }

    function previousSegment(segment, segments) {
      if (!segment || segment.sequence == null) return null
      const sequence = Number(segment.sequence)
      return [...(segments || [])]
        .filter((candidate) => Number(candidate.sequence) < sequence)
        .sort((a, b) => Number(a.sequence) - Number(b.sequence))
        .at(-1) || null
    }

    async function poll() {
      try {
        const response = await fetch(apiUrl('/api/streams/' + encodeURIComponent(streamId) + '/live'), { cache: 'no-store' })
        if (!response.ok) throw new Error(await response.text())
        const data = await response.json()
        if (data.publisher) publisher = data.publisher
        updateNetworkSignal(data)
        const responseSegments = liveResponseSegments(data)
        const segment = latestSegment(responseSegments)
        const proof = segment && segment.proof ? segment.proof : {}
        const blockHash = segment && segment.blockHash ? segment.blockHash : proof.block && proof.block.hash
        const latestSlot = data.blobspace && data.blobspace.latestSlot
        const previous = previousSegment(segment, responseSegments)
        updateStreamClock(segment)
        overlay.classList.toggle('offline', !segment)
        document.getElementById('slot').textContent = 'SLOT ' + (segment && segment.slot || latestSlot || '--')
        document.getElementById('nonce').textContent = proofOrSequenceLabel(segment, proof)
        document.getElementById('blockHash').textContent = 'BLOCK ' + shorten(blockHash, 8, 4)
        document.getElementById('txHash').textContent = shorten(previous && previous.txHash, 10, 6)
        document.getElementById('payloadSize').textContent = formatBytes(segment && segment.payloadBytes)
        const content = segment && (segment.payloadSha256Hex || segment.payloadSha256)
        document.getElementById('contentHash').textContent = shorten(content, 10, 6)
        document.getElementById('previousHash').textContent = shorten(segment && segment.previousSegmentHash, 10, 6)
        updateTicker(segment, data.blobspace, responseSegments)
      } catch (error) {
        overlay.classList.add('offline')
        document.getElementById('contentHash').textContent = publicErrorMessage(error)
      }
    }

    scaleOverlay()
    utcClock()
    window.addEventListener('resize', scaleOverlay)
    setInterval(utcClock, 1000)
    setInterval(poll, 4000)
    poll()
  </script>
</body>
</html>`
}

function overlayPreviewHtml({ defaultNetwork, networkLabel, streamId }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Radio Free Ethereum Overlay Preview</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #08090e;
      --text: #f0f1f8;
      --muted: rgba(186, 190, 214, .82);
      --link: #c6ccff;
      --border: #252838;
      font-family: Arial, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
    }

    .stage {
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        #05060a;
      background-size: 8px 8px, 8px 8px, auto;
    }

    .frame {
      position: relative;
      width: min(100vw, calc(100vh * 16 / 9));
      height: min(100vh, calc(100vw * 9 / 16));
      overflow: hidden;
      background: #000;
    }

    video, .preview-overlay {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
    }

    video {
      object-fit: cover;
      background: #000;
      z-index: 1;
    }

    .preview-overlay {
      pointer-events: none;
      background: transparent;
      z-index: 2;
    }

    .overlay-design {
      position: absolute;
      left: 0;
      top: 0;
      width: 1920px;
      height: 1080px;
      transform-origin: 0 0;
      transform: scale(var(--preview-scale, 1));
      color: #f0f1f8;
      font-family: Arial, "Segoe UI", sans-serif;
    }

    .reference {
      position: absolute;
      inset: 0;
      width: 1920px;
      height: 1080px;
      clip-path: inset(0 0 188px 0);
      pointer-events: none;
      user-select: none;
    }

    .chip, .telemetry-card {
      border: 1px solid #252838;
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        #303343;
      background-size: 8px 8px, 8px 8px, auto;
      box-shadow:
        inset 1px 1px 0 rgba(255, 255, 255, .07),
        3px 0 0 #06070c,
        0 4px 0 #06070c,
        6px 6px 0 rgba(0, 0, 0, .42);
    }

    .chip {
      position: absolute;
      top: 31px;
      height: 48px;
      display: grid;
      place-items: center;
      padding: 0 13px;
      color: #c6ccff;
      font: 700 29px/1 Consolas, ui-monospace, monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      z-index: 2;
    }

    .top-telemetry-mask {
      position: absolute;
      left: 660px;
      top: 24px;
      width: 1168px;
      height: 64px;
      background: #181a24;
      z-index: 1;
    }

    #timeUtc { left: 672px; width: 236px; }
    .chip:not(#timeUtc) {
      top: 35px;
      height: 40px;
      padding: 0 11px;
      font-size: 22px;
    }
    #slot { left: 922px; width: 238px; }
    #nonce { left: 1174px; width: 252px; }
    #blockHash { left: 1440px; width: 374px; }

    .network-signal {
      position: absolute;
      left: 113px;
      top: 66px;
      width: 520px;
      height: 31px;
      display: flex;
      align-items: center;
      background: #181a24;
      color: #c6ccff;
      font: 700 26px/1 Consolas, ui-monospace, monospace;
      letter-spacing: 0;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      z-index: 2;
    }

    .lower-panel-mask {
      position: absolute;
      left: 36px;
      top: 948px;
      width: 1848px;
      height: 112px;
      border: 1px solid #252838;
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        #11131a;
      background-size: 8px 8px, 8px 8px, auto;
      box-shadow: inset -3px -3px 0 rgba(0, 0, 0, .42), inset 2px 2px 0 rgba(255, 255, 255, .04);
      z-index: 2;
    }

    .status-label {
      position: absolute;
      left: 64px;
      top: 966px;
      display: block;
      color: #c6ccff;
      font: 900 24px/1 Arial, "Segoe UI", sans-serif;
      text-transform: uppercase;
      z-index: 3;
    }

    .reading-title {
      position: absolute;
      left: 64px;
      top: 1007px;
      width: 690px;
      display: block;
      color: #f0f1f8;
      font: 900 42px/1 Arial, "Segoe UI", sans-serif;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 2px 2px 0 #000;
      z-index: 3;
    }

    .telemetry {
      position: absolute;
      inset: 0;
      margin: 0;
      z-index: 4;
    }

    .telemetry-mask {
      position: absolute;
      left: 792px;
      top: 987px;
      width: 1040px;
      height: 72px;
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        #11131a;
      background-size: 8px 8px, 8px 8px, auto;
      z-index: 0;
    }

    .telemetry-card {
      position: absolute;
      top: 998px;
      height: 54px;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      overflow: hidden;
      font-family: Consolas, ui-monospace, monospace;
      z-index: 1;
    }

    .telemetry-card.tx { left: 784px; width: 252px; }
    .telemetry-card.payload { left: 1060px; width: 196px; }
    .telemetry-card.hash { left: 1280px; width: 244px; }
    .telemetry-card.prev { left: 1548px; width: 244px; }

    .telemetry-card dt {
      margin: 0 0 7px;
      color: rgba(186, 190, 214, .82);
      text-transform: uppercase;
      font: 800 15px/1 Consolas, ui-monospace, monospace;
    }

    .telemetry-card dd {
      margin: 0;
      color: #c6ccff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 800 21px/1 Consolas, ui-monospace, monospace;
    }

    .controls {
      position: fixed;
      left: 16px;
      top: 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: calc(100vw - 32px);
      min-height: 38px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: rgba(17, 19, 26, .88);
      color: var(--muted);
      font: 700 13px/1 Consolas, ui-monospace, monospace;
      box-shadow: 3px 3px 0 #06070c;
      z-index: 3;
    }

    .status-strip {
      color: #f0f1f8;
      white-space: nowrap;
    }

    button {
      border: 1px solid var(--border);
      border-radius: 4px;
      background: #303343;
      color: var(--link);
      font: inherit;
      padding: 5px 9px;
      cursor: pointer;
    }

    button:active, button.is-on {
      transform: translate(1px, 1px);
      box-shadow: inset 2px 2px 0 rgba(0, 0, 0, .28);
    }

    #status {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .debug-drawer {
      position: fixed;
      right: 16px;
      top: 72px;
      width: min(420px, calc(100vw - 32px));
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: rgba(17, 19, 26, .94);
      color: var(--muted);
      font: 700 12px/1.35 Consolas, ui-monospace, monospace;
      box-shadow: 3px 3px 0 #06070c;
      z-index: 4;
    }

    .debug-drawer[hidden] { display: none; }
    body.clean-preview .controls,
    body.clean-preview .debug-drawer {
      display: none;
    }

    body.layer-video .preview-overlay {
      display: none;
    }

    body.layer-overlay video {
      visibility: hidden;
    }

    body.layer-overlay .frame {
      background: #2b2f3a;
    }

    .debug-drawer h2 {
      margin: 0 0 10px;
      color: var(--link);
      font: 900 13px/1 Arial, "Segoe UI", sans-serif;
      text-transform: uppercase;
    }

    .debug-grid {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: 7px 10px;
    }

    .debug-grid dt {
      margin: 0;
      color: #ffaccb;
      text-transform: uppercase;
    }

    .debug-grid dd {
      margin: 0;
      min-width: 0;
      color: #f0f1f8;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <main class="stage">
    <div class="frame">
      <video id="video" controls autoplay playsinline></video>
      <div class="preview-overlay" aria-label="Radio Free Ethereum overlay preview">
        <div id="previewDesign" class="overlay-design">
          <img id="overlayShell" class="reference" src="/rfe-assets/overlays/rfe-terminal-1080p.png" alt="" aria-hidden="true" />
          <div id="networkSignal" class="network-signal">PUBLIC SIGNAL / ${encodeHtmlText(networkLabel(defaultNetwork).toUpperCase())}</div>
          <div class="top-telemetry-mask" aria-hidden="true"></div>
          <div id="timeUtc" class="chip">--:--:-- UTC</div>
          <div id="slot" class="chip">SLOT --</div>
          <div id="nonce" class="chip">SEQ --</div>
          <div id="blockHash" class="chip">BLOCK --</div>
          <div class="lower-panel-mask" aria-hidden="true"></div>
          <div class="status-label">Now Reading</div>
          <div class="reading-title">The EF Mandate</div>
          <dl class="telemetry">
            <div class="telemetry-mask" aria-hidden="true"></div>
            <div class="telemetry-card tx"><dt>Prev TX</dt><dd id="txHash">--</dd></div>
            <div class="telemetry-card payload"><dt>Payload</dt><dd id="payloadSize">--</dd></div>
            <div class="telemetry-card hash"><dt>Hash</dt><dd id="contentHash">--</dd></div>
            <div class="telemetry-card prev"><dt>Prev</dt><dd id="previousHash">--</dd></div>
          </dl>
        </div>
      </div>
    </div>
  </main>
  <div class="controls">
    <span id="liveStrip" class="status-strip">WAITING / ${encodeHtmlText(networkLabel(defaultNetwork))} / seq -- / -- blobs / tx -- / age --</span>
    <button id="debugToggle" type="button" aria-expanded="false">Proof</button>
    <span id="status">loading stream</span>
  </div>
  <aside id="debugDrawer" class="debug-drawer" hidden>
    <h2>Proof Debug</h2>
    <dl class="debug-grid">
      <dt>TX</dt><dd id="debugTx">--</dd>
      <dt>Block</dt><dd id="debugBlock">--</dd>
      <dt>Blobs</dt><dd id="debugBlobs">--</dd>
      <dt>Nonce</dt><dd id="debugNonce">--</dd>
      <dt>Content</dt><dd id="debugContent">--</dd>
      <dt>Generated</dt><dd id="debugGenerated">--</dd>
      <dt>Latest Slot</dt><dd id="debugSlot">--</dd>
    </dl>
  </aside>

  <script>
    const params = new URLSearchParams(location.search)
    const streamId = params.get('streamId') || ${serializeScriptData(streamId)}
    let publisher = params.get('publisher') || ''
    if (params.get('source') === 'clean') document.body.classList.add('clean-preview')
    if (params.get('layer') === 'video') document.body.classList.add('layer-video')
    if (params.get('layer') === 'overlay') document.body.classList.add('layer-overlay')
    const localVideoMode = params.get('video') === 'local'
    let selectedNetwork = (params.get('network') || ${serializeScriptData(defaultNetwork)}).toLowerCase() === 'mainnet' ? 'mainnet' : 'sepolia'
    const endpointPreset = params.get('endpointPreset') === 'public' ? 'public' : ''
    let selectedNetworkLabel = selectedNetwork === 'mainnet' ? 'Mainnet' : 'Sepolia'
    const video = document.getElementById('video')
    const frame = document.querySelector('.frame')
    const previewDesign = document.getElementById('previewDesign')
    const overlayShell = document.getElementById('overlayShell')
    const status = document.getElementById('status')
    const liveStrip = document.getElementById('liveStrip')
    const debugToggle = document.getElementById('debugToggle')
    const debugDrawer = document.getElementById('debugDrawer')
    const pollMs = 3500
    const segments = new Map()
    const payloads = new Map()
    let latestBlobspace = null
    let currentSequence = null
    let activeSegment = null
    let isPlaying = false
    let streamClock = { key: null, startMs: null, durationMs: null, anchorWallMs: null }

    const overlayProfiles = {
      '360p': { width: 640, height: 360, src: '/rfe-assets/overlays/rfe-terminal-360p.png' },
      '420p': { width: 746, height: 420, src: '/rfe-assets/overlays/rfe-terminal-420p.png' },
      '480p': { width: 854, height: 480, src: '/rfe-assets/overlays/rfe-terminal-480p.png' },
      '720p': { width: 1280, height: 720, src: '/rfe-assets/overlays/rfe-terminal-720p.png' },
      '1080p': { width: 1920, height: 1080, src: '/rfe-assets/overlays/rfe-terminal-1080p.png' },
    }

    function overlayShellFor(width, height) {
      const explicitProfile = (params.get('profile') || '').toLowerCase()
      if (overlayProfiles[explicitProfile]) return overlayProfiles[explicitProfile].src
      const explicitWidth = Number(params.get('width') || width || 0)
      const explicitHeight = Number(params.get('height') || height || 0)
      const exact = Object.values(overlayProfiles).find((profile) => profile.width === explicitWidth && profile.height === explicitHeight)
      if (exact) return exact.src
      return overlayProfiles['1080p'].src
    }

    function updateOverlayShell(width, height) {
      overlayShell.src = overlayShellFor(width, height)
    }

    updateOverlayShell()

    function scalePreviewOverlay() {
      const rect = frame.getBoundingClientRect()
      previewDesign.style.setProperty('--preview-scale', String(Math.min(rect.width / 1920, rect.height / 1080)))
    }

    function shorten(value, head, tail) {
      if (!value) return '--'
      const text = String(value)
      if (text.length <= head + tail + 3) return text
      return text.slice(0, head) + '...' + text.slice(-tail)
    }

    function publicErrorMessage(error) {
      return String(error?.message || error || 'Request failed').replace(/https?:\\/\\/[^\\s"'<>)}\\]]+/g, '[redacted endpoint]')
    }

    function formatBytes(value) {
      const n = Number(value || 0)
      return n ? new Intl.NumberFormat('en-US').format(n) + ' B' : '--'
    }

    function proofOrSequenceLabel(segment, proof) {
      if (proof && proof.nonce) return 'PROOF ' + proof.nonce
      if (segment && segment.sequence != null) return 'SEQ #' + segment.sequence
      return 'SEQ --'
    }

    function streamClockText() {
      if (!streamClock.startMs) return new Date().toISOString().slice(11, 19) + ' UTC'
      const elapsed = Math.max(0, Date.now() - streamClock.anchorWallMs)
      const capped = streamClock.durationMs ? Math.min(elapsed, streamClock.durationMs) : elapsed
      return new Date(streamClock.startMs + capped).toISOString().slice(11, 19) + ' UTC'
    }

    function tickClock() {
      document.getElementById('timeUtc').textContent = streamClockText()
    }

    function updateStreamClock(segment) {
      if (!segment || !segment.proof || !segment.proof.generatedAt) return
      const key = segment.streamId + ':' + segment.sequence + ':' + segment.proof.generatedAt
      if (streamClock.key === key) return
      const startMs = Date.parse(segment.proof.generatedAt)
      if (!Number.isFinite(startMs)) return
      streamClock = {
        key,
        startMs,
        durationMs: Number(segment.durationMs || 0) || null,
        anchorWallMs: Date.now(),
      }
      tickClock()
    }

    function orderedSegments() {
      return [...segments.values()]
        .sort((a, b) => Number(a.sequence) - Number(b.sequence))
    }

    function latestSegment() {
      return orderedSegments().at(-1) || null
    }

    function previousSegment(segment) {
      if (!segment || segment.sequence == null) return null
      return orderedSegments()
        .filter((candidate) => Number(candidate.sequence) < Number(segment.sequence))
        .at(-1) || null
    }

    function segmentUrl(sequence) {
      return '/api/segments/' + encodeURIComponent(streamId) + '/' + encodeURIComponent(sequence) + '/payload'
    }

    function apiUrl(path) {
      const url = new URL(path, location.origin)
      url.searchParams.set('network', selectedNetwork)
      if (publisher) url.searchParams.set('publisher', publisher)
      if (endpointPreset) url.searchParams.set('endpointPreset', endpointPreset)
      return url.pathname + url.search
    }

    function liveResponseSegments(data) {
      if (!data || typeof data !== 'object' || !Array.isArray(data.segments)) {
        throw new Error('Live response segments must be an array')
      }
      return data.segments.filter((segment) => !segment.quarantined)
    }

    function updateNetworkSignal(data) {
      const label = data?.networkLabel || data?.transport?.networkLabel || data?.blobspace?.networkLabel || selectedNetworkLabel
      selectedNetworkLabel = label
      selectedNetwork = (data?.network || data?.transport?.network || data?.blobspace?.chain || selectedNetwork) === 'mainnet' ? 'mainnet' : 'sepolia'
      document.getElementById('networkSignal').textContent = 'PUBLIC SIGNAL / ' + String(label).toUpperCase()
    }

    function ageText(segment) {
      const created = Date.parse(segment && segment.createdAt || '')
      if (!Number.isFinite(created)) return '--'
      const seconds = Math.max(0, Math.round((Date.now() - created) / 1000))
      if (seconds < 90) return seconds + 's'
      const minutes = Math.round(seconds / 60)
      if (minutes < 90) return minutes + 'm'
      return Math.round(minutes / 60) + 'h'
    }

    function setStatusStrip(segment, state) {
      const seq = segment ? '#' + segment.sequence : '--'
      const blobs = segment ? segment.blobCount + ' blobs' : '-- blobs'
      const tx = segment ? shorten(segment.txHash, 8, 6) : '--'
      liveStrip.textContent = state + ' / ' + selectedNetworkLabel + ' / seq ' + seq + ' / ' + blobs + ' / tx ' + tx + ' / age ' + ageText(segment)
    }

    function updateDebug(segment, data) {
      const proof = segment && segment.proof ? segment.proof : {}
      document.getElementById('debugTx').textContent = segment && segment.txHash || '--'
      document.getElementById('debugBlock').textContent = segment && segment.blockNumber || proof.block && proof.block.number || '--'
      document.getElementById('debugBlobs').textContent = segment ? String(segment.blobCount || '--') : '--'
      document.getElementById('debugNonce').textContent = proof.nonce || '--'
      document.getElementById('debugContent').textContent = segment && (segment.payloadSha256Hex || segment.payloadSha256) || '--'
      document.getElementById('debugGenerated').textContent = proof.generatedAt || '--'
      document.getElementById('debugSlot').textContent = data && data.blobspace && data.blobspace.latestSlot || '--'
    }

    function updateTelemetry(segment, data) {
      if (!segment) {
        setStatusStrip(null, 'WAITING')
        updateDebug(null, data)
        return
      }
      const proof = segment.proof || {}
      const blockHash = segment.blockHash || (proof.block && proof.block.hash)
      const previous = previousSegment(segment)
      updateStreamClock(segment)
      document.getElementById('slot').textContent = 'SLOT ' + (segment.slot || (data && data.blobspace && data.blobspace.latestSlot) || '--')
      document.getElementById('nonce').textContent = proofOrSequenceLabel(segment, proof)
      document.getElementById('blockHash').textContent = 'BLOCK ' + shorten(blockHash, 8, 4)
      document.getElementById('txHash').textContent = shorten(previous && previous.txHash, 10, 6)
      document.getElementById('payloadSize').textContent = formatBytes(segment.payloadBytes)
      document.getElementById('contentHash').textContent = shorten(segment.payloadSha256Hex || segment.payloadSha256, 10, 6)
      document.getElementById('previousHash').textContent = shorten(segment.previousSegmentHash, 10, 6)
      setStatusStrip(segment, isPlaying ? 'LIVE' : 'WAITING')
      updateDebug(segment, data)
    }

    async function pollLive() {
      const response = await fetch(apiUrl('/api/streams/' + encodeURIComponent(streamId) + '/live'), { cache: 'no-store' })
      if (!response.ok) throw new Error(await response.text())
      const data = await response.json()
      if (data.publisher) publisher = data.publisher
      updateNetworkSignal(data)
      latestBlobspace = data.blobspace || null
      for (const segment of liveResponseSegments(data)) {
        segments.set(Number(segment.sequence), segment)
      }
      const latest = latestSegment()
      updateTelemetry(activeSegment || latest, data)
      if (localVideoMode) {
        status.textContent = latest ? 'playing local preview video / seq ' + latest.sequence : 'playing local preview video'
        setStatusStrip(latest, 'PREVIEW')
        return
      }
      if (!latest) {
        status.textContent = 'waiting for Station metadata'
        return
      }
      if (currentSequence === null && !isPlaying) {
        await playSegment(latest)
        return
      }
      const next = segments.get(Number(currentSequence) + 1)
      if (next) {
        prefetchSegment(next)
        if (!isPlaying) await playSegment(next)
      } else if (!isPlaying) {
        status.textContent = 'waiting for seq ' + (Number(currentSequence) + 1)
        setStatusStrip(activeSegment || latest, 'WAITING')
      }
    }

    function prunePayloads() {
      for (const [sequence, entry] of payloads) {
        if (currentSequence !== null && Number(sequence) < Number(currentSequence) - 1 && entry.url) {
          URL.revokeObjectURL(entry.url)
          payloads.delete(sequence)
        }
      }
    }

    function prefetchSegment(segment) {
      const sequence = Number(segment.sequence)
      if (payloads.has(sequence)) return payloads.get(sequence).promise
      const promise = fetch(apiUrl(segmentUrl(sequence)), { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error('payload ' + sequence + ': ' + response.status)
          return response.blob()
        })
        .then((blob) => {
          const entry = payloads.get(sequence) || {}
          entry.url = URL.createObjectURL(blob)
          payloads.set(sequence, entry)
          return entry.url
        })
        .catch((error) => {
          payloads.delete(sequence)
          throw error
        })
      payloads.set(sequence, { promise, url: null })
      return promise
    }

    async function playSegment(segment) {
      currentSequence = Number(segment.sequence)
      activeSegment = segment
      updateTelemetry(segment, { blobspace: latestBlobspace })
      status.textContent = 'fetching seq ' + segment.sequence
      const url = await prefetchSegment(segment)
      video.loop = false
      video.src = url
      video.muted = true
      status.textContent = 'playing seq ' + segment.sequence
      isPlaying = true
      setStatusStrip(segment, 'LIVE')
      const next = segments.get(Number(segment.sequence) + 1)
      if (next) prefetchSegment(next)
      prunePayloads()
      try {
        await video.play()
      } catch {
        status.textContent = 'seq ' + segment.sequence + ' ready / press play for video and audio'
      }
    }

    async function playNext() {
      isPlaying = false
      const next = segments.get(Number(currentSequence) + 1)
      if (next) {
        await playSegment(next)
        return
      }
      status.textContent = 'waiting for seq ' + (Number(currentSequence) + 1)
      setStatusStrip(activeSegment || latestSegment(), 'WAITING')
    }

    debugToggle.addEventListener('click', () => {
      const open = debugDrawer.hasAttribute('hidden')
      debugDrawer.toggleAttribute('hidden', !open)
      debugToggle.classList.toggle('is-on', open)
      debugToggle.setAttribute('aria-expanded', String(open))
    })
    if (localVideoMode) {
      video.loop = true
      video.muted = true
      video.src = apiUrl('/preview-video')
      video.play().catch(() => {
        status.textContent = 'local preview video ready / press play'
      })
    }
    video.addEventListener('loadedmetadata', () => {
      updateOverlayShell(video.videoWidth, video.videoHeight)
    })
    video.addEventListener('playing', () => {
      isPlaying = true
      status.textContent = 'playing seq ' + (currentSequence ?? '--')
      setStatusStrip(activeSegment, 'LIVE')
    })
    video.addEventListener('waiting', () => {
      status.textContent = 'buffering seq ' + (currentSequence ?? '--')
    })
    video.addEventListener('ended', () => playNext().catch((error) => { status.textContent = publicErrorMessage(error) }))
    window.addEventListener('resize', scalePreviewOverlay)
    scalePreviewOverlay()
    tickClock()
    setInterval(tickClock, 1000)
    setInterval(() => {
      const segment = activeSegment || latestSegment()
      if (segment) setStatusStrip(segment, isPlaying ? 'LIVE' : 'WAITING')
    }, 1000)
    setInterval(() => pollLive().catch((error) => { status.textContent = publicErrorMessage(error) }), pollMs)
    pollLive().catch((error) => { status.textContent = publicErrorMessage(error) })
  </script>
</body>
</html>`
}
