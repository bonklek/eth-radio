import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { createLiveDemoPages } from './lib/live-demo-pages.mjs'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

async function waitForPage(url, child) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`live demo exited before serving pages (${child.exitCode})`)
    try {
      return await fetch(url, { signal: AbortSignal.timeout(1000) })
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error('live demo did not start within 10 seconds')
}

function safeScriptJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function assertSafeInlineScript(page, values, label) {
  assert.ok(!page.includes('</script><script>'), `${label} must not contain an injected script boundary`)
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.equal(scripts.length, 1, `${label} must retain exactly one inline script`)
  const script = scripts[0][1]
  assert.ok(!script.includes('\u2028'), `${label} must escape U+2028 in inline script data`)
  assert.ok(!script.includes('\u2029'), `${label} must escape U+2029 in inline script data`)
  for (const value of values) {
    assert.ok(script.includes(safeScriptJson(value)), `${label} must contain safely serialized script data`)
  }
  assert.doesNotThrow(() => new Function(script), `${label} inline script must remain valid JavaScript`)
}

const canonicalStationAddress = '0x060c51d481808b506dfae72f054f39e11e4f4017'
const serverSource = fs.readFileSync(new URL('./serve-live-demo.mjs', import.meta.url), 'utf8')
const pagesSource = fs.readFileSync(new URL('./lib/live-demo-pages.mjs', import.meta.url), 'utf8')
assert.ok(serverSource.split(/\r?\n/).length < 1800, 'server entrypoint should remain focused on data and routing')
assert.ok(!serverSource.includes('<!doctype html>'), 'server entrypoint must not embed full HTML documents')
assert.match(serverSource, /createLiveDemoPages\(\{/)
for (const name of ['overlayHtml', 'overlayPreviewHtml']) {
  assert.match(pagesSource, new RegExp(`function ${name}\\(`))
}
assert.equal((pagesSource.match(/\$\{serializeScriptData\(/g) || []).length, 4, 'every injected script value must use the shared serializer')
assert.equal((pagesSource.match(/\$\{encodeHtmlText\(/g) || []).length, 3, 'every option-derived text value must use text encoding')
assert.ok(!pagesSource.includes('${JSON.stringify('), 'templates must not interpolate raw JSON.stringify output')
const endpointPresets = {
  sepolia: {
    public: { ethRpcUrl: 'https://execution.example', beaconRpcUrl: 'https://beacon.example' },
  },
}
const contextCalls = []
const pages = createLiveDemoPages({
  canonicalStationAddress,
  defaultNetwork: 'sepolia',
  endpointPresets,
  networkContext(network) {
    contextCalls.push(network)
    return {
      explorerBase: 'https://explorer.example',
      stationAddress: '',
    }
  },
  networkLabel: (network) => network === 'sepolia' ? 'Sepolia' : 'Mainnet',
  streamId: 'rfe-test-stream',
  viewerPollMs: 2345,
})

const overlay = pages.overlayHtml()
assert.match(overlay, /^<!doctype html>/)
assert.match(overlay, /<title>Radio Free Ethereum Overlay<\/title>/)
assert.match(overlay, /PUBLIC SIGNAL \/ SEPOLIA/)
assert.match(overlay, /const streamId = params\.get\('streamId'\) \|\| "rfe-test-stream"/)
assert.match(overlay, /let selectedNetwork = \(params\.get\('network'\) \|\| "sepolia"\)/)
assert.match(overlay, /setInterval\(poll, 4000\)/)

const preview = pages.overlayPreviewHtml()
assert.match(preview, /^<!doctype html>/)
assert.match(preview, /<title>Radio Free Ethereum Overlay Preview<\/title>/)
assert.match(preview, /WAITING \/ Sepolia \/ seq --/)
assert.match(preview, /const streamId = params\.get\('streamId'\) \|\| "rfe-test-stream"/)
assert.match(preview, /let selectedNetwork = \(params\.get\('network'\) \|\| "sepolia"\)/)

assert.deepEqual(contextCalls, [], 'overlay templates must not initialize the removed duplicate viewer')

assert.equal(pages.overlayHtml(), overlay, 'overlay output should be deterministic')
assert.equal(pages.overlayPreviewHtml(), preview, 'preview output should be deterministic')

const hostileValue = `quotes ' " \\ </script><script> & < > \u2028\u2029`
const hostileLabel = `Signal </div><script> & < > " ' \u2028\u2029`
const hostileSerialized = safeScriptJson(hostileValue)
for (const escaped of ['\\"', '\\\\', '\\u003c', '\\u003e', '\\u0026', '\\u2028', '\\u2029']) {
  assert.ok(hostileSerialized.includes(escaped), `script serializer must preserve hostile data through ${escaped}`)
}
const hostileEndpointPresets = {
  [`preset-${hostileValue}`]: {
    label: hostileValue,
    networks: { [hostileValue]: { executionRpc: hostileValue, beaconApi: hostileValue } },
  },
}
const hostilePages = createLiveDemoPages({
  canonicalStationAddress: hostileValue,
  defaultNetwork: hostileValue,
  endpointPresets: hostileEndpointPresets,
  networkContext: () => ({
    explorerBase: `https://explorer.invalid/${hostileValue}`,
    stationAddress: hostileValue,
  }),
  networkLabel: () => hostileLabel,
  streamId: hostileValue,
  viewerPollMs: hostileValue,
})
const hostileOverlay = hostilePages.overlayHtml()
const hostilePreview = hostilePages.overlayPreviewHtml()
assertSafeInlineScript(hostileOverlay, [hostileValue], 'hostile overlay')
assertSafeInlineScript(hostilePreview, [hostileValue], 'hostile overlay preview')
for (const page of [hostileOverlay, hostilePreview]) {
  assert.ok(page.includes('SIGNAL &lt;/DIV&gt;&lt;SCRIPT&gt; &amp; &lt; &gt;'), 'overlay network labels must be HTML text encoded')
  assert.ok(!page.includes(hostileLabel), 'overlay network labels must not be emitted raw')
}

const portProbe = net.createServer()
const port = await listen(portProbe)
await close(portProbe)
const serverEndpointPresets = {
  public: {
    label: 'Public RPC preset',
    networks: {
      sepolia: {
        executionRpc: 'https://sepolia.drpc.org',
        beaconApi: 'https://ethereum-sepolia-beacon-api.publicnode.com',
      },
      mainnet: {
        executionRpc: 'https://ethereum-rpc.publicnode.com',
        beaconApi: 'https://ethereum-beacon-api.publicnode.com',
      },
    },
  },
}
const expectedServerPages = createLiveDemoPages({
  canonicalStationAddress,
  defaultNetwork: 'sepolia',
  endpointPresets: serverEndpointPresets,
  networkContext: () => ({
    explorerBase: 'https://sepolia.etherscan.io',
    stationAddress: canonicalStationAddress,
  }),
  networkLabel: () => 'Sepolia',
  streamId: hostileValue,
  viewerPollMs: 2345,
})
const server = spawn(process.execPath, ['scripts/serve-live-demo.mjs'], {
  env: {
    ...process.env,
    PORT: String(port),
    CHAIN: 'sepolia',
    STATION_ADDRESS: canonicalStationAddress,
    STREAM_ID: hostileValue,
    VIEWER_POLL_MS: '2345',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
try {
  for (const [route, pageName] of [
    ['/overlay', 'overlayHtml'],
    ['/overlay-preview', 'overlayPreviewHtml'],
  ]) {
    const response = await waitForPage(`http://127.0.0.1:${port}${route}`, server)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin')
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const body = await response.text()
    assertSafeInlineScript(body, [hostileValue], `${route} live response`)
    assert.equal(body, expectedServerPages[pageName](), `${route} must return the extracted template unchanged`)
  }
  const viewerResponse = await waitForPage(`http://127.0.0.1:${port}/`, server)
  assert.equal(await viewerResponse.text(), fs.readFileSync('public/decentralized/index.html', 'utf8'))
} finally {
  server.kill()
}

console.log('live demo page templates ok')
