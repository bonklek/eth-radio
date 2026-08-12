import assert from 'node:assert/strict'
import fs from 'node:fs'
import { loadStaticClientProduction } from './lib/static-client-headless.mjs'

const productionApp = fs.readFileSync(new URL('../public/decentralized/app.js', import.meta.url), 'utf8')

const client = await loadStaticClientProduction({
  url: 'http://127.0.0.1/?network=sepolia&executionRpc=https%3A%2F%2Fsecret.example%2Fcredential',
})
const { window, requestedUrls } = client

assert.equal(window.location.search, '?network=sepolia', 'sensitive endpoint parameters must be removed during production startup')
assert.equal(window.document.body.dataset.startup, 'ready')
assert.equal(window.document.querySelector('#startup-shell')?.hidden, true)
assert.equal(window.document.querySelector('#app-shell')?.hasAttribute('inert'), false)
assert.equal(window.document.querySelector('#app-shell')?.getAttribute('aria-hidden'), null)
assert.equal(requestedUrls.some(({ url }) => url.includes('secret.example')), false, 'production startup contacted a URL-supplied endpoint')
assert.match(window.document.querySelector('#utc-clock')?.textContent || '', /UTC|local/)
assert.equal(window.document.querySelector('#network-label')?.textContent, 'Sepolia')
assert.equal(window.document.querySelector('#stream-toggle')?.getAttribute('aria-pressed'), 'false')
assert.equal(window.document.querySelector('#play-latest')?.disabled, true, 'Play latest should be disabled without verified media')
assert.equal(window.document.querySelector('#player')?.getAttribute('aria-label'), 'Ethereum blob radio player')
assert.equal(window.document.querySelector('#player')?.hasAttribute('controls'), true, 'native media recovery controls must remain available')
assert.equal(window.document.querySelector('#status')?.getAttribute('role'), null, 'visible polling status must not also be a noisy live region')
assert.equal(window.document.querySelector('#status-announcer')?.getAttribute('aria-live'), 'polite')
assert.equal(window.document.querySelector('#alert-announcer')?.getAttribute('aria-live'), 'assertive')
assert.equal(window.document.querySelector('#execution-rpcs')?.getAttribute('aria-describedby'), 'endpoint-url-help')
assert.equal(window.document.querySelector('#beacon-apis')?.getAttribute('aria-describedby'), 'endpoint-url-help')
assert.equal(window.document.querySelector('#archive-templates')?.getAttribute('aria-describedby'), 'archive-template-help')
assert.match(window.document.querySelector('#archive-template-help')?.textContent || '', /\{payloadSha256\}/)
assert.doesNotMatch(
  window.document.querySelector('#status')?.textContent || '',
  /Cached metadata could not be restored/,
  'an intentionally incomplete default channel identity must skip scoped cache restoration without reporting corruption',
)
const playLatestStart = productionApp.indexOf('function renderPlayLatest(')
const playLatestEnd = productionApp.indexOf('function render()', playLatestStart)
assert.ok(playLatestStart >= 0 && playLatestEnd > playLatestStart, 'production Play latest renderer must be testable')
let productionLatestPlayable = { sequence: 42 }
const renderPlayLatest = new Function('els', 'latestVerifiedRecord', `${productionApp.slice(playLatestStart, playLatestEnd)}; return renderPlayLatest`)(
  { playLatest: window.document.querySelector('#play-latest') },
  () => productionLatestPlayable,
)
renderPlayLatest()
assert.equal(window.document.querySelector('#play-latest')?.disabled, false, 'verified playable media should enable Play latest')
assert.equal(window.document.querySelector('#play-latest')?.title, 'Play verified segment #42')
productionLatestPlayable = null
renderPlayLatest()
assert.equal(window.document.querySelector('#play-latest')?.disabled, true, 'clearing verified media should disable Play latest again')
assert.equal(window.document.querySelector('#play-latest')?.title, 'No verified segment is ready to play')
assert.equal(window.document.querySelector('.chain-toggle')?.getAttribute('role'), 'group')
assert.equal(window.document.querySelector('#chain-mainnet')?.getAttribute('aria-label'), 'Ethereum mainnet')
assert.equal(window.document.querySelector('#chain-sepolia')?.getAttribute('aria-label'), 'Sepolia testnet')
assert.equal(window.document.querySelector('.feed-panes')?.getAttribute('role'), 'region')
assert.equal(window.document.querySelector('.archive-mode-toggle')?.getAttribute('role'), 'group')
assert.equal(window.document.querySelector('.endpoint-setup')?.getAttribute('role'), 'group')
assert.ok(requestedUrls.length > 0, 'production startup did not exercise its beacon request path')
for (const { options } of requestedUrls) {
  assert.equal(options.credentials, 'omit')
  assert.equal(options.referrerPolicy, 'no-referrer')
}

