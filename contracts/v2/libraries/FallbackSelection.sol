// SPDX-License-Identifier: VPL-1.0
pragma solidity ^0.8.24;

library FallbackSelection {
    bytes32 internal constant FALLBACK_SELECTION_DOMAIN = keccak256("RFE_FALLBACK_V1");

    error InvalidCandidateCount(uint32 candidateCount);

    function selectionIndex(
        bytes32 stationId,
        uint64 seasonNumber,
        uint32 lotIndex,
        uint8 failureClass,
        bytes32 fallbackSeed,
        uint32 candidateCount
    ) internal pure returns (uint32) {
        if (candidateCount == 0 || candidateCount > 64) revert InvalidCandidateCount(candidateCount);
        return uint32(
            uint256(
                keccak256(
                    abi.encode(
                        FALLBACK_SELECTION_DOMAIN,
                        stationId,
                        seasonNumber,
                        lotIndex,
                        failureClass,
                        fallbackSeed
                    )
                )
            ) % candidateCount
        );
    }
}
