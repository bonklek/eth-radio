import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BLOB_BYTES,
  ensureVerifiedMediaCache,
  isExactBlobHex,
  loadOrFetchValidatedSidecarCache,
  mediaCacheFilename,
  openVerifiedMediaFile,
  readBoundedJsonResponse,
  validateBeaconSidecars,
} from './lib/live-demo-integrity.mjs'
import {
  ZERO_SEGMENT_HASH,
  annotateStreamContinuity,
  canonicalStreamIdHash,
  proofManifestMatchesChannel,
  segmentRouteUrls,
  selectPublisherScopedChannel,
} from './lib/stream-identity-continuity.mjs'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-live-demo-integrity-'))
const cachePath = path.join(tempDir, 'sidecars', `${'11'.repeat(32)}.json`)
const txHash = `0x${'11'.repeat(32)}`
const hashA = `0x${'22'.repeat(32)}`
const hashB = `0x${'33'.repeat(32)}`
const exactBlob = `0x${'00'.repeat(BLOB_BYTES)}`
const maxCacheBytes = 1024 * 1024

function cacheOptions(wantedHashes = [hashA], fetchPayload) {
  return {
    cachePath,
    txHash,
    wantedHashes,
    maxSidecars: 4,
    maxCacheBytes,
    fetchPayload,
  }
}

