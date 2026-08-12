import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadStaticClientProduction } from './lib/static-client-headless.mjs'

const root = process.cwd()
const build = spawnSync(process.execPath, ['scripts/build-static-client.mjs'], { cwd: root, stdio: 'inherit' })
if (build.status !== 0) throw new Error(`Static build failed with exit code ${build.status}`)

const client = await loadStaticClientProduction({
  artifactPath: path.join(root, 'dist', 'decentralized', 'index.html'),
  url: 'http://127.0.0.1/?network=sepolia',
})

try {
  const { document } = client.window
  assert.notEqual(document.querySelector('#utc-clock')?.textContent, '--:--:-- UTC', 'bundled artifact clock did not initialize')
  assert.equal(document.querySelector('#network-label')?.textContent, 'Sepolia')
  assert.equal(document.querySelector('#play-latest')?.disabled, true)

  document.querySelector('#settings-toggle')?.click()
  assert.equal(document.querySelector('#settings-modal')?.hidden, false, 'bundled Settings handler did not initialize')
  assert.equal(document.body.classList.contains('settings-open'), true)
  document.querySelector('#settings-close')?.click()
  assert.equal(document.querySelector('#settings-modal')?.hidden, true)

  const wasLight = document.body.classList.contains('light')
  document.querySelector('#theme-toggle')?.click()
  assert.equal(document.body.classList.contains('light'), !wasLight, 'bundled Theme handler did not initialize')
  document.querySelector('#theme-toggle')?.click()
  assert.equal(document.body.classList.contains('light'), wasLight)

  console.log('static artifact production smoke ok')
} finally {
  client.close()
}
