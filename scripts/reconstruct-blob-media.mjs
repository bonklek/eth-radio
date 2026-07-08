import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { hexToBytes } from 'viem'

function usage() {
  console.error(`Usage:
  pnpm blob:reconstruct -- --manifest <manifest.json> --sidecars <sidecars.json> [--out <file.webm>]
`)
  process.exit(1)
}

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return process.argv[idx + 1]
}

const manifestPath = arg('manifest')
const sidecarsPath = arg('sidecars')
if (!manifestPath || !sidecarsPath) usage()

const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestPath), 'utf8'))
const sidecars = JSON.parse(fs.readFileSync(path.resolve(sidecarsPath), 'utf8'))

const byHash = new Map()
for (const match of sidecars.matches || []) {
  if (match.versionedHash && match.blob) byHash.set(match.versionedHash, match.blob)
}

const blobs = []
for (const hash of manifest.blobVersionedHashes || []) {
  const blob = byHash.get(hash)
  if (!blob) throw new Error(`Missing sidecar for blob versioned hash ${hash}`)
  blobs.push(blob)
}

if (blobs.length !== manifest.blobCount) {
  throw new Error(`Expected ${manifest.blobCount} blob(s), found ${blobs.length}`)
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

const payload = Buffer.concat(chunks, decodedLength).subarray(0, manifest.payloadBytes)
const sha256 = crypto.createHash('sha256').update(payload).digest('hex')

if (sha256 !== manifest.payloadSha256) {
  throw new Error(`SHA-256 mismatch: expected ${manifest.payloadSha256}, got ${sha256}`)
}

const out = path.resolve(
  arg(
    'out',
    `work/blob-radio-testnet/reconstructed/${manifest.streamId.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${manifest.sequence}.webm`,
  ),
)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, payload)

console.log(`decoded bytes: ${decodedLength}`)
console.log(`payload bytes: ${payload.length}`)
console.log(`sha256: ${sha256}`)
console.log(`out: ${out}`)
