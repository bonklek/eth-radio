function normalizedAuthority(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text || /[\s\\/]/.test(text)) return ''
  return text
}

export function loopbackAuthorities(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Loopback port must be valid')
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`])
}

function originAuthority(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return normalizedAuthority(url.host)
  } catch {
    return ''
  }
}

/**
 * Reject browser cross-site and DNS-rebinding requests before route handlers can
 * perform RPC work or mutate local caches.
 */
export function checkLoopbackRequest(request, { port, authorities = loopbackAuthorities(port) }) {
  const method = String(request?.method || '').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return { ok: false, status: 405, message: 'Method not allowed\n', headers: { allow: 'GET, HEAD' } }
  }

  const host = normalizedAuthority(request?.headers?.host)
  if (!authorities.has(host)) return { ok: false, status: 403, message: 'Forbidden host\n' }

  const fetchSite = String(request?.headers?.['sec-fetch-site'] || '').trim().toLowerCase()
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    return { ok: false, status: 403, message: 'Cross-site request denied\n' }
  }

  const origin = request?.headers?.origin
  if (origin != null && !authorities.has(originAuthority(origin))) {
    return { ok: false, status: 403, message: 'Cross-origin request denied\n' }
  }

  return { ok: true }
}
