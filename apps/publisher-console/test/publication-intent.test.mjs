import assert from 'node:assert/strict'
import { loadKZG } from 'kzg-wasm'
import { blobsToCommitments, bytesToHex, commitmentsToVersionedHashes, hexToBytes, toBlobs } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { publicationIntentFromPrepared, verifySignedPublicationIntent } from '../lib/publication-intent.mjs'

const account = privateKeyToAccount(`0x${'12'.repeat(32)}`)
const blobHash = `0x01${'34'.repeat(31)}`
const prepared = {
  chainId: 11155111,
  type: 'eip4844',
  to: '0x1111111111111111111111111111111111111111',
  nonce: 7,
  gas: 180000n,
  value: 0n,
  data: '0x1234',
  maxFeePerGas: 30n,
  maxPriorityFeePerGas: 2n,
  maxFeePerBlobGas: 20n,
  blobVersionedHashes: [blobHash],
}
const reservation = publicationIntentFromPrepared(prepared, {
  publisher: account.address,
  reservedExposureWei: 5_000_000n,
  payloadSha256: 'ab'.repeat(32),
  blobCount: 1,
})
const serializedTransaction = await account.signTransaction(prepared)
await verifySignedPublicationIntent(serializedTransaction, reservation)

for (const mutation of [
  { nonce: 8 },
  { to: '0x2222222222222222222222222222222222222222' },
  { data: '0x5678' },
  { maxFeePerGas: 31n },
  { maxFeePerBlobGas: 21n },
  { blobVersionedHashes: [`0x01${'56'.repeat(31)}`] },
]) {
  const hostile = await account.signTransaction({ ...prepared, ...mutation })
  await assert.rejects(() => verifySignedPublicationIntent(hostile, reservation), /do(?:es)? not match reserved intent/)
}

const otherAccount = privateKeyToAccount(`0x${'13'.repeat(32)}`)
const wrongSigner = await otherAccount.signTransaction(prepared)
await assert.rejects(() => verifySignedPublicationIntent(wrongSigner, reservation), /publisher does not match reserved intent/)
await assert.rejects(
  () => verifySignedPublicationIntent(serializedTransaction, { ...reservation, intentDigest: '00'.repeat(32) }),
  /intent digest does not match reserved intent/,
)

const wasmKzg = await loadKZG()
const kzg = {
  blobToKzgCommitment(blob) { return hexToBytes(wasmKzg.blobToKzgCommitment(bytesToHex(blob))) },
  computeBlobKzgProof(blob, commitment) { return hexToBytes(wasmKzg.computeBlobKZGProof(bytesToHex(blob), bytesToHex(commitment))) },
}
const blobs = toBlobs({ data: bytesToHex(Buffer.from('immutable intent sidecar fixture')) })
const blobVersionedHashes = commitmentsToVersionedHashes({
  commitments: blobsToCommitments({ blobs, kzg }),
})
const preparedWithSidecars = { ...prepared, blobs, kzg, blobVersionedHashes }
const sidecarReservation = publicationIntentFromPrepared(preparedWithSidecars, {
  publisher: account.address,
  reservedExposureWei: 5_000_000n,
  payloadSha256: 'cd'.repeat(32),
  blobCount: 1,
})
const sidecarTransaction = await account.signTransaction(preparedWithSidecars)
await verifySignedPublicationIntent(sidecarTransaction, sidecarReservation)

console.log('publisher immutable intent tests ok')
