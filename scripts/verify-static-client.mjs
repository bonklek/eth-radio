import fs from 'node:fs'
import path from 'node:path'
import { helpRequested } from './lib/cli-help.mjs'

if (helpRequested()) {
  console.log(`Usage:
  pnpm web:static

Verifies static-client source, security, accessibility, and production contracts.
`)
  process.exit(0)
}

const root = process.cwd()
const staticDir = path.join(root, 'public', 'decentralized')
const read = (file) => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
const required = [
  'index.html', 'styles.css', 'static-client-limits.js', 'static-client-core.js',
  'static-client-io.js', 'static-client-media.js', 'app.js',
]
for (const name of required) {
  if (!fs.existsSync(path.join(staticDir, name))) throw new Error(`Missing static client file: ${name}`)
}

const html = read(path.join(staticDir, 'index.html'))
const css = read(path.join(staticDir, 'styles.css'))
const app = read(path.join(staticDir, 'app.js'))
const core = read(path.join(staticDir, 'static-client-core.js'))
const io = read(path.join(staticDir, 'static-client-io.js'))
const media = read(path.join(staticDir, 'static-client-media.js'))
const kernel = read(path.join(root, 'packages/protocol/browser-kernel.js'))
const builder = read(path.join(root, 'scripts/build-static-client.mjs'))
const server = read(path.join(root, 'scripts/serve-static-client.mjs'))
const demo = read(path.join(root, 'scripts/serve-live-demo.mjs'))
const sources = [app, core, io, media, kernel]

for (const forbidden of ['/api/', 'localhost', '127.0.0.1', 'process.env', 'import.meta.env']) {
  if (sources.some((source) => source.includes(forbidden))) throw new Error(`Static client should not reference ${forbidden}`)
}
for (const [specifier, owner] of [
  ["./static-client-core.js", 'pure core'],
  ["./static-client-io.js", 'bounded I/O'],
  ["./static-client-media.js", 'media codec'],
  ["../../packages/protocol/browser-kernel.js", 'protocol kernel'],
]) {
  if (!app.includes(`from '${specifier}'`)) throw new Error(`Static client should import its ${owner} module`)
}
for (const [source, label, exports] of [
  [core, 'core', ['canonicalStreamIdHash', 'channelIdentity', 'annotateStreamContinuity', 'assertPlayableContinuity']],
  [io, 'I/O', ['fetchWithTimeout', 'readBoundedResponseBytes', 'runEndpointFallback', 'isBlobHex']],
  [media, 'media', ['normalizeSidecarRecord', 'reconstructPayload', 'segmentPayloadLength', 'archiveUrl']],
  [kernel, 'kernel', ['executionTimestampSlot', 'slotStartTimestamp']],
]) {
  for (const name of exports) {
    if (!source.includes(`export function ${name}(`) && !source.includes(`export async function ${name}(`)) {
      throw new Error(`Static ${label} module is missing ${name}`)
    }
    if (app.includes(`function ${name}(`)) throw new Error(`Static app should not duplicate ${name}`)
  }
}

for (const behavior of [
  'indexedDB', 'eth_getLogs', '/eth/v1/beacon/blob_sidecars/', 'archiveTemplates',
  'withEndpointFallback', 'enforceCacheLimit', 'safeStorageGet', 'safeStorageSet',
  'sidecarMemoryCache', 'restoreInitialCachedMetadata', 'startBlobspaceRail',
]) {
  if (!app.includes(behavior)) throw new Error(`Missing static client behavior marker: ${behavior}`)
}
if ((app.match(/localStorage\.getItem\(/g) || []).length !== 1
  || (app.match(/localStorage\.setItem\(/g) || []).length !== 1) {
  throw new Error('Static client localStorage access should remain behind guarded helpers')
}
if (/\bfetch\(/.test(app)) throw new Error('Static app should use its bounded I/O module rather than raw fetch')
if (!io.includes('fetchImpl(resource,') || !io.includes('if (isAbortError(error)) throw error')) {
  throw new Error('Static I/O should preserve injectable fetch and abort semantics')
}
if (!media.includes('Array.isArray(sidecars?.matches)')
  || !media.includes('isBytes32Hex(match.versionedHash)')
  || !media.includes('isBlobHex(match.blob)')) {
  throw new Error('Static media codec should validate sidecars before reconstruction')
}

if (!builder.includes("'static-client-media.js'")
  || !builder.includes('escapeRawTextElementContent')
  || !builder.includes("escapeRawTextElementContent(css, 'style')")
  || !builder.includes("escapeRawTextElementContent(bundledApp, 'script')")
  || !builder.includes('may only import earlier allowlisted modules')
  || !builder.includes('contains an unsupported module import')) {
  throw new Error('Static builder should flatten only its allowlisted acyclic modules and safely inline assets')
}
for (const documentMarker of [
  'Content-Security-Policy', 'id="player"', 'id="settings-panel-appearance"',
  'role="dialog" aria-modal="true"', 'id="segment-lookup"',
  'https://github.com/bonklek/eth-radio', 'target="_blank" rel="noreferrer"',
]) {
  if (!html.includes(documentMarker)) throw new Error(`Missing static document boundary: ${documentMarker}`)
}
if (!html.includes('<script type="module" src="./app.js"></script>')
  || !html.includes('<link rel="stylesheet" href="./styles.css" />')) {
  throw new Error('Source client should retain external module and stylesheet entrypoints')
}
for (const cssMarker of ['visually-hidden', ':focus-visible', '@media (max-width: 980px)', '.settings-panel']) {
  if (!css.includes(cssMarker)) throw new Error(`Missing static accessibility/layout style: ${cssMarker}`)
}

for (const [label, source] of [['static server', server], ['live demo', demo]]) {
  for (const header of [
    "'cache-control': 'no-store'", "'cross-origin-opener-policy': 'same-origin'",
    "'referrer-policy': 'no-referrer'", "'x-content-type-options': 'nosniff'",
  ]) {
    if (!source.includes(header)) throw new Error(`${label} should send ${header}`)
  }
}
if (!server.includes("'127.0.0.1'") || !demo.includes("'127.0.0.1'")) {
  throw new Error('Development servers must remain loopback-only')
}

console.log(`static client ok: ${staticDir}`)
