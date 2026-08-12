export const CHILD_GRACE_MS = 12_000
export const CHILD_FORCE_WAIT_MS = 2_000

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntilEmpty(children, timeoutMs, sleep = delay) {
  const deadline = Date.now() + timeoutMs
  while (Object.values(children).some(Boolean) && Date.now() < deadline) await sleep(Math.min(50, Math.max(1, deadline - Date.now())))
  return !Object.values(children).some(Boolean)
}

export async function coordinateChildShutdown(children, {
  graceMs = CHILD_GRACE_MS,
  forceWaitMs = CHILD_FORCE_WAIT_MS,
  sleep = delay,
} = {}) {
  for (const child of Object.values(children).filter(Boolean)) {
    try { child.kill('SIGTERM') } catch { /* Exit observation remains authoritative. */ }
  }
  if (await waitUntilEmpty(children, graceMs, sleep)) return { clean: true, escalated: false, ambiguous: [] }
  for (const child of Object.values(children).filter(Boolean)) {
    try { child.kill('SIGKILL') } catch { /* Exit observation remains authoritative. */ }
  }
  if (await waitUntilEmpty(children, forceWaitMs, sleep)) return { clean: true, escalated: true, ambiguous: [] }
  return {
    clean: false,
    escalated: true,
    ambiguous: Object.entries(children)
      .filter(([, child]) => Boolean(child))
      .map(([role, child]) => ({ role, pid: Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null })),
  }
}
