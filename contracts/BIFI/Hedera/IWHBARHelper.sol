// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title Whbar Helper
/// @notice Contract Interface to interact with whbar
interface IWHBARHelper {
    function unwrapWhbar(uint wad) external;

    /// @notice Deposit whbar on behalf of msg.sender
    /// @dev This is payble, whbar will check msg.value > 0
    function deposit() external payable;
}