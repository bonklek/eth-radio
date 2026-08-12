import { numberArg } from './cli-args.mjs'
import { MAX_BLOBS_PER_SEGMENT } from './station-abi.mjs'

export const BLOB_DATA_BYTES = 126_976

export function blobCountForPayloadBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('payload bytes must be a non-negative safe integer')
  return value === 0 ? 0 : Math.ceil(value / BLOB_DATA_BYTES)
}

export function segmentMsArg(fallback, argv = process.argv) {
  return numberArg('segment-ms', fallback, { integer: true, min: 1, argv })
}

export function maxBlobsArg(fallback, argv = process.argv) {
  return numberArg('max-blobs', fallback, { integer: true, min: 1, max: MAX_BLOBS_PER_SEGMENT, argv })
}
