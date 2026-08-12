// SPDX-License-Identifier: VPL-1.0
pragma solidity ^0.8.24;

/// @notice Test-only bounded-language projection for economics arithmetic.
/// @dev This harness is conformance evidence, not accepted protocol law.
contract FullPrecisionEconomicsHarness {
    error DivisionByZero();
    error ResultOverflow();
    error InexactDivision();

    function mulDiv(uint256 x, uint256 y, uint256 denominator, uint8 rounding)
        external
        pure
        returns (uint256 value, uint256 quotient, uint256 remainder)
    {
        if (denominator == 0) revert DivisionByZero();
        if (rounding > 2) revert();
        quotient = _mulDivDown(x, y, denominator);
        remainder = mulmod(x, y, denominator);
        if (rounding == 2 && remainder != 0) revert InexactDivision();
        if (rounding == 1 && remainder != 0) {
            if (quotient == type(uint256).max) revert ResultOverflow();
            value = quotient + 1;
        } else {
            value = quotient;
        }
    }

    function compareProducts(uint256 a, uint256 b, uint256 c, uint256 d) external pure returns (int8) {
        (uint256 leftHigh, uint256 leftLow) = _fullMultiply(a, b);
        (uint256 rightHigh, uint256 rightLow) = _fullMultiply(c, d);
        if (leftHigh < rightHigh || (leftHigh == rightHigh && leftLow < rightLow)) return -1;
        if (leftHigh > rightHigh || (leftHigh == rightHigh && leftLow > rightLow)) return 1;
        return 0;
    }

    function _fullMultiply(uint256 x, uint256 y) private pure returns (uint256 high, uint256 low) {
        assembly ("memory-safe") {
            let mm := mulmod(x, y, not(0))
            low := mul(x, y)
            high := sub(sub(mm, low), lt(mm, low))
        }
    }

    function _mulDivDown(uint256 x, uint256 y, uint256 denominator) private pure returns (uint256 result) {
        unchecked {
            (uint256 high, uint256 low) = _fullMultiply(x, y);
            if (high == 0) return low / denominator;
            if (denominator <= high) revert ResultOverflow();

            uint256 remainder = mulmod(x, y, denominator);
            assembly ("memory-safe") {
                high := sub(high, gt(remainder, low))
                low := sub(low, remainder)
            }

            uint256 twos = denominator & (~denominator + 1);
            assembly ("memory-safe") {
                denominator := div(denominator, twos)
                low := div(low, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            low |= high * twos;

            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = low * inverse;
        }
    }
}
