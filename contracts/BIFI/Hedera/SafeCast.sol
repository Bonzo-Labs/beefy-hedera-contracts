// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

/// @title Safe casting methods
/// @notice Contains methods for safely casting between types
library SafeCast {
    
    /// @notice Cast a uint256 to a int64, revert on overflow
    /// @param value The uint256 to be casted
    /// @return The casted integer, now type int64
    function toInt64(uint256 value) internal pure returns (int64) {
        require(
            value >= type(uint64).min && value <= 2**63-1, 'sc64'
        );
        return int64(uint64(value));
    }
}