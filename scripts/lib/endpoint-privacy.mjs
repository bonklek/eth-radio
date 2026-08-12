import fs from 'node:fs'

const httpUrlPattern = /https?:\/\/[^\s"'<>)}\]]+/gi
const MAX_DIAGNOSTIC_CHARS = 4096

function unsafeTerminalCharacter(character) {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint <= 0x08
    || codePoint === 0x0b
    || codePoint === 0x0c
    || (codePoint >= 0x0e && codePoint <= 0x1f)
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || codePoint === 0x061c
    || codePoint === 0x200e
    || codePoint === 0x200f
    || codePoint === 0x2028
    || codePoint === 0x2029
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069)
}

export function printableSingleLineDiagnostic(value, fallback = 'Request failed') {
  const normalized = String(value ?? '')
    .replaceAll('\r\n', ' ')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\t', ' ')
  const escaped = Array.from(normalized, (character) => unsafeTerminalCharacter(character)
    ? `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`
    : character).join('')
  const collapsed = escaped
    .replace(/ +/g, ' ')
    .trim()
  const bounded = collapsed.slice(0, MAX_DIAGNOSTIC_CHARS)
  return bounded || fallback
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function endpointComponents(value) {
  try {
    const url = new URL(String(value || ''))
    const components = [
      String(value || ''),
      url.hostname,
      safeDecode(url.username || ''),
      safeDecode(url.password || ''),
      ...url.pathname.split('/').filter((part) => part.length >= 8).flatMap((part) => [part, safeDecode(part)]),
      ...[...url.searchParams.values()].flatMap((part) => [part, safeDecode(part)]),
    ]
    return [...new Set(components.filter((part) => part.length >= 4))]
      .sort((left, right) => right.length - left.length)
  } catch {
    return [String(value || '')].filter((part) => part.length >= 4)
  }
}

export function credentialSafeEndpointLabel(value, label = 'endpoint') {
  try {
    const protocol = new URL(String(value || '')).protocol.replace(/:$/, '').toLowerCase()
    return protocol === 'http' || protocol === 'https' ? `${label} (${protocol})` : label
  } catch {
    return label
  }
}

export function redactEndpointSecrets(value, endpoints = []) {
  let text = String(value ?? '')
  for (const endpoint of endpoints) {
    for (const component of endpointComponents(endpoint)) {
      text = text.split(component).join('[redacted endpoint]')
    }
  }
  return text.replace(httpUrlPattern, '[redacted endpoint]')
}

export function endpointSafeErrorMessage(error, endpoints = []) {
  const seen = new Set()
  let current = error
  let details = ''
  while (current && !seen.has(current)) {
    seen.add(current)
    details = current?.shortMessage || current?.details || current?.message || ''
    if (details) break
    current = current?.cause
  }
  details ||= String(error || 'Request failed')
  return printableSingleLineDiagnostic(redactEndpointSecrets(details, endpoints))
}

export function installEndpointSafeProcessHandlers(endpointProvider) {
  const report = (error) => {
    let endpoints = []
    try {
      endpoints = typeof endpointProvider === 'function' ? endpointProvider() : endpointProvider
    } catch (providerError) {
      void providerError
    }
    let message = 'Request failed'
    try {
      message = endpointSafeErrorMessage(error, Array.isArray(endpoints) ? endpoints : [])
    } catch (formatError) {
      void formatError
    }
    try {
      fs.writeSync(process.stderr.fd, `${message}\n`)
    } catch (writeError) {
      void writeError
    }
    process.exit(1)
  }
  process.once('uncaughtException', report)
  process.once('unhandledRejection', report)
}
