import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const staticDir = path.join(root, 'public', 'decentralized')
const required = ['index.html', 'styles.css', 'app.js']

for (const name of required) {
  const file = path.join(staticDir, name)
  if (!fs.existsSync(file)) throw new Error(`Missing static client file: ${file}`)
}

const app = fs.readFileSync(path.join(staticDir, 'app.js'), 'utf8')
const forbidden = ['/api/', 'localhost', '127.0.0.1']
for (const token of forbidden) {
  if (app.includes(token)) throw new Error(`Static client should not reference ${token}`)
}

if (!app.includes('indexedDB')) throw new Error('Static client should cache verified payloads in IndexedDB')
if (!app.includes('eth_getLogs')) throw new Error('Static client should read Station logs from execution RPC')
if (!app.includes('/eth/v1/beacon/blob_sidecars/')) {
  throw new Error('Static client should fetch beacon blob sidecars directly')
}
if (!app.includes('archiveTemplates')) throw new Error('Static client should support decentralized archive fallbacks')
if (!app.includes('withEndpointFallback')) throw new Error('Static client should fail over across configured endpoints')
if (!app.includes('enforceCacheLimit')) throw new Error('Static client should manage browser cache limits')

const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8')
for (const id of ['chain-preset', 'execution-rpcs', 'beacon-apis', 'archive-templates', 'cache-limit']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`Missing static client control: ${id}`)
}
if (!app.includes('CHAIN_PRESETS')) throw new Error('Static client should expose chain endpoint presets')
if (!app.includes('mainnet')) throw new Error('Static client should include mainnet endpoint readiness')

console.log(`static client ok: ${staticDir}`)
