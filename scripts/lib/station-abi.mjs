export const MAX_BLOBS_PER_SEGMENT = 6

export const stationAbi = [
  {
    type: 'error',
    name: 'DuplicateSegment',
    inputs: [
      { name: 'publisher', type: 'address' },
      { name: 'streamIdHash', type: 'bytes32' },
      { name: 'sequence', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'InvalidBlobCount', inputs: [] },
  { type: 'error', name: 'MissingBlob', inputs: [{ name: 'index', type: 'uint256' }] },
  {
    type: 'event',
    name: 'SegmentPublished',
    anonymous: false,
    inputs: [
      { name: 'publisher', type: 'address', indexed: true },
      { name: 'streamIdHash', type: 'bytes32', indexed: true },
      { name: 'sequence', type: 'uint256', indexed: true },
      { name: 'streamId', type: 'string', indexed: false },
      { name: 'durationMs', type: 'uint64', indexed: false },
      { name: 'payloadBytes', type: 'uint32', indexed: false },
      { name: 'payloadSha256', type: 'bytes32', indexed: false },
      { name: 'codec', type: 'string', indexed: false },
      { name: 'previousSegmentHash', type: 'bytes32', indexed: false },
      { name: 'blobVersionedHashes', type: 'bytes32[]', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'MAX_BLOBS_PER_SEGMENT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'publishSegment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'streamId', type: 'string' },
      { name: 'sequence', type: 'uint256' },
      { name: 'durationMs', type: 'uint64' },
      { name: 'payloadBytes', type: 'uint32' },
      { name: 'payloadSha256', type: 'bytes32' },
      { name: 'codec', type: 'string' },
      { name: 'previousSegmentHash', type: 'bytes32' },
      { name: 'blobCount', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'publishedSegments',
    stateMutability: 'view',
    inputs: [
      { name: 'publisher', type: 'address' },
      { name: 'streamIdHash', type: 'bytes32' },
      { name: 'sequence', type: 'uint256' },
    ],
    outputs: [{ name: 'published', type: 'bool' }],
  },
]
