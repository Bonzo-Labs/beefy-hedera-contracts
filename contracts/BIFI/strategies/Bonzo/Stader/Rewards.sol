// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "./Ownable.sol";
import "@openzeppelin-4/contracts/security/Pausable.sol";
import "@openzeppelin-4/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin-4/contracts/utils/Address.sol";

/// @title A rewards distributer contract
/// @author Stader Labs
/// @notice Distribute rewards on the provided Staker Contract according count of epochs and defined emission rate
contract Rewards is Ownable, Pausable, ReentrancyGuard {
    /// @notice emission rate value for the calculation distribution rewards
    /// @dev  Unit is tinybar per second
    uint256 public emissionRate = 773300997;
    /// @notice information about start time, when the current contract instance was deployed
    uint256 public genesisTimestamp;
    /// @notice timestamp when the distribution rewards function was called in the last time
    uint256 public lastRedeemedTimestamp;
    /// @notice count of called distribution rewards function
    uint256 public epoch = 0;
    /// @notice Fees percentage of the total rewards to be sent to the Dao
    uint256 public daoFeesPercentage = 10;
    /// @notice address of staker contract
    address payable stakerAddress;
    /// @notice address of Dao
    address payable public daoAddress;

    /// @notice event emitted while call function received
    event Received(address, uint256 amount);
    /// @notice event emitted while call function is triggered
    event Fallback(address, uint256 amount);
    /// @notice event emitted on successful transfer of rewards
    event DistributedRewards(
        address indexed stakerAddress,
        uint256 amount,
        uint256 timestamp
    );
    /// @notice event emitted on successful transfer of fees to Dao
    event DaoTransfer(
        address indexed daoAddress,
        uint256 amount,
        uint256 timestamp
    );
    /// @notice event emitted on successful updating emission rate
    event NewEmissionRate(uint256 amount);

    /// @notice Check for zero address before setting the address
    /// @dev Modifier
    /// @param _address the address to check
    modifier checkZeroAddress(address _address) {
        require(_address != address(0), "Address cannot be zero");
        _;
    }

    /// @dev Constructor
    /// @param _stakerAddress the address of staker contract
    /// @param _daoAddress the address of dao account collecting fees
    constructor(address payable _stakerAddress, address payable _daoAddress) 
        checkZeroAddress(_stakerAddress) 
        checkZeroAddress(_daoAddress) {
        stakerAddress = _stakerAddress;
        daoAddress = _daoAddress;
        genesisTimestamp = block.timestamp;
        lastRedeemedTimestamp = genesisTimestamp;
        // _pause();
    }

    /**********************
     * Main functions      *
     **********************/

    /** @notice Send hbar to the staking contract address based on the last redeemed timestamp.
     Example: if emissionRate is 20 Tinybar per seconds & difference between last redeemed timestamp & current timestamp is 86400 seconds (1 Day)
     then the staker contract will receive 1,72,8000 Tinybar (20 * 86400)
    send 10*10 hbar to the staking contract.
     */
    /// @dev currently we will distribute the rewards every 24 hours and is controlled by offchain function
    function distributeStakingRewards() external whenNotPaused nonReentrant {
        require(
            address(this).balance > 0,
            "Contract balance is should be greater than 0"
        );
        require(
            daoFeesPercentage < 100,
            "Dao fees percentage should be less than 100"
        );
        uint256 currentTimestamp = block.timestamp;
        uint256 epochDelta = (currentTimestamp - lastRedeemedTimestamp);
        lastRedeemedTimestamp = currentTimestamp;
        epoch++;
        uint256 epochRewards = (epochDelta * emissionRate);

        uint256 totalRewards = address(this).balance;
        if (epochRewards > totalRewards) epochRewards = totalRewards; // this is important

        uint256 daoFees = (epochRewards * daoFeesPercentage) / 100;

        // payable(stakerAddress).transfer(epochRewards - daoFees);
        Address.sendValue(payable(stakerAddress), epochRewards - daoFees);
        emit DistributedRewards(
            stakerAddress,
            epochRewards - daoFees,
            currentTimestamp
        );
        // payable(daoAddress).transfer(daoFees);
        Address.sendValue(payable(daoAddress), daoFees);
        emit DaoTransfer(daoAddress, daoFees, currentTimestamp);
    }

    /**********************
     * Setter functions   *
     **********************/

    /// @notice Emission rate is defined by tinybar per second.
    /// @param _emissionRate new value for the emission rate
    function setEmissionRate(uint256 _emissionRate) external onlyOwner {
        emissionRate = _emissionRate;
        emit NewEmissionRate(emissionRate);
    }

    /// @notice Update staker contract address for the distribution rewards
    /// @param _stakerAddress new address of staker contract
    function setStakerAddress(address payable _stakerAddress)
        external
        checkZeroAddress(_stakerAddress)
        onlyOwner
    {
        stakerAddress = _stakerAddress;
    }

    /// @notice Update Dao account address
    /// @param _daoAddress new address of Dao Account
    function setDaoAddress(address payable _daoAddress)
        external
        checkZeroAddress(_daoAddress)
        onlyOwner
    {
        daoAddress = _daoAddress;
    }

    /// @notice Update the fees for Dao
    /// @param _daoFeesPercentage update the new fees percentage for Dao
    function setDaoFeesPercentage(uint256 _daoFeesPercentage)
        external
        onlyOwner
    {
        require(
            _daoFeesPercentage < 100,
            "Dao fees percentage should be less than 100"
        );
        daoFeesPercentage = _daoFeesPercentage;
    }

    /**********************
     * Getter functions   *
     **********************/

    /// @notice Get current Emission rate for calculating APY
    function getEmissionRate() external view returns (uint256) {
        return emissionRate;
    }

    /// @notice Get Last Redeemed Timestamp
    function getLastRedeemedTimestamp() external view returns (uint256) {
        return lastRedeemedTimestamp;
    }

    /// @notice Pauses the contract
    /// @dev The contract must be in the unpaused ot normal state
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpauses the contract and returns it to the normal state
    /// @dev The contract must be in the paused state
    function unpause() external onlyOwner {
        _unpause();
    }

    /**********************
     * Fallback functions *
     **********************/

    /// @notice when no other function matches (not even the receive function)
    fallback() external payable {
        emit Fallback(msg.sender, msg.value);
    }

    /// @notice for empty calldata (and any value)
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }
}
