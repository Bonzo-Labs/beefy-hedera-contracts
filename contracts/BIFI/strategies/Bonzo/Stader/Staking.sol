// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "./Timelock.sol";
import "./Rewards.sol";
import "@openzeppelin-4/contracts/utils/math/SafeCast.sol";
import "@openzeppelin-4/contracts/security/Pausable.sol";
import "@openzeppelin-4/contracts/utils/Address.sol";
import "../../../Hedera/HederaTokenService.sol";
import "../../../Hedera/HederaResponseCodes.sol";

/**
@title Staking contract
@author Stader Labs
@notice Main point of interaction with Stader protocol's v2 liquid staking
@dev Total stake amount is equal to total hbar in the contract balance
 **/
contract Staking is
    HederaTokenService,
    ReentrancyGuard,
    Pausable,
    Timelock
{
    using SafeCast for uint256;
    using SafeCast for int256;

    bool public isStakePaused = false;
    bool public isUnstakePaused = false;
    bool public nodeStakingActive = false;

    uint256 public constant decimals = 10**8;
    /// @notice minimum deposit amount per staking transaction
    uint256 public minDeposit = 1 * decimals;
    /// @notice maximum deposit amount per staking transaction
    uint256 public maxDeposit = 10**12 * decimals;
    uint256 public totalSupply = 0;
    uint256 public balanceBefore;

    /// @notice address of rewards contract
    Rewards rewardsContractAddress;

    /// @notice address of hbarx token from Hedera Token service
    address public hbarxAddress;

    /// @notice address of operator for protocol staking
    address operator;

    /// @notice address of undelegation contract
    address payable public undelegationContractAddress;

    address payable[] public nodeProxyAddresses;

    /// @notice event emitted after call function receive
    event Received(address indexed from, uint256 amount);
    /// @notice event emitted after call function fallback
    event Fallback(address indexed from, uint256 amount);
    /// @notice event emitted after call function stake
    event Staked(address indexed to, uint256 hbarReceived, int64 hbarxToSend);
    /// @notice event emitted after call function unstake
    event UnStaked(
        address indexed from,
        uint256 hbarToTransfer,
        uint256 hbarxToBurn
    );

    /// @notice additional provisional event for the event received via call undelegation function while unstake
    event Undelegated(address indexed to, uint256 amount);

    /// @notice event emitted after call function protocolStaking
    event stakedWithNodes(uint256 indexed balance);

    /// @notice event emitted after call function getFundsFromSisterContracts
    event withdrawnFromNodes(uint256 indexed balance);

    /// @notice event emitted after call function protocolStakingRewardDistribution
    event nodeStakingDaoFeeTransfer(address indexed to, uint256 amount);

    /// @notice event works as an alert for protocol staking
    event ReceivedLessFundsFromNodeProxy(uint256 amount);

    /// @notice event emits after updating nodeStakingActive flag
    event updatedNodeStakingActiveFlag(bool nodeStakingActiveFlag);

    error invalidOperator();
    error zeroAddressForNodeProxy();
    error nodeStakingActiveError();
    error stakingIsPaused();
    error invalidDepositAmount();
    error rewardsContractZeroBalance();
    error hbarXMintFailed();
    error hbarXTransferFailed();
    error unStakingIsPaused();
    error hbarXBurnFailed();
    error transferFailed();
    error invalidInputAmountToSend();
    error nodeStakingNotActiveError();
    error invalidInputCollectRewards();
    error insufficientBalance();
    error withdrawingFundsFailed();
    error nodeProxyTransferFailed();
    error invalidMinDepositValue();
    error invalidMaxDepositValue();


    /// @notice Check for checking the owner for protocol staking methods
    /// @dev Modifier
    modifier onlyOperator() {
        if(msg.sender != operator)
            revert invalidOperator();
        _;
    }

    /// @notice Constructor
    /// @param _hbarxAddress the address of hbarx token from Hedera Token service
    /// @param _multisigAdminAddress the address of account of Hbar withdrawal to new contract
    /// @param _undelegationContractAddress the address of undelegation contract
    /// @param _totalSupply the current total supply of HBARX
    /// @param _operator owner for protocol staking methods

    constructor(
        address _hbarxAddress,
        address _multisigAdminAddress,
        address payable _undelegationContractAddress,
        uint256 _totalSupply,
        address _operator,
        address[] memory _nodeProxyAddresses
    )
        Timelock(_multisigAdminAddress)
        checkZeroAddress(_hbarxAddress)
        checkZeroAddress(_undelegationContractAddress)
        checkZeroAddress(_operator)
    {
        hbarxAddress = _hbarxAddress;
        undelegationContractAddress = _undelegationContractAddress;
        totalSupply = _totalSupply;
        operator = _operator;
        for (uint256 i = 0; i < _nodeProxyAddresses.length; i++) {
            if (_nodeProxyAddresses[i] == address(0))
                revert zeroAddressForNodeProxy();
            nodeProxyAddresses.push(payable(_nodeProxyAddresses[i]));
        }
        _pause();
    }

    /**********************
     * User functions      *
     **********************/

    /// @notice stake hbar to receive hbarx tokens to the provided address
    function stake() external payable whenNotPaused nonReentrant {
        if(nodeStakingActive) revert nodeStakingActiveError();
        if(isStakePaused) revert stakingIsPaused();
        uint256 hbarReceived = msg.value;

        if(hbarReceived <= minDeposit) revert invalidDepositAmount();
        if(hbarReceived > maxDeposit) revert invalidDepositAmount();

        ///@dev deploy rewards contract and add hbar to the rewards contract balance
        if(address(rewardsContractAddress).balance == 0)
            revert rewardsContractZeroBalance();

        ///@dev exchangeRate is 1 if total supply of hbarX is zero or denominator is 0
        uint256 hbarxToMint = hbarReceived;
        if ((address(this).balance - hbarReceived) != 0 && totalSupply != 0) {
            hbarxToMint =
                (hbarReceived * ((totalSupply))) /
                (address(this).balance - hbarReceived);
        }

        ///@dev casting is required for matching the original signature of the function
        uint64 hbarxMint = (hbarxToMint).toUint64();
        int64 hbarxToSend = (hbarxToMint).toInt256().toInt64();

        ///@dev associate tokens to the address

        HederaTokenService.associateToken(msg.sender, hbarxAddress);

        ///@dev mint hbarx tokens
        (int256 mintTokenResponse, uint64 newTotalSupply, ) = HederaTokenService
            .mintToken(hbarxAddress, hbarxMint, new bytes[](0));
        totalSupply = uint256(newTotalSupply);
        if (mintTokenResponse != HederaResponseCodes.SUCCESS) {
            revert hbarXMintFailed();
        }
        ///@dev transfer hbarx to the provided address
        int256 transferTokenResponse = HederaTokenService.transferToken(
            hbarxAddress,
            address(this),
            msg.sender,
            hbarxToSend
        );

        if (transferTokenResponse != HederaResponseCodes.SUCCESS) {
            revert hbarXTransferFailed();
        }

        emit Staked(msg.sender, hbarReceived, hbarxToSend);
    }

    /// @notice unstake HBARX to withdraw to the undelegation contract
    /// @param amount the amount of HBARX to unstake
    function unStake(uint256 amount) external whenNotPaused returns (uint256) {
        if(nodeStakingActive) revert nodeStakingActiveError();
        if(isUnstakePaused) revert unStakingIsPaused();
        uint256 hbarxToBurn = (amount);

        uint256 hbarToTransfer = hbarxToBurn; // exchange rate = 1
        if (totalSupply != 0) {
            hbarToTransfer =
                (hbarxToBurn * ((address(this).balance))) /
                (totalSupply);
        }

        ///@dev transfer hbarx to the provided address
        int256 transferTokenResponse = HederaTokenService.transferToken(
            hbarxAddress,
            msg.sender,
            address(this),
            hbarxToBurn.toInt256().toInt64()
        );

        if (transferTokenResponse != HederaResponseCodes.SUCCESS) {
            revert hbarXTransferFailed();
        }

        ///@dev burn hbarx tokens
        (int256 burnTokenResponse, uint64 newTotalSupply) = HederaTokenService
            .burnToken(hbarxAddress, hbarxToBurn.toUint64(), new int64[](0));
        totalSupply = uint256(newTotalSupply);
        if (burnTokenResponse != HederaResponseCodes.SUCCESS) {
            revert hbarXBurnFailed();
        }

        ///@dev move tokens to undelegation contract
        (bool success, ) = payable(undelegationContractAddress).call{
            value: hbarToTransfer
        }(abi.encodeWithSignature("undelegate(address)", msg.sender));
        if (!success) {
            revert transferFailed();
        }
        emit UnStaked(msg.sender, hbarToTransfer, hbarxToBurn);
        ///@dev return hbars for transaction
        return hbarToTransfer;
    }

    /**
     * @notice moving Hbar to nodeProxy contract for Staking
     * @dev amountToSend array specify amount of hbar to send to each nodeProxyContract
     * @param amountToSend array of hbar amount to send
     * @param index index of nodeProxy contract array where extra funds are sent
     */
    function stakeWithNodes(uint256[] calldata amountToSend, uint256 index)
        external
        whenNotPaused
        onlyOperator
    {
        uint256 nodeProxyAddressesLength = nodeProxyAddresses.length;
        if(nodeStakingActive) revert nodeStakingActiveError();
        if(index >= nodeProxyAddressesLength) revert invalidIndex();
        if(amountToSend.length != nodeProxyAddressesLength)
            revert invalidInputAmountToSend();
        nodeStakingActive = true;
        balanceBefore = address(this).balance;
        // iterating over amountToSend array to send hbar to respective index of nodeProxyContract
        // following checks are to incorporate changes in the staking contract balance after computing amountToSend
        for (uint256 i = 0; i < amountToSend.length; i++) {
            if (address(this).balance > 0) {
                if (amountToSend[i] > 0) {
                    moveBalanceForStaking(
                        nodeProxyAddresses[i],
                        amountToSend[i] > address(this).balance
                            ? address(this).balance
                            : amountToSend[i]
                    );
                }
            } else {
                break;
            }
        }
        if (address(this).balance > 0) {
            moveBalanceForStaking(
                nodeProxyAddresses[index],
                address(this).balance
            );
        }
        emit stakedWithNodes(balanceBefore);
    }

    /**
     * @notice collect protocol staking pendingRewards
     * @dev initiate transfer of hbar in nodeProxy contract to get pendingRewards
     * only operator can call this
     */
    function collectRewards(uint256[] memory pendingRewardNodeIndexes)
        external
        payable
        whenNotPaused
        onlyOperator
    {
        uint256 nodeProxyAddressesLength = nodeProxyAddresses.length;
        if(!nodeStakingActive) revert nodeStakingNotActiveError();
        if(pendingRewardNodeIndexes.length != nodeProxyAddressesLength)
            revert invalidInputCollectRewards();
        for (uint256 i; i < nodeProxyAddressesLength; i++) {
            if (pendingRewardNodeIndexes[i]==1) {
                if(address(this).balance<1) revert insufficientBalance();
                moveBalanceForStaking(nodeProxyAddresses[i], 1);
            }
        }
    }

    /**
     * @notice withdrawing funds from nodeProxy after snapshots
     * @dev loop through all nodeProxy Contract and get funds back to staking Contract
     */
    function withdrawFromNodes() external whenNotPaused onlyOperator {
        if(!nodeStakingActive) revert nodeStakingNotActiveError();
        uint256 nodeProxyAddressesLength = nodeProxyAddresses.length;
        for (uint256 i; i < nodeProxyAddressesLength; i++) {
            if (address(nodeProxyAddresses[i]).balance > 0) {
                (bool transferFundSuccess, ) = (nodeProxyAddresses[i]).call(
                    abi.encodeWithSignature("transferFund()")
                ); // transferFund transfer all nodeProxy balance back to staking contract
                if (!transferFundSuccess) {
                    revert withdrawingFundsFailed();
                }
            }
        }
        emit withdrawnFromNodes(address(this).balance);
        //doa fee calculation based on rewards
        if (address(this).balance >= balanceBefore) {
            uint256 totalReward = address(this).balance - balanceBefore;
            uint256 daoFees = (totalReward *
                rewardsContractAddress.daoFeesPercentage()) / 100;
            Address.sendValue(
                payable(rewardsContractAddress.daoAddress()),
                daoFees
            );
            nodeStakingActive = false;
            emit nodeStakingDaoFeeTransfer(
                rewardsContractAddress.daoAddress(),
                daoFees
            );
        }
        // if withdrawn balance less than balanceSent, do not change nodeStakingActive flag
        // emit an event to get an alert and debug the cause
        else {
            emit ReceivedLessFundsFromNodeProxy(
                balanceBefore - address(this).balance
            );
        }
    }

    /// @notice calls receiveFunds method of nodeProxy contract
    function moveBalanceForStaking(address payable _nodeProxy, uint256 amount)
        internal
    {
        (bool success, ) = (_nodeProxy).call{value: amount}(
            abi.encodeWithSignature("receiveFunds()")
        );
        if (!success) revert nodeProxyTransferFailed();
    }

    /**********************
     * Getter functions   *
     **********************/

    /// @notice Calculation of exchange rate
    /// @return exchangeRate i.e tinybarValue value for 1 hbarx
    function getExchangeRate() external view returns (uint256) {
        ///@dev 1HBar = 100_000_000 tinybar
        uint256 exchangeRate = 1 * decimals;
        
        if (totalSupply == 0 || address(this).balance==0) {
            if(nodeStakingActive){
                if(totalSupply==0 || balanceBefore==0) return exchangeRate;
                else return (balanceBefore * decimals) / totalSupply;
            }
            return exchangeRate;
        }
        else {
            uint256 balance = nodeStakingActive?balanceBefore:address(this).balance;
            exchangeRate = (balance * decimals) / totalSupply;
        }
        return exchangeRate;
    }

    /**********************
     * Setter functions   *
     **********************/

    /// @notice Toggle pause state of Stake function
    function updateStakeIsPaused() external onlyOwner {
        isStakePaused = !isStakePaused;
    }

    /// @notice Toggle pause state of Unstake function
    function updateUnStakeIsPaused() external onlyOwner {
        isUnstakePaused = !isUnstakePaused;
    }

    /// @notice Set minimum deposit amount (onlyOwner)
    /// @param _newMinDeposit the minimum deposit amount in multiples of 10**8
    function updateMinDeposit(uint256 _newMinDeposit) external onlyOwner {
        if(_newMinDeposit>=maxDeposit) revert invalidMinDepositValue();
        minDeposit = _newMinDeposit;
    }

    /// @notice Set maximum deposit amount (onlyOwner)
    /// @param _newMaxDeposit the maximum deposit amount in multiples of 10**8
    function updateMaxDeposit(uint256 _newMaxDeposit) external onlyOwner {
        if(_newMaxDeposit<=minDeposit) revert invalidMaxDepositValue();
        maxDeposit = _newMaxDeposit;
    }

    /// @notice update the operator address
    /// @param _operator new operator address for protocol staking operations
    function updateOperatorAddress(address _operator)
        external
        checkZeroAddress(_operator)
        onlyOwner
    {
        operator = _operator;
    }

    /// @notice Set rewards contract address (onlyOwner)
    /// @param _rewardsContractAddress the rewards contract address value
    function setRewardsContractAddress(Rewards _rewardsContractAddress)
        external
        checkZeroAddress(address(_rewardsContractAddress))
        onlyOwner
    {
        rewardsContractAddress = _rewardsContractAddress;
    }

    /// @notice Set undelegation contract address (onlyOwner)
    /// @param _undelegationContractAddress the undelegation contract address value
    function setUndelegationContractAddress(
        address payable _undelegationContractAddress
    ) external checkZeroAddress(_undelegationContractAddress) onlyOwner {
        undelegationContractAddress = _undelegationContractAddress;
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

    /**
     * @notice change the state of nodeStakingActive
     * @dev toggle the state of nodeStakingActive flag
     */
    function updateNodeStakingActive() external onlyOwner {
        nodeStakingActive = !nodeStakingActive;
        emit updatedNodeStakingActiveFlag(nodeStakingActive);
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
