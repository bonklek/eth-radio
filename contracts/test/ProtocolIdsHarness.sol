// SPDX-License-Identifier: VPL-1.0
pragma solidity ^0.8.24;

import {ProtocolIds} from "contracts/v2/libraries/ProtocolIds.sol";

contract ProtocolIdsHarness {
    function stationId(uint256 chainId, address stationCore) external pure returns (bytes32) {
        return ProtocolIds.stationId(chainId, stationCore);
    }

    function channelId(bytes32 station, bytes32 canonicalChannelKey) external pure returns (bytes32) {
        return ProtocolIds.channelId(station, canonicalChannelKey);
    }

    function seasonId(bytes32 channel, uint64 seasonNumber) external pure returns (bytes32) {
        return ProtocolIds.seasonId(channel, seasonNumber);
    }

    function lotId(bytes32 season, uint32 lotIndex) external pure returns (bytes32) {
        return ProtocolIds.lotId(season, lotIndex);
    }

    function reservationId(bytes32 lot, address winner, uint64 allocationNonce) external pure returns (bytes32) {
        return ProtocolIds.reservationId(lot, winner, allocationNonce);
    }

    function programId(bytes32 reservation, uint64 programNonce) external pure returns (bytes32) {
        return ProtocolIds.programId(reservation, programNonce);
    }

    function assetId(bytes32 manifestRoot, bytes32 codecProfileHash, uint64 totalDurationMs) external pure returns (bytes32) {
        return ProtocolIds.assetId(manifestRoot, codecProfileHash, totalDurationMs);
    }

    function segmentId(bytes32 asset, uint32 sequence) external pure returns (bytes32) {
        return ProtocolIds.segmentId(asset, sequence);
    }

    function v1SyntheticChannelId(
        uint256 chainId,
        address stationAddress,
        address publisher,
        bytes32 streamIdHash
    ) external pure returns (bytes32) {
        return ProtocolIds.v1SyntheticChannelId(chainId, stationAddress, publisher, streamIdHash);
    }
}