const rangeMode = window.document.querySelector('#archive-range-mode')
rangeMode.value = 'block'
rangeMode.dispatchEvent(new window.Event('change', { bubbles: true }))
assert.equal(window.document.querySelector('#archive-from-block')?.disabled, false)
assert.equal(window.document.querySelector('#archive-from-date')?.disabled, true)
assert.equal(window.document.querySelector('#archive-to-date')?.disabled, true)

const loopToggle = window.document.querySelector('#loop-toggle')
loopToggle.click()
assert.equal(loopToggle.getAttribute('aria-pressed'), 'true')
assert.equal(window.document.querySelector('#player')?.loop, false, 'production LOOP must not enable native single-resource looping')

const settingsToggle = window.document.querySelector('#settings-toggle')
settingsToggle.focus()
settingsToggle.click()
assert.equal(window.document.querySelector('#settings-modal')?.hidden, false)
assert.equal(window.document.activeElement?.id, 'settings-tab-appearance')
const appearanceTab = window.document.querySelector('#settings-tab-appearance')
const layoutTab = window.document.querySelector('#settings-tab-layout')
const connectionsTab = window.document.querySelector('#settings-tab-connections')
assert.equal(appearanceTab.getAttribute('aria-controls'), 'settings-panel-appearance')
assert.equal(appearanceTab.tabIndex, 0)
assert.equal(layoutTab.tabIndex, -1)
appearanceTab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
assert.equal(window.document.activeElement?.id, 'settings-tab-layout')
assert.equal(layoutTab.getAttribute('aria-selected'), 'true')
assert.equal(layoutTab.tabIndex, 0)
assert.equal(appearanceTab.tabIndex, -1)
assert.equal(window.document.querySelector('#settings-panel-layout')?.hidden, false)
assert.equal(window.document.querySelector('#settings-panel-appearance')?.hidden, true)
layoutTab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
assert.equal(window.document.activeElement?.id, 'settings-tab-connections')
connectionsTab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
assert.equal(window.document.activeElement?.id, 'settings-tab-appearance', 'ArrowRight should wrap to the first settings tab')
appearanceTab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
assert.equal(window.document.activeElement?.id, 'settings-tab-connections', 'ArrowLeft should wrap to the last settings tab')
connectionsTab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
assert.equal(window.document.activeElement?.id, 'settings-tab-appearance')

const endpointPreset = window.document.querySelector('[data-endpoint-preset="mainnet"]')
endpointPreset.focus()
endpointPreset.click()
assert.equal(window.document.activeElement?.dataset?.focusKey, 'endpoint-preset:mainnet', 'endpoint preset rerender must preserve logical focus')
assert.equal(window.document.activeElement?.getAttribute('aria-pressed'), 'true')

const layoutPresetButtons = [...window.document.querySelectorAll('[data-layout-preset]')]
assert.equal(layoutPresetButtons.filter((button) => button.getAttribute('aria-pressed') === 'true').length, 1)
const playerSidePreset = window.document.querySelector('[data-layout-preset="player-side"]')
playerSidePreset.click()
assert.equal(playerSidePreset.getAttribute('aria-pressed'), 'true')
assert.equal(layoutPresetButtons.filter((button) => button.getAttribute('aria-pressed') === 'true').length, 1)
const playerPosition = window.document.querySelector('#layout-position-player')
playerPosition.value = playerPosition.value === 'main' ? 'left' : 'main'
playerPosition.dispatchEvent(new window.Event('change', { bubbles: true }))
assert.equal(layoutPresetButtons.every((button) => button.getAttribute('aria-pressed') === 'false'), true, 'custom layout should not claim a preset')

