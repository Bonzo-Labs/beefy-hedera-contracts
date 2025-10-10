// SPDX-License-Identifier: MIT
pragma solidity >=0.6.0;

import {IHederaTokenService} from './IHederaTokenService.sol';
import {SafeCast} from './SafeCast.sol';

/// @title HederaTokenHelper
/// @notice Contains helper method for interacting with Hedera tokens that do not consistently return SUCCESS
library HederaTokenHelper {

    address internal constant precompileAddress = address(0x167);
    error RespCode(int32 respCode, string errorMsg);

    event Transfer(address indexed from, address indexed to, uint256 value, address indexed token);
    event Approval(address indexed from, address indexed to, uint256 value, address indexed token);
    
    /// @notice Associates token to account
    /// @dev Calls associate on token contract, errors with AssociateFail if association fails
    /// @param account The target of the association
    /// @param token The solidity address of the token to associate to target
    function safeAssociateToken(
        address account,
        address token
    ) internal {

        (bool success, bytes memory result) = precompileAddress.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector,
            account, token));
        int32 responseCode = success ? abi.decode(result, (int32)) : int32(21); // 21 = unknown
        
        if (responseCode != 22) {
            revert RespCode(responseCode, "association failed");
        }
    }

    /// @notice Transfers tokens from msg.sender to a recipient
    /// @param token The contract address of the token which will be transferred
    /// @param sender The sender of the transfer
    /// @param receiver The recipient of the transfer
    /// @param amount The value of the transfer
    function safeTransferFrom(
        address token,
        address sender,
        address receiver,
        uint256 amount
    ) internal {
        (bool success, bytes memory result) = precompileAddress.call(
            abi.encodeWithSelector(IHederaTokenService.transferToken.selector,
            token, sender, receiver, SafeCast.toInt64(amount)));
        int32 responseCode = success ? abi.decode(result, (int32)) : int32(21); // 21 = unknown
        
        if (responseCode != 22) {
            revert RespCode(responseCode, "safeTransferFrom failed");
        }

        emit Transfer(address(this), receiver, amount, token);
    }

    /// @notice Approves the stipulated contract to spend the given allowance in the given token
    /// @param token The contract address of the token to be approved
    /// @param spender The target of the approval
    /// @param amount The amount of the given token the target will be allowed to spend
    function safeApprove(
        address token,
        address spender,
        uint256 amount
    ) internal {
        (bool success, bytes memory result) = precompileAddress.call(
            abi.encodeWithSelector(IHederaTokenService.approve.selector,
            token, spender, SafeCast.toInt64(amount)));
        int32 responseCode = success ? abi.decode(result, (int32)) : int32(21); // 21 = unknown
        
        if (responseCode != 22) {
            revert RespCode(responseCode, "safeApprove failed");
        }

        emit Approval(address(this), spender, amount, token);
    }

}