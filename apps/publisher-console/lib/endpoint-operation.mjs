export const MAX_EXECUTION_ENDPOINTS = 4
export const DEFAULT_ENDPOINT_OPERATION_DEADLINE_MS = 8_000
export const DEFAULT_ENDPOINT_CONCURRENCY = 2

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`)
  return value
}

function abortError(reason = 'endpoint operation aborted') {
  const error = new Error(reason)
  error.name = 'AbortError'
  return error
}

function awaitWithSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(String(signal.reason || 'endpoint operation aborted')))
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(String(signal.reason || 'endpoint operation aborted')))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function firstSuccessfulEndpoint(endpoints, action, {
  deadlineMs = DEFAULT_ENDPOINT_OPERATION_DEADLINE_MS,
  concurrency = DEFAULT_ENDPOINT_CONCURRENCY,
} = {}) {
  if (!Array.isArray(endpoints) || !endpoints.length) throw new Error('endpoint operation requires at least one endpoint')
  if (endpoints.length > MAX_EXECUTION_ENDPOINTS) throw new Error(`endpoint operation exceeds maximum ${MAX_EXECUTION_ENDPOINTS}`)
  if (typeof action !== 'function') throw new Error('endpoint action must be a function')
  positiveInteger(deadlineMs, 'endpoint operation deadline')
  positiveInteger(concurrency, 'endpoint operation concurrency')

  const controller = new AbortController()
  let cursor = 0
  let settled = false
  let failures = 0
  const errors = []

  return new Promise((resolve, reject) => {
    const finishFailure = () => {
      if (settled || failures !== endpoints.length) return
      settled = true
      clearTimeout(timer)
      controller.abort('all endpoints failed')
      reject(new AggregateError(errors, 'No endpoint completed the operation'))
    }
    const runNext = async () => {
      const index = cursor
      cursor += 1
      if (settled || index >= endpoints.length) return
      try {
        const value = await awaitWithSignal(action(endpoints[index], {
          signal: controller.signal,
          endpointIndex: index,
        }), controller.signal)
        if (settled) return
        settled = true
        clearTimeout(timer)
        controller.abort('another endpoint completed the operation')
        resolve(value)
      } catch (error) {
        if (settled) return
        errors[index] = error
        failures += 1
        if (cursor < endpoints.length) runNext()
        finishFailure()
      }
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      controller.abort(`endpoint operation exceeded ${deadlineMs}ms deadline`)
      reject(new Error(`Endpoint operation exceeded ${deadlineMs}ms aggregate deadline`))
    }, deadlineMs)
    timer.unref?.()
    for (let index = 0; index < Math.min(concurrency, endpoints.length); index += 1) runNext()
  })
}

export async function settleEndpointOperation(endpoints, action, {
  deadlineMs = DEFAULT_ENDPOINT_OPERATION_DEADLINE_MS,
  concurrency = DEFAULT_ENDPOINT_CONCURRENCY,
} = {}) {
  if (!Array.isArray(endpoints) || !endpoints.length) throw new Error('endpoint operation requires at least one endpoint')
  if (endpoints.length > MAX_EXECUTION_ENDPOINTS) throw new Error(`endpoint operation exceeds maximum ${MAX_EXECUTION_ENDPOINTS}`)
  if (typeof action !== 'function') throw new Error('endpoint action must be a function')
  positiveInteger(deadlineMs, 'endpoint operation deadline')
  positiveInteger(concurrency, 'endpoint operation concurrency')

  const controller = new AbortController()
  const results = Array(endpoints.length)
  let cursor = 0
  let deadlineExceeded = false
  const workers = Array.from({ length: Math.min(concurrency, endpoints.length) }, async () => {
    while (!controller.signal.aborted) {
      const index = cursor
      cursor += 1
      if (index >= endpoints.length) return
      try {
        const value = await awaitWithSignal(action(endpoints[index], {
          signal: controller.signal,
          endpointIndex: index,
        }), controller.signal)
        results[index] = { status: 'fulfilled', value }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  })
  let wakeDeadline
  const deadline = new Promise((resolve) => { wakeDeadline = resolve })
  const timer = setTimeout(() => {
    deadlineExceeded = true
    controller.abort(`endpoint operation exceeded ${deadlineMs}ms deadline`)
    wakeDeadline()
  }, deadlineMs)
  timer.unref?.()
  await Promise.race([Promise.all(workers), deadline])
  clearTimeout(timer)
  if (deadlineExceeded) await Promise.all(workers)
  for (let index = 0; index < results.length; index += 1) {
    results[index] ||= { status: 'rejected', reason: abortError(`endpoint operation exceeded ${deadlineMs}ms deadline`) }
  }
  return { results, deadlineExceeded }
}
