export function missingBlobVersionedHashes(wanted, matches) {
  if (!(wanted instanceof Set) || !wanted.size) {
    throw new Error('Expected at least one requested blob versioned hash')
  }
  if (!Array.isArray(matches)) throw new Error('Blob sidecar matches must be an array')
  const matched = new Set(matches.map((match) => String(match?.versionedHash || '').toLowerCase()))
  return [...wanted]
    .map((hash) => String(hash).toLowerCase())
    .filter((hash) => !matched.has(hash))
}

export function assertCompleteBlobSidecarMatches(wanted, matches) {
  const missing = missingBlobVersionedHashes(wanted, matches)
  if (missing.length) {
    throw new Error(`Beacon response is missing ${missing.length} requested blob sidecar(s): ${missing.join(', ')}`)
  }
}
