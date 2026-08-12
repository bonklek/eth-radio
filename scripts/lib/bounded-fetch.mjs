const DEFAULT_ERROR_BODY_BYTES = 16 * 1024

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`)
  return value
}

export async function readBoundedResponseBytes(response, { maxBytes, label = 'HTTP response' }) {
  const maximum = positiveSafeInteger(maxBytes, 'maximum response bytes')
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(maximum)) {
    throw new Error(`${label} exceeds ${maximum} bytes`)
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const output = Buffer.allocUnsafe(maximum)
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength === 0) continue
      bytes += value.byteLength
      if (bytes > maximum) {
        await reader.cancel().catch(() => {})
        throw new Error(`${label} exceeds ${maximum} bytes`)
      }
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(output, bytes - value.byteLength)
    }
  } finally {
    reader.releaseLock()
  }
  return output.subarray(0, bytes)
}

export async function readBoundedJsonResponse(response, { maxBytes, label = 'HTTP response' }) {
  if (!response.ok) {
    let detail = 'response body omitted'
    try {
      await readBoundedResponseBytes(response, {
        maxBytes: Math.min(maxBytes, DEFAULT_ERROR_BODY_BYTES),
        label: `${label} error body`,
      })
    } catch (error) {
      detail = error.message
    }
    throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`)
  }
  const bytes = await readBoundedResponseBytes(response, { maxBytes, label })
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

/**
 * @param {string | URL} url
 * @param {{ maxBytes: number, timeoutMs?: number, label?: string, headers?: HeadersInit, fetchImpl?: typeof fetch }} options
 */
export async function fetchBoundedJson(url, {
  maxBytes,
  timeoutMs = 10_000,
  label = 'HTTP response',
  headers = { accept: 'application/json' },
  fetchImpl = fetch,
}) {
  positiveSafeInteger(maxBytes, 'maximum response bytes')
  positiveSafeInteger(timeoutMs, 'fetch timeout milliseconds')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal })
    return await readBoundedJsonResponse(response, { maxBytes, label })
  } finally {
    clearTimeout(timeout)
  }
}
