// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

interface IStrategyMultiToken {
    struct CommonAddresses {
        address vault;
        address unirouter;
        address keeper;
        address strategist;
        address beefyFeeRecipient;
        address beefyFeeConfig;
    }
    
    function vault() external view returns (address);
    function want() external view returns (IERC20Upgradeable);
    function beforeDeposit() external;
    function deposit() external payable returns (uint256 lp0Deposit, uint256 lp1Deposit);
    function withdraw(uint256, uint256) external;
    function balanceOf() external view returns (uint256);
    function balanceOfWant() external view returns (uint256);
    function balanceOfPool() external view returns (uint256);
    function harvest() external;
    function retireStrat() external;
    function panic() external;
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
    function unirouter() external view returns (address);
    function balanceOfToken0() external view returns (uint256);
    function balanceOfToken1() external view returns (uint256);
    function totalBalanceOfToken0() external view returns (uint256);
    function totalBalanceOfToken1() external view returns (uint256);
}
