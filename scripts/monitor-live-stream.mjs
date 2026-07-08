import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return process.argv[idx + 1]
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

const streamId = arg('stream-id', process.env.STREAM_ID || 'rfe-baked-clock-pipe-v6')
const safeStreamId = sanitize(streamId)
const statePath = path.resolve(
  arg('state', `work/blob-radio-testnet/live-runs/${safeStreamId}/publish-state.json`),
)
const manifestPath = path.resolve(
  arg('manifest', `work/blob-radio-testnet/live-runs/${safeStreamId}/segments/${safeStreamId}.segments.json`),
)
const staleMs = Number(arg('stale-ms', '180000'))

if (!fs.existsSync(statePath)) throw new Error(`Publish state not found: ${statePath}`)

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const published = state.published || []
const latest = published.at(-1) || null
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null
const generated = manifest?.segments || []
const latestGenerated = generated.at(-1) || null
const latestAgeMs = latest?.includedAt ? Date.now() - Date.parse(latest.includedAt) : null
const generatedLag = latestGenerated && latest ? Number(latestGenerated.sequence) - Number(latest.sequence) : null
const ok = Boolean(latest) && (latestAgeMs == null || latestAgeMs <= staleMs)

const summary = {
  streamId,
  ok,
  publishedCount: published.length,
  nextSequence: state.nextSequence,
  latestSequence: latest?.sequence ?? null,
  latestTxHash: latest?.txHash ?? null,
  latestBlockNumber: latest?.blockNumber ?? null,
  latestPayloadBytes: latest?.payloadBytes ?? null,
  latestBlobCount: latest?.blobCount ?? null,
  latestIncludedAt: latest?.includedAt ?? null,
  latestAgeSeconds: latestAgeMs == null ? null : Math.round(latestAgeMs / 1000),
  latestGeneratedSequence: latestGenerated?.sequence ?? null,
  generatedLag,
  staleAfterSeconds: Math.round(staleMs / 1000),
}

console.log(JSON.stringify(summary, null, 2))
process.exit(ok ? 0 : 2)