const playerVisibility = window.document.querySelector('#layout-show-player')
const layoutRecovery = window.document.querySelector('#layout-recovery')
playerVisibility.checked = false
playerVisibility.dispatchEvent(new window.Event('change', { bubbles: true }))
assert.equal(window.document.querySelector('.panel-player')?.hidden, true)
assert.equal(layoutRecovery.hidden, false, 'hiding Player must expose the recovery dock')
assert.equal(window.document.querySelector('#status-recovery')?.textContent, 'Player hidden.')
window.document.querySelector('#settings-close')?.click()
assert.equal(window.document.activeElement?.id, 'settings-recovery-toggle', 'focus should return to the visible recovery control')
window.document.querySelector('#settings-recovery-toggle')?.click()
assert.equal(window.document.querySelector('#settings-modal')?.hidden, false)
assert.equal(window.document.activeElement?.id, 'settings-tab-layout', 'recovery should open the Layout settings directly')
playerVisibility.checked = true
playerVisibility.dispatchEvent(new window.Event('change', { bubbles: true }))
assert.equal(window.document.querySelector('.panel-player')?.hidden, false)
assert.equal(layoutRecovery.hidden, true)

const segmentTable = window.document.querySelector('.segments-table')
assert.equal(segmentTable.getAttribute('role'), 'table')
assert.equal(segmentTable.getAttribute('aria-colcount'), '5')
assert.equal(segmentTable.querySelectorAll('[role="columnheader"]').length, 5)
assert.equal(window.document.querySelector('#segments')?.getAttribute('role'), 'rowgroup')
window.document.querySelector('#settings-close')?.click()
assert.equal(window.document.querySelector('#settings-modal')?.hidden, true)
assert.equal(window.document.activeElement?.id, 'settings-toggle')

const productionCss = fs.readFileSync(new URL('../public/decentralized/styles.css', import.meta.url), 'utf8')
const style = window.document.createElement('style')
style.textContent = productionCss
window.document.head.append(style)
window.happyDOM.setWindowSize({ width: 390, height: 844 })
const longUnbrokenText = 'publisher_stream_status_'.repeat(80)
for (const selector of ['#empty-state strong', '#empty-state span', '#status', '#now-title', '#now-detail', '.archive-progress', '.endpoint-apply-status']) {
  const element = window.document.querySelector(selector)
  assert.ok(element, `missing long-string surface: ${selector}`)
  element.textContent = longUnbrokenText
  assert.equal(window.getComputedStyle(element).overflowWrap, 'anywhere', `${selector} must emergency-wrap long unbroken text`)
}
assert.equal(window.document.querySelector('#blobspace-warning')?.getAttribute('role'), null)
assert.equal(window.document.querySelector('#blobspace-warning')?.getAttribute('aria-live'), null)
assert.equal(window.document.querySelector('.archive-progress-row')?.getAttribute('role'), null)
assert.equal(window.document.querySelector('#endpoint-apply-status')?.getAttribute('role'), null)
assert.equal(window.getComputedStyle(window.document.querySelector('#blobspace-warning')).whiteSpace, 'normal')

client.close()

