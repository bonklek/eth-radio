import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { hexToBytes } from 'viem'
import { readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import { scopedStreamFilesystemIdentity } from './lib/filesystem-identity.mjs'
import { readBoundedFileSync, readBoundedJsonFileSync } from './lib/bounded-files.mjs'

const MAX_RECONSTRUCTION_MANIFEST_BYTES = 1024 * 1024
const MAX_RECONSTRUCTION_SIDECARS_BYTES = 16 * 1024 * 1024

function usage(exitCode = 1) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  pnpm blob:reconstruct -- --manifest <manifest.json> --sidecars <sidecars.json> [--out <file.webm>]
`)
  process.exit(exitCode)
}

if (helpRequested()) usage(0)
const manifestPath = readArg('manifest')
const sidecarsPath = readArg('sidecars')
if (!manifestPath || !sidecarsPath) usage()

const resolvedManifestPath = path.resolve(manifestPath)
const resolvedSidecarsPath = path.resolve(sidecarsPath)
const manifest = readBoundedJsonFileSync(resolvedManifestPath, {
  maxBytes: MAX_RECONSTRUCTION_MANIFEST_BYTES,
  label: `reconstruction manifest ${resolvedManifestPath}`,
})
const sidecars = readBoundedJsonFileSync(resolvedSidecarsPath, {
  maxBytes: MAX_RECONSTRUCTION_SIDECARS_BYTES,
  label: `reconstruction sidecars ${resolvedSidecarsPath}`,
})

function assertBytes32Hex(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(value || ''))) throw new Error(`Invalid ${label}: ${value}`)
}

function assertBlobHex(value, label) {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(String(value || ''))) throw new Error(`Invalid ${label}: expected 0x-prefixed byte hex`)
}

function isNonNegativeInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.isSafeInteger(Number(value))
  return false
}

function assertManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Manifest must be a JSON object')
  if (typeof manifest.streamId !== 'string' || !manifest.streamId.trim()) throw new Error('Manifest streamId is required')
  if (!isNonNegativeInteger(manifest.sequence)) {
    throw new Error(`Invalid manifest sequence: ${manifest.sequence}`)
  }
  if (!isNonNegativeInteger(manifest.payloadBytes)) {
    throw new Error(`Invalid manifest payloadBytes: ${manifest.payloadBytes}`)
  }
  if (!isNonNegativeInteger(manifest.blobCount)) {
    throw new Error(`Invalid manifest blobCount: ${manifest.blobCount}`)
  }
  if (!/^[0-9a-fA-F]{64}$/.test(String(manifest.payloadSha256 || ''))) {
    throw new Error(`Invalid manifest payloadSha256: ${manifest.payloadSha256}`)
  }
  if (!Array.isArray(manifest.blobVersionedHashes)) throw new Error('Manifest blobVersionedHashes must be an array')
  for (const hash of manifest.blobVersionedHashes) assertBytes32Hex(hash, 'manifest blob versioned hash')
}

function assertSidecars(sidecars) {
  if (!sidecars || typeof sidecars !== 'object' || Array.isArray(sidecars)) {
    throw new Error('Sidecars must be a JSON object')
  }
  if (!Array.isArray(sidecars.matches)) throw new Error('Sidecars matches must be an array')
  for (const [index, match] of sidecars.matches.entries()) {
    if (!match || typeof match !== 'object' || Array.isArray(match)) {
      throw new Error(`Invalid sidecar match at index ${index}: expected an object`)
    }
    assertBytes32Hex(match.versionedHash, `sidecar match ${index} versionedHash`)
    assertBlobHex(match.blob, `sidecar match ${index} blob`)
  }
}

assertManifest(manifest)
assertSidecars(sidecars)
const sequence = Number(manifest.sequence)
const payloadBytes = Number(manifest.payloadBytes)
const blobCount = Number(manifest.blobCount)

const byHash = new Map()
for (const match of sidecars.matches) {
  byHash.set(match.versionedHash.toLowerCase(), match.blob)
}

const blobs = []
for (const hash of manifest.blobVersionedHashes) {
  const blob = byHash.get(hash.toLowerCase())
  if (!blob) throw new Error(`Missing sidecar for blob versioned hash ${hash}`)
  blobs.push(blob)
}

if (blobs.length !== blobCount) {
  throw new Error(`Expected ${blobCount} blob(s), found ${blobs.length}`)
}

const chunks = []
let decodedLength = 0
for (const blob of blobs) {
  const bytes = hexToBytes(blob)
  for (let offset = 0; offset < bytes.length; offset += 32) {
    const fieldElement = bytes.subarray(offset, offset + 32)
    if (fieldElement.length === 0) continue
    if (fieldElement[0] !== 0) {
      throw new Error(`Invalid blob encoding at byte offset ${offset}: field element prefix is not zero`)
    }
    const data = fieldElement.subarray(1)
    chunks.push(data)
    decodedLength += data.length
  }
}

if (decodedLength < payloadBytes) {
  throw new Error(`Decoded blob payload is truncated: expected ${payloadBytes} bytes, found ${decodedLength}`)
}
const payload = Buffer.concat(chunks, decodedLength).subarray(0, payloadBytes)
const sha256 = crypto.createHash('sha256').update(payload).digest('hex')

if (sha256 !== manifest.payloadSha256) {
  throw new Error(`SHA-256 mismatch: expected ${manifest.payloadSha256}, got ${sha256}`)
}

const reconstructionIdentity = scopedStreamFilesystemIdentity({
  chain: manifest.chain,
  station: manifest.stationAddress || manifest.station,
  publisher: manifest.publisher,
  streamId: manifest.streamId,
})
const out = path.resolve(
  readArg(
    'out',
    `work/blob-radio-testnet/reconstructed/${reconstructionIdentity.key}-${sequence}-${manifest.payloadSha256}.webm`,
  ),
)
fs.mkdirSync(path.dirname(out), { recursive: true })
if (fs.existsSync(out)) {
  let existing
  try {
    existing = readBoundedFileSync(out, {
      maxBytes: Math.max(payloadBytes, 1),
      label: `existing reconstructed output ${out}`,
    })
  } catch (error) {
    throw new Error(`Refusing to reuse reconstructed output with mismatched SHA-256: ${out}`, { cause: error })
  }
  const existingHash = crypto.createHash('sha256').update(existing).digest('hex')
  if (existingHash !== sha256) throw new Error(`Refusing to reuse reconstructed output with mismatched SHA-256: ${out}`)
  console.log(`verified existing output: ${out}`)
} else {
  fs.writeFileSync(out, payload)
}

console.log(`decoded bytes: ${decodedLength}`)
console.log(`payload bytes: ${payload.length}`)
console.log(`sha256: ${sha256}`)
console.log(`out: ${out}`)