try {
  assert.equal(isExactBlobHex(exactBlob), true)
  assert.equal(isExactBlobHex(`${exactBlob}00`), false)
  assert.equal(isExactBlobHex(exactBlob.slice(0, -2)), false)

  let fetches = 0
  await assert.rejects(
    loadOrFetchValidatedSidecarCache(cacheOptions([hashA], async () => {
      fetches += 1
      return { txHash, slot: '7', matches: [] }
    })),
    /incomplete/,
  )
  assert.equal(fs.existsSync(cachePath), false, 'empty sidecar results must not be persisted')

  const complete = await loadOrFetchValidatedSidecarCache(cacheOptions([hashA], async () => {
    fetches += 1
    return {
      txHash,
      slot: '7',
      matches: [{ index: '0', versionedHash: hashA, blob: exactBlob }],
    }
  }))
  assert.equal(complete.matches.length, 1)
  assert.equal(fs.existsSync(cachePath), true, 'complete sidecar results should be persisted')

  const reused = await loadOrFetchValidatedSidecarCache(cacheOptions([hashA], async () => {
    throw new Error('complete cache should have been reused')
  }))
  assert.equal(reused.matches.length, 1)
  assert.equal(fetches, 2, 'an empty response should retry once the endpoint recovers')

  fs.rmSync(cachePath, { force: true })
  await assert.rejects(
    loadOrFetchValidatedSidecarCache(cacheOptions([hashA, hashB], async () => ({
      txHash,
      slot: '8',
      matches: [{ index: 0, versionedHash: hashA, blob: exactBlob }],
    }))),
    /incomplete/,
  )
  assert.equal(fs.existsSync(cachePath), false, 'partial sidecar results must not be persisted')

  await assert.rejects(
    loadOrFetchValidatedSidecarCache(cacheOptions([hashA], async () => ({
      txHash,
      slot: '9',
      matches: [{ index: 0, versionedHash: hashA, blob: `${exactBlob}00` }],
    }))),
    new RegExp(`exactly ${BLOB_BYTES} bytes`),
  )
  assert.equal(fs.existsSync(cachePath), false, 'oversized blobs must reject before cache writes')

  assert.throws(
    () => validateBeaconSidecars([
      { index: 0, blob: exactBlob },
      { index: 1, blob: exactBlob },
    ], 1),
    /count .* exceeds protocol maximum/,
  )
  assert.throws(
    () => validateBeaconSidecars([{ index: 4, blob: exactBlob }], 4),
    /index 4 exceeds protocol maximum index 3/,
  )
  await assert.rejects(
    loadOrFetchValidatedSidecarCache({
      ...cacheOptions([hashA], async () => ({
        txHash,
        slot: '10',
        matches: [
          { index: 0, versionedHash: hashA, blob: exactBlob },
          { index: 1, versionedHash: hashB, blob: exactBlob },
        ],
      })),
      maxSidecars: 1,
    }),
    /count .* exceeds protocol maximum/,
  )
  assert.equal(fs.existsSync(cachePath), false, 'excess sidecars must reject before cache writes')
  await assert.rejects(
    loadOrFetchValidatedSidecarCache(cacheOptions([hashA], async () => ({
      txHash,
      slot: '11',
      matches: [{ index: 4, versionedHash: hashA, blob: exactBlob }],
    }))),
    /index 4 exceeds protocol maximum index 3/,
  )
  assert.equal(fs.existsSync(cachePath), false, 'out-of-range sidecar indices must reject before cache writes')

  await assert.rejects(
    readBoundedJsonResponse(new Response(JSON.stringify({ data: 'x'.repeat(128) })), {
      maxBytes: 32,
      label: 'test beacon response',
    }),
    /exceeds 32 bytes/,
  )
  assert.deepEqual(
    await readBoundedJsonResponse(new Response('{"data":[]}'), { maxBytes: 64, label: 'test beacon response' }),
    { data: [] },
  )

  const baseSegment = {
    chain: 'sepolia',
    station: `0x${'44'.repeat(20)}`,
    publisher: `0x${'55'.repeat(20)}`,
    streamId: 'a/b',
    sequence: 3,
    payloadSha256Hex: `0x${'66'.repeat(32)}`,
    txHash,
    blobVersionedHashes: [hashA],
  }
  const collidingDisplayId = { ...baseSegment, streamId: 'a?b' }
  const otherChain = { ...baseSegment, chain: 'mainnet' }
  const otherPublisher = { ...baseSegment, publisher: `0x${'77'.repeat(20)}` }
  const filenames = [baseSegment, collidingDisplayId, otherChain, otherPublisher].map((segment) => mediaCacheFilename(segment))
  assert.equal(new Set(filenames).size, filenames.length, 'all security-relevant media identities must produce distinct paths')
  assert.match(filenames[0], /^a_b-3-[0-9a-f]{64}\.webm$/)
  assert.match(filenames[1], /^a_b-3-[0-9a-f]{64}\.webm$/)
  assert.equal(
    proofManifestMatchesChannel({ streamId: 'a?b' }, { streamId: 'a/b' }),
    false,
    'an unmarked legacy proof path collision must not attach a different raw streamId',
  )
  assert.equal(proofManifestMatchesChannel({ streamId: 'a/b' }, { streamId: 'a/b' }), true)

  const collisionSelection = selectPublisherScopedChannel([baseSegment, otherPublisher], { streamId: baseSegment.streamId })
  assert.equal(collisionSelection.status, 'ambiguous', 'omitting publisher must reject a multi-publisher streamId')
  assert.deepEqual(collisionSelection.publishers, [baseSegment.publisher, otherPublisher.publisher].sort())
  const targetedSelection = selectPublisherScopedChannel([baseSegment, otherPublisher], {
    streamId: baseSegment.streamId,
    publisher: otherPublisher.publisher.toUpperCase().replace('0X', '0x'),
  })
  assert.equal(targetedSelection.status, 'selected')
  assert.equal(targetedSelection.publisher, otherPublisher.publisher)
  assert.equal(targetedSelection.segments.length, 1)
  assert.equal(targetedSelection.segments[0].txHash, otherPublisher.txHash)
  const uniqueSelection = selectPublisherScopedChannel([baseSegment], { streamId: baseSegment.streamId })
  assert.equal(uniqueSelection.status, 'selected', 'omitted publisher may select an unambiguous streamId')
  assert.equal(uniqueSelection.publisher, baseSegment.publisher)

  const unattributedProofCopy = { ...baseSegment, publisher: undefined, source: 'proof-manifest' }
  const reconciledProofSelection = selectPublisherScopedChannel([baseSegment, unattributedProofCopy], {
    streamId: baseSegment.streamId,
  })
  assert.equal(reconciledProofSelection.status, 'selected', 'an unattributed proof copy must not create false ambiguity')
  assert.equal(reconciledProofSelection.publisher, baseSegment.publisher)
  assert.equal(reconciledProofSelection.segments.length, 1, 'the proof duplicate must not replace or duplicate its Station event')

  const baseRoutes = segmentRouteUrls(baseSegment)
  const publisherRoutes = segmentRouteUrls(otherPublisher)
  assert.notEqual(baseRoutes.gatewayUrl, publisherRoutes.gatewayUrl, 'publisher-scoped API routes must not collide')
  assert.notEqual(baseRoutes.mediaUrl, publisherRoutes.mediaUrl, 'publisher-scoped media routes must not collide')
  assert.match(baseRoutes.gatewayUrl, new RegExp(`publisher=${baseSegment.publisher}`))
  assert.match(publisherRoutes.mediaUrl, new RegExp(`publisher=${otherPublisher.publisher}`))
  assert.equal(canonicalStreamIdHash(baseSegment.streamId), targetedSelection.segments[0].streamIdHash)

  const payloadA = `0x${'a1'.repeat(32)}`
  const payloadB = `0x${'b2'.repeat(32)}`
  const payloadC = `0x${'c3'.repeat(32)}`
  const payloadD = `0x${'d4'.repeat(32)}`
  const continuityBase = {
    publisher: baseSegment.publisher,
    streamId: 'continuity-test',
    txHash,
    blobVersionedHashes: [hashA],
  }
  const continuity = annotateStreamContinuity([
    { ...continuityBase, sequence: 0, payloadSha256Hex: payloadA, previousSegmentHash: ZERO_SEGMENT_HASH, payloadValidity: 'invalid' },
    { ...continuityBase, sequence: 1, payloadSha256Hex: payloadB, previousSegmentHash: payloadA, payloadValidity: 'valid' },
    { ...continuityBase, sequence: 2, payloadSha256Hex: payloadC, previousSegmentHash: `0x${'ee'.repeat(32)}`, payloadValidity: 'valid' },
    { ...continuityBase, sequence: 3, payloadSha256Hex: payloadD, previousSegmentHash: payloadC, payloadValidity: 'valid' },
  ])
  assert.deepEqual(continuity.map((segment) => segment.continuity.status), ['valid', 'valid', 'invalid', 'invalid'])
  assert.equal(continuity[0].continuity.reason, 'root')
  assert.equal(continuity[0].payloadValidity, 'invalid', 'payload validity must remain separate from continuity')
  assert.equal(continuity[1].continuity.reason, 'matching-predecessor')
  assert.equal(continuity[2].continuity.reason, 'predecessor-mismatch')
  assert.equal(continuity[2].quarantined, true)
  assert.equal(continuity[3].continuity.reason, 'invalid-ancestry')
  assert.equal(continuity[3].quarantined, true)

  const gapContinuity = annotateStreamContinuity([
    { ...continuityBase, publisher: otherPublisher.publisher, sequence: 5, payloadSha256Hex: payloadC, previousSegmentHash: payloadB },
    { ...continuityBase, publisher: otherPublisher.publisher, sequence: 6, payloadSha256Hex: payloadD, previousSegmentHash: payloadC },
  ])
  assert.deepEqual(gapContinuity.map((segment) => segment.continuity.status), ['unknown', 'unknown'])
  assert.equal(gapContinuity[0].continuity.reason, 'missing-predecessor')
  assert.equal(gapContinuity[1].continuity.reason, 'unknown-ancestry')
  assert.equal(gapContinuity.some((segment) => segment.quarantined), false, 'window gaps must not be quarantined as corruption')

  const missingLinkMetadata = annotateStreamContinuity([
    { ...continuityBase, publisher: otherPublisher.publisher, streamId: 'legacy-window', sequence: 0, payloadSha256Hex: payloadA },
    { ...continuityBase, publisher: otherPublisher.publisher, streamId: 'legacy-window', sequence: 1, payloadSha256Hex: payloadB },
  ])
  assert.deepEqual(missingLinkMetadata.map((segment) => segment.continuity.status), ['unknown', 'unknown'])
  assert.equal(missingLinkMetadata[0].continuity.reason, 'missing-link-metadata')
  assert.equal(missingLinkMetadata.some((segment) => segment.quarantined), false)

  assert.throws(
    () => selectPublisherScopedChannel([{ ...baseSegment, streamIdHash: `0x${'99'.repeat(32)}` }], { streamId: baseSegment.streamId }),
    /does not match streamId/,
    'claimed stream hashes must not override canonical stream identity',
  )

  const mediaPath = path.join(tempDir, 'media', filenames[0])
  const otherPublisherMediaPath = path.join(tempDir, 'media', filenames[3])
  assert.notEqual(mediaPath, otherPublisherMediaPath, 'publisher collision must remain separated on disk')
  const correctPayload = Buffer.from('verified local demo media')
  const expectedMedia = {
    payloadBytes: correctPayload.length,
    payloadSha256: `0x${crypto.createHash('sha256').update(correctPayload).digest('hex')}`,
  }
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
  await ensureVerifiedMediaCache(otherPublisherMediaPath, expectedMedia, async () => correctPayload)
  assert.deepEqual(fs.readFileSync(otherPublisherMediaPath), correctPayload)
  fs.writeFileSync(mediaPath, Buffer.alloc(correctPayload.length, 0x7f))
  let rebuilds = 0
  await ensureVerifiedMediaCache(mediaPath, expectedMedia, async () => {
    rebuilds += 1
    return correctPayload
  })
  assert.equal(rebuilds, 1, 'a corrupt existing media file must be deleted and rebuilt')
  assert.deepEqual(fs.readFileSync(mediaPath), correctPayload)
  assert.deepEqual(fs.readFileSync(otherPublisherMediaPath), correctPayload, 'rebuilding one publisher must not alter another cache file')

  await ensureVerifiedMediaCache(mediaPath, expectedMedia, async () => {
    rebuilds += 1
    throw new Error('verified media should have been reused')
  })
  assert.equal(rebuilds, 1, 'hash-valid media should be reused without refetching')

  const openedMedia = await openVerifiedMediaFile(mediaPath, expectedMedia)
  assert.deepEqual(await openedMedia.handle.readFile(), correctPayload, 'the verified descriptor must contain the expected media')
  await openedMedia.handle.close()

  const replacementPath = `${mediaPath}.replacement`
  fs.writeFileSync(replacementPath, Buffer.alloc(correctPayload.length, 0x45))
  await assert.rejects(
    openVerifiedMediaFile(mediaPath, expectedMedia, {
      beforeOpen() {
        fs.rmSync(mediaPath)
        fs.renameSync(replacementPath, mediaPath)
      },
    }),
    /changed while being opened/,
    'same-size pathname replacement must fail descriptor identity validation',
  )

  fs.writeFileSync(mediaPath, correctPayload)
  const oversizedPath = `${mediaPath}.oversized`
  fs.writeFileSync(oversizedPath, Buffer.alloc(correctPayload.length + 1, 0x46))
  await assert.rejects(
    openVerifiedMediaFile(mediaPath, expectedMedia, {
      beforeOpen() {
        fs.rmSync(mediaPath)
        fs.renameSync(oversizedPath, mediaPath)
      },
    }),
    /changed while being opened|size mismatch/,
    'an oversized replacement must fail before hashing or serving',
  )

  fs.writeFileSync(mediaPath, correctPayload)
  const junctionTarget = path.join(tempDir, 'junction-target')
  const junctionPath = path.join(tempDir, 'media-junction')
  fs.mkdirSync(junctionTarget)
  fs.writeFileSync(path.join(junctionTarget, 'media.webm'), correctPayload)
  fs.symlinkSync(junctionTarget, junctionPath, 'junction')
  await assert.rejects(
    openVerifiedMediaFile(path.join(junctionPath, 'media.webm'), expectedMedia, { root: tempDir }),
    /symbolic link or reparse point/,
    'junction/reparse traversal must fail closed',
  )

  const symlinkPath = `${mediaPath}.symlink`
  try {
    fs.symlinkSync(mediaPath, symlinkPath, 'file')
    await assert.rejects(
      openVerifiedMediaFile(symlinkPath, expectedMedia),
      /non-symlink/,
      'symbolic-link media paths must fail closed',
    )
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error
  } finally {
    fs.rmSync(symlinkPath, { force: true })
  }

  console.log('live demo integrity tests ok')
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