const persisted = new Map([
  ['rfe-static-config-v2', JSON.stringify({
    activePreset: 'sepolia',
    networks: {
      sepolia: {
        chainPreset: 'sepolia',
        streamId: 'offline-test',
        stationAddress: '0x060c51d481808b506dfae72f054f39e11e4f4017',
        fromBlock: '1',
        executionRpcs: [],
        beaconApis: [],
        archiveTemplates: [],
        cacheLimitMb: 512,
      },
    },
  })],
  ['rfe-static-layout-settings-v1', JSON.stringify({
    bottomSpan: 'between',
    player: { visible: false, position: 'main', order: 1 },
    feeds: { visible: true, position: 'right', order: 1 },
    archive: { visible: true, position: 'bottom', order: 1 },
    blobFees: { visible: false, position: 'bottom', order: 2 },
  })],
  ['rfe-static-favorites-v2', JSON.stringify([
    { type: 'station', chainId: '11155111', stationAddress: '0x060c51d481808b506dfae72f054f39e11e4f4017', label: 'Shared station' },
    { type: 'station', chainId: '11155111', stationAddress: '0x160c51d481808b506dfae72f054f39e11e4f4017', label: 'Shared station' },
  ])],
])
const localStorage = {
  getItem: (key) => persisted.get(key) ?? null,
  setItem: (key, value) => persisted.set(key, String(value)),
  removeItem: (key) => persisted.delete(key),
}
const blockedClient = await loadStaticClientProduction({ url: 'http://127.0.0.1/', localStorage })
const blockedWindow = blockedClient.window
assert.equal(blockedClient.requestedUrls.length, 0)
assert.equal(blockedWindow.document.querySelector('.panel-player')?.hidden, true)
assert.equal(blockedWindow.document.querySelector('#layout-recovery')?.hidden, false, 'persisted hidden Player state must retain Settings access after reload')
assert.equal(blockedWindow.document.querySelector('#stream-health')?.textContent, 'endpoint-blocked')
assert.equal(blockedWindow.document.querySelector('#empty-state strong')?.textContent, 'Connection setup needed')
assert.match(blockedWindow.document.querySelector('#empty-state span')?.textContent || '', /network endpoints/)
assert.equal(blockedWindow.document.querySelector('#empty-recovery')?.hidden, false)
blockedWindow.document.querySelector('#empty-recovery')?.click()
assert.equal(blockedWindow.document.activeElement?.id, 'settings-tab-connections')
assert.deepEqual(
  [...blockedWindow.document.querySelectorAll('[data-favorite-action="tune"]')].map((button) => button.getAttribute('aria-label')),
  [
    'Watch Shared station; station 0x060c51d481808b506dfae72f054f39e11e4f4017, chain 11155111',
    'Watch Shared station; station 0x160c51d481808b506dfae72f054f39e11e4f4017, chain 11155111',
  ],
)
for (const action of ['tune', 'rename', 'remove']) {
  const labels = [...blockedWindow.document.querySelectorAll(`[data-favorite-action="${action}"]`)].map((button) => button.getAttribute('aria-label'))
  assert.equal(new Set(labels).size, 2, `same-label ${action} controls should identify their target favorite`)
}
const favoriteRegions = [...blockedWindow.document.querySelectorAll('.favorite-row')].map((region) => region.getAttribute('aria-label'))
assert.equal(new Set(favoriteRegions).size, 2, 'same-label favorite regions should expose distinct stable identities')
assert.deepEqual(
  [...blockedWindow.document.querySelectorAll('.favorite-row > div > span')].map((element) => element.textContent.split(' · ')[0]),
  ['Sepolia', 'Sepolia'],
  'favorite rows must expose chain identity visibly as well as in accessible names',
)
assert.match(productionApp, /data-archive-action="tune" aria-label="\$\{tuned \? 'View segments for' : 'Watch'\} \$\{escapeHtml\(accessibleName\)\}"/)
assert.match(productionApp, /data-archive-action="save" aria-label="Save \$\{escapeHtml\(accessibleName\)\}"/)
blockedClient.close()

const missingStationClient = await loadStaticClientProduction({ url: 'http://127.0.0.1/?network=mainnet' })
assert.equal(missingStationClient.window.document.querySelector('#stream-health')?.textContent, 'station-missing')
assert.equal(missingStationClient.window.document.querySelector('#empty-state strong')?.textContent, 'Choose a station')
assert.equal(missingStationClient.window.document.querySelector('#empty-recovery')?.hidden, false)
missingStationClient.close()
console.log('static client production smoke ok')
