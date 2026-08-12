import fs from 'node:fs'

export function readDirectoryBoundedSync(directory, {
  maxEntries = 50_000,
  label = `directory ${directory}`,
} = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive safe integer')
  const handle = fs.opendirSync(directory)
  const entries = []
  try {
    while (entries.length < maxEntries) {
      const entry = handle.readSync()
      if (!entry) return { entries: entries.map((item) => item.name), complete: true }
      entries.push(entry)
    }
    if (handle.readSync()) {
      throw new Error(`${label} exceeds the ${maxEntries}-entry safety limit`)
    }
    return { entries: entries.map((item) => item.name), complete: true }
  } finally {
    handle.closeSync()
  }
}

export function createDirectoryCursor(directory, {
  maxEntriesPerBatch = 256,
} = {}) {
  if (!Number.isSafeInteger(maxEntriesPerBatch) || maxEntriesPerBatch < 1) {
    throw new Error('maxEntriesPerBatch must be a positive safe integer')
  }
  let handle = null

  function close() {
    if (!handle) return
    try { handle.closeSync() } catch { /* Directory replacement invalidates the cursor. */ }
    handle = null
  }

  function next() {
    if (!handle) handle = fs.opendirSync(directory)
    const entries = []
    while (entries.length < maxEntriesPerBatch) {
      const entry = handle.readSync()
      if (!entry) {
        close()
        return { entries, complete: true }
      }
      entries.push(entry)
    }
    return { entries, complete: false }
  }

  return { next, close }
}
