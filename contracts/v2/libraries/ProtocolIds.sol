// SPDX-License-Identifier: VPL-1.0
pragma solidity ^0.8.24;

library ProtocolIds {
    bytes32 internal constant STATION_ID_DOMAIN = keccak256("RFE_STATION_ID_V2");
    bytes32 internal constant CHANNEL_ID_DOMAIN = keccak256("RFE_CHANNEL_ID_V2");
    bytes32 internal constant SEASON_ID_DOMAIN = keccak256("RFE_SEASON_ID_V2");
    bytes32 internal constant LOT_ID_DOMAIN = keccak256("RFE_LOT_ID_V2");
    bytes32 internal constant RESERVATION_ID_DOMAIN = keccak256("RFE_RESERVATION_ID_V2");
    bytes32 internal constant PROGRAM_ID_DOMAIN = keccak256("RFE_PROGRAM_ID_V2");
    bytes32 internal constant ASSET_ID_DOMAIN = keccak256("RFE_ASSET_ID_V2");
    bytes32 internal constant SEGMENT_ID_DOMAIN = keccak256("RFE_SEGMENT_ID_V2");
    bytes32 internal constant V1_CHANNEL_ID_DOMAIN = keccak256("RFE_V1_SYNTHETIC_CHANNEL_ID");

    function stationId(uint256 chainId, address stationCore) internal pure returns (bytes32) {
        return keccak256(abi.encode(STATION_ID_DOMAIN, chainId, stationCore));
    }

    function channelId(bytes32 station, bytes32 canonicalChannelKey) internal pure returns (bytes32) {
        return keccak256(abi.encode(CHANNEL_ID_DOMAIN, station, canonicalChannelKey));
    }

    function seasonId(bytes32 channel, uint64 seasonNumber) internal pure returns (bytes32) {
        return keccak256(abi.encode(SEASON_ID_DOMAIN, channel, seasonNumber));
    }

    function lotId(bytes32 season, uint32 lotIndex) internal pure returns (bytes32) {
        return keccak256(abi.encode(LOT_ID_DOMAIN, season, lotIndex));
    }

    function reservationId(bytes32 lot, address winner, uint64 allocationNonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(RESERVATION_ID_DOMAIN, lot, winner, allocationNonce));
    }

    function programId(bytes32 reservation, uint64 programNonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(PROGRAM_ID_DOMAIN, reservation, programNonce));
    }

    function assetId(bytes32 manifestRoot, bytes32 codecProfileHash, uint64 totalDurationMs) internal pure returns (bytes32) {
        return keccak256(abi.encode(ASSET_ID_DOMAIN, manifestRoot, codecProfileHash, totalDurationMs));
    }

    function segmentId(bytes32 asset, uint32 sequence) internal pure returns (bytes32) {
        return keccak256(abi.encode(SEGMENT_ID_DOMAIN, asset, sequence));
    }

    function v1SyntheticChannelId(
        uint256 chainId,
        address stationAddress,
        address publisher,
        bytes32 streamIdHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(V1_CHANNEL_ID_DOMAIN, chainId, stationAddress, publisher, streamIdHash));
    }
}
