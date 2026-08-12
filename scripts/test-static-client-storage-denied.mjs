import assert from 'node:assert/strict'
import { loadStaticClientProduction } from './lib/static-client-headless.mjs'

const denied = () => {
  throw new DOMException('Storage denied by browser policy', 'SecurityError')
}
const deniedStorage = {
  getItem: denied,
  setItem: denied,
  removeItem: denied,
  clear: denied,
}
const deniedIndexedDb = { open: denied }
let unhandled = null
const onUnhandled = (error) => { unhandled = error }
process.on('unhandledRejection', onUnhandled)

const client = await loadStaticClientProduction({
  localStorage: deniedStorage,
  indexedDB: deniedIndexedDb,
  waitMs: 150,
})
const { window } = client

assert.match(window.document.querySelector('#utc-clock')?.textContent || '', /UTC|local/, 'production startup did not complete')
assert.match(window.document.querySelector('#status')?.textContent || '', /storage|settings|memory|tab/i)
assert.match(window.document.querySelector('#cache-size')?.textContent || '', /memory only/i)
assert.equal(window.document.querySelector('#stream-toggle')?.disabled, false, 'network viewing controls should remain usable')

window.document.querySelector('#clear-cache')?.click()
await new Promise((resolve) => setTimeout(resolve, 25))
assert.match(window.document.querySelector('#status')?.textContent || '', /memory|tab/i)
assert.equal(unhandled, null, `storage-denied startup produced an unhandled rejection: ${unhandled}`)

process.off('unhandledRejection', onUnhandled)
client.close()
console.log('static client storage-denied production test ok')
