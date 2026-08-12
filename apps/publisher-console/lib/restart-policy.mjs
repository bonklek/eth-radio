export const PUBLISHER_RESTART_WINDOW_MS = 10 * 60 * 1000
export const PUBLISHER_STABLE_RUN_MS = 5 * 60 * 1000
export const PUBLISHER_MAX_RESTARTS = 5

function timestamp(value, label) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`)
  return parsed
}

export function publisherRestartDecision({ history = [], cause, exitedAt, runtimeMs }) {
  const now = timestamp(exitedAt, 'publisher exit time')
  if (!Number.isSafeInteger(runtimeMs) || runtimeMs < 0) throw new Error('publisher runtime must be a non-negative safe integer')
  const normalizedCause = String(cause || '').slice(0, 128)
  if (!normalizedCause) throw new Error('publisher exit cause is required')
  const retained = runtimeMs >= PUBLISHER_STABLE_RUN_MS
    ? []
    : history.filter((entry) => {
      const at = timestamp(entry.at, 'publisher restart history time')
      return at <= now && now - at <= PUBLISHER_RESTART_WINDOW_MS
    })
  retained.push({ cause: normalizedCause, at: new Date(now).toISOString() })
  const circuitOpen = retained.length >= PUBLISHER_MAX_RESTARTS
  return {
    history: retained,
    circuitOpen,
    delayMs: circuitOpen ? null : Math.min(30_000, 2_000 * 2 ** Math.min(retained.length - 1, 4)),
    reason: circuitOpen
      ? `Publisher restart circuit opened after ${retained.length} exits within 10 minutes; reconcile durable signer and transaction state before operator restart.`
      : null,
  }
}
