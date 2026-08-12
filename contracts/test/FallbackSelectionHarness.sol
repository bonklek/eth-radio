// SPDX-License-Identifier: VPL-1.0
pragma solidity ^0.8.24;

import {FallbackSelection} from "contracts/v2/libraries/FallbackSelection.sol";

contract FallbackSelectionHarness {
    function selectionIndex(
        bytes32 stationId,
        uint64 seasonNumber,
        uint32 lotIndex,
        uint8 failureClass,
        bytes32 fallbackSeed,
        uint32 candidateCount
    ) external pure returns (uint32) {
        return FallbackSelection.selectionIndex(
            stationId,
            seasonNumber,
            lotIndex,
            failureClass,
            fallbackSeed,
            candidateCount
        );
    }
}
