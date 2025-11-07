// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.8.23;

interface IDebtToken {
    function approveDelegation(address delegatee, uint256 amount) external;
}