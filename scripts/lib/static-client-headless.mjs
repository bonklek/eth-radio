import fs from 'node:fs'
import { Window } from 'happy-dom'

export async function loadStaticClientProduction({
  url = 'http://127.0.0.1/?network=sepolia',
  localStorage = undefined,
  indexedDB = undefined,
  waitMs = 100,
  artifactPath = undefined,
} = {}) {
  const requestedUrls = []
  const window = new Window({ url })
  let bundledScript = ''
  const html = artifactPath
    ? (() => {
        const artifact = fs.readFileSync(artifactPath, 'utf8')
        const scripts = [...artifact.matchAll(/<script\s+type="module">([\s\S]*?)<\/script>/gi)]
        if (scripts.length !== 1) throw new Error('Static artifact must contain exactly one inline module script')
        bundledScript = scripts[0][1]
        return artifact.replace(scripts[0][0], '')
      })()
    : fs
        .readFileSync(new URL('../../public/decentralized/index.html', import.meta.url), 'utf8')
        .replace(/<script type="module" src="\.\/app\.js"><\/script>/, '')
  window.document.write(html)

  const boundWindowFunctions = new Set(['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
  for (const name of [
    'document',
    'navigator',
    'location',
    'history',
    'sessionStorage',
    'HTMLElement',
    'HTMLMediaElement',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'CustomEvent',
    'DOMException',
    'Blob',
    'URL',
    'TextDecoder',
    'TextEncoder',
    'AbortController',
    'AbortSignal',
    'performance',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]) {
    const value = window[name]
    if (value === undefined) continue
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: boundWindowFunctions.has(name) ? value.bind(window) : value,
    })
  }
  Object.defineProperties(globalThis, {
    window: { configurable: true, writable: true, value: window },
    localStorage: { configurable: true, writable: true, value: localStorage ?? window.localStorage },
    indexedDB: { configurable: true, writable: true, value: indexedDB ?? Reflect.get(window, 'indexedDB') },
  })

  Object.defineProperties(globalThis, {
    setInterval: { configurable: true, writable: true, value: () => 0 },
    clearInterval: { configurable: true, writable: true, value: () => {} },
  })
  globalThis.fetch = async (resource, options = {}) => {
    const requestUrl = String(resource)
    requestedUrls.push({ url: requestUrl, options })
    let body
    if (requestUrl.includes('/eth/v1/beacon/genesis')) body = { data: { genesis_time: '0' } }
    else if (requestUrl.includes('/eth/v1/beacon/headers/head')) body = { data: { header: { message: { slot: '10' } } } }
    else if (requestUrl.includes('/eth/v1/beacon/blob_sidecars/')) body = { data: [] }
    else body = { jsonrpc: '2.0', id: 'headless-test', result: '0x1' }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  if (bundledScript) {
    const encoded = Buffer.from(bundledScript).toString('base64')
    await import(`data:text/javascript;base64,${encoded}#artifact-test-${crypto.randomUUID()}`)
  } else {
    await import(`../../public/decentralized/app.js?production-test=${crypto.randomUUID()}`)
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  return {
    window,
    requestedUrls,
    close: () => window.happyDOM.abort(),
  }
}
