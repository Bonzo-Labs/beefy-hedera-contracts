// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

interface IStaking {
    function stake() external payable;
    function unStake(uint256 amount) external returns (uint256);
    function getExchangeRate() external view returns (uint256);
    function stakeWithNodes(uint256[] calldata amountToSend, uint256 index) external;
    function collectRewards(uint256[] memory pendingRewardNodeIndexes) external payable;
    function withdrawFromNodes() external;
    function updateNodeStakingActive() external;
    function updateStakeIsPaused() external;
    function updateUnStakeIsPaused() external;
    function updateMinDeposit(uint256 _newMinDeposit) external;
    function updateMaxDeposit(uint256 _newMaxDeposit) external;
    function updateOperatorAddress(address _operator) external;
    function setRewardsContractAddress(address _rewardsContractAddress) external;
    function setUndelegationContractAddress(address payable _undelegationContractAddress) external;
    function pause() external;
    function unpause() external;
}
