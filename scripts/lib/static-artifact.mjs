import crypto from 'node:crypto'
import vm from 'node:vm'

function matches(html, pattern) {
  return [...html.matchAll(pattern)]
}

function sha256Source(value) {
  const browserText = String(value).replace(/\r\n?/g, '\n')
  return `'sha256-${crypto.createHash('sha256').update(browserText).digest('base64')}'`
}

function requireMatch(html, pattern, label) {
  const match = html.match(pattern)
  if (!match) throw new Error(`Static artifact is missing ${label}`)
  return match
}

export function verifyStaticArtifactHtml(html, label = 'static artifact') {
  if (typeof html !== 'string' || !html.trim()) throw new Error(`${label} is empty`)
  if (!/^<!doctype html>/i.test(html.trimStart())) throw new Error(`${label} is not an HTML document`)

  const styles = matches(html, /<style>([\s\S]*?)<\/style>/gi)
  const scripts = matches(html, /<script\s+type="module">([\s\S]*?)<\/script>/gi)
  if (styles.length !== 1) throw new Error(`${label} must contain exactly one bundled style element`)
  if (scripts.length !== 1) throw new Error(`${label} must contain exactly one bundled module script`)
  if (/<link\b[^>]*\brel=["']stylesheet["']/i.test(html)) throw new Error(`${label} still references an external stylesheet`)
  if (/<script\b[^>]*\bsrc=/i.test(html)) throw new Error(`${label} still references an external script`)

  const csp = requireMatch(
    html,
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/>/i,
    'a portable Content Security Policy',
  )[1]
  requireMatch(html, /<meta\s+name="referrer"\s+content="no-referrer"\s*\/>/i, 'a no-referrer policy')
  requireMatch(html, /<section\s+id="startup-shell"[^>]*\brole="status"[^>]*>/i, 'a durable startup shell')
  requireMatch(html, /<main\s+id="app-shell"[^>]*\binert\b[^>]*\baria-hidden="true"[^>]*>/i, 'an initially inert application shell')
  requireMatch(html, /<noscript>[\s\S]*?Chain playback and verification are unavailable[\s\S]*?<\/noscript>/i, 'no-script recovery guidance')

  const requiredDirectives = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    'connect-src https: http:',
    "media-src 'self' blob:",
    "worker-src 'none'",
  ]
  for (const directive of requiredDirectives) {
    if (!csp.includes(directive)) throw new Error(`${label} CSP is missing: ${directive}`)
  }
  if (csp.includes("'unsafe-inline'") || csp.includes("'unsafe-eval'")) {
    throw new Error(`${label} CSP permits unsafe inline/eval execution`)
  }

  const styleHash = sha256Source(styles[0][1])
  const scriptHash = sha256Source(scripts[0][1])
  if (!csp.includes(`style-src ${styleHash}`)) throw new Error(`${label} CSP style hash does not match bundled CSS`)
  if (!csp.includes(`script-src ${scriptHash}`)) throw new Error(`${label} CSP script hash does not match bundled JavaScript`)

  for (const forbidden of ['./styles.css', './app.js', '__STYLE_CSP__', '__SCRIPT_CSP__']) {
    if (html.includes(forbidden)) throw new Error(`${label} contains forbidden build residue: ${forbidden}`)
  }

  try {
    new vm.Script(scripts[0][1], { filename: `${label}:inline-module.js` })
  } catch (error) {
    throw new Error(`${label} bundled JavaScript does not parse: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  return {
    bytes: Buffer.byteLength(html),
    styleHash,
    scriptHash,
  }
}
