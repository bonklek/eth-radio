// SPDX-License-Identifier: VPL-1.0
pragma solidity ^0.8.24;

contract Station {
    uint8 public constant MAX_BLOBS_PER_SEGMENT = 6;

    mapping(address publisher => mapping(bytes32 streamIdHash => mapping(uint256 sequence => bool published))) public publishedSegments;

    event SegmentPublished(
        address indexed publisher,
        bytes32 indexed streamIdHash,
        uint256 indexed sequence,
        string streamId,
        uint64 durationMs,
        uint32 payloadBytes,
        bytes32 payloadSha256,
        string codec,
        bytes32 previousSegmentHash,
        bytes32[] blobVersionedHashes
    );

    error InvalidBlobCount();
    error MissingBlob(uint256 index);
    error DuplicateSegment(address publisher, bytes32 streamIdHash, uint256 sequence);

    function publishSegment(
        string calldata streamId,
        uint256 sequence,
        uint64 durationMs,
        uint32 payloadBytes,
        bytes32 payloadSha256,
        string calldata codec,
        bytes32 previousSegmentHash,
        uint8 blobCount
    ) external {
        if (blobCount == 0 || blobCount > MAX_BLOBS_PER_SEGMENT) revert InvalidBlobCount();
        bytes32 streamIdHash = keccak256(bytes(streamId));
        if (publishedSegments[msg.sender][streamIdHash][sequence]) {
            revert DuplicateSegment(msg.sender, streamIdHash, sequence);
        }
        publishedSegments[msg.sender][streamIdHash][sequence] = true;

        bytes32[] memory blobVersionedHashes = new bytes32[](blobCount);
        for (uint256 i = 0; i < blobCount; i++) {
            bytes32 versionedHash = blobhash(i);
            if (versionedHash == bytes32(0)) revert MissingBlob(i);
            blobVersionedHashes[i] = versionedHash;
        }

        emit SegmentPublished(
            msg.sender,
            streamIdHash,
            sequence,
            streamId,
            durationMs,
            payloadBytes,
            payloadSha256,
            codec,
            previousSegmentHash,
            blobVersionedHashes
        );
    }
}
