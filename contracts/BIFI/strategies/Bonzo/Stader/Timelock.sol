// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "@openzeppelin-4/contracts/utils/Address.sol";
import "@openzeppelin-4/contracts/security/ReentrancyGuard.sol";
import "./Ownable.sol";


abstract contract Timelock is ReentrancyGuard, Ownable{
  ///@notice time in secs for withholding transfer transaction
  ///@dev min 2 hours of time for withdrawing balance.
  uint256 constant public fixedLockedPeriod = 7200;
  ///@dev variable time in secs for withdrawing balance. Currently sent at 4 hours.
  uint256 public lockedPeriod = fixedLockedPeriod + 7200;

    ///@notice transaction data structure
    struct Withdraw {
        uint256 timestamp;
        uint256 lockedAmount;
        address payable to;
    }
    ///@notice list of all the transactions active and completed
    Withdraw[] public withdrawQueue;

    ///@notice event fired when the transfer transaction is queued
    event Queued(uint256 indexed index, uint256 amount);
    ///@notice event fired when the tokens are transferred successfully to the specified account
    event Transferred(
        uint256 indexed index,
        uint256 amount,
        address payable to
    );
    ///@notice event is fired when the admin owner cancels the transaction
    event WithdrawCancelled(uint256 indexed index, uint256 amount);

    ///@notice event is fired after updating timelockOwner
    event TimeLockOwnerUpdated(address indexed newTimeLockOwner);
    /// @notice address of multisig admin account for hbar mover to new contract
    address timelockOwner;
    /// @notice address of proposed timelockOwner
    address timelockOwnerCandidate;

    error addressCanNotBeZero();
    error invalidOwner();
    error amountExceedsBalance();
    error noFundsToWithdraw();
    error invalidIndex();
    error unlockPeriodNotExpired();
    error amountNotAvailable();
    error lockPeriodUnchanged();

    /// @notice Check for zero address before setting the address
    /// @dev Modifier
    /// @param _address the address to check
    modifier checkZeroAddress(address _address) {
        if(_address == address(0)) revert addressCanNotBeZero();
        _;
    }
    /// @notice Check for checking the owner for transaction
    /// @dev Modifier
    modifier checkOwner() {
        if (msg.sender != timelockOwner) revert invalidOwner();
        _;
    }

    /// @notice Constructor
    /// @param _timelockOwner the address of owner/admin for carrying out the transaction
    constructor(address _timelockOwner) checkZeroAddress(_timelockOwner) {
        timelockOwner = _timelockOwner;
    }

    /********************************
     * Admin Tx functions   *
     ********************************/

    /// @notice queue the transaction for withdrawal with a specified amount
    /// @param to address of the account to transfer the tokens to
    /// @param amount the index of the transaction queue which is to be withdrawn
    function queuePartialFunds(address payable to, uint256 amount)
        external
        checkZeroAddress(to)
        checkOwner
        returns (uint256)
    {
        if (amount > address(this).balance) revert amountExceedsBalance();
        uint256 index = withdrawQueue.length;
        Withdraw memory withdrawData = Withdraw({
            timestamp: block.timestamp,
            lockedAmount: amount,
            to: to
        });
        withdrawQueue.push(withdrawData);
        emit Queued(index, amount);
        return index;
    }

    /// @notice queue the transaction for withdrawal of the entire contract balance
    /// @param to address of the account to transfer the tokens to
    function queueAllFunds(address payable to)
        external
        checkZeroAddress(to)
        checkOwner
        returns (uint256)
    {
        uint256 index = withdrawQueue.length;
        Withdraw memory userTransaction = Withdraw({
            timestamp: block.timestamp,
            lockedAmount: address(this).balance,
            to: to
        });
        withdrawQueue.push(userTransaction);
        emit Queued(index, address(this).balance);
        return index;
    }

    /// @notice Withdraws the funds from the contract post cooldown period
    /// @param index the index of the transaction queue which is to be withdrawn
    function withdraw(uint256 index) external nonReentrant returns (uint256) {
        if (address(this).balance == 0) revert noFundsToWithdraw();
        if (index >= withdrawQueue.length) revert invalidIndex();
        Withdraw storage withdrawData = withdrawQueue[index];
        if (withdrawData.timestamp + lockedPeriod >= block.timestamp)
            revert unlockPeriodNotExpired();
        if (withdrawData.lockedAmount == 0) revert amountNotAvailable();
        address payable to = withdrawData.to;
        uint256 amount = withdrawData.lockedAmount;
        delete withdrawQueue[index];
        // payable(to).transfer(amount);
        Address.sendValue(payable(to), amount);
        emit Transferred(index, amount, to);
        return index;
    }

    /// @notice Cancels the withdraw transaction in the queue
    /// @param index index value of the transaction to be cancelled
    function cancelWithdraw(uint256 index)
        external
        checkOwner
        returns (uint256)
    {
        if (index >= withdrawQueue.length) revert invalidIndex();
        uint256 amount = withdrawQueue[index].lockedAmount;
        delete withdrawQueue[index];
        emit WithdrawCancelled(index, amount);
        return index;
    }

    /**********************
     * Setter functions   *
     **********************/

    /**
     * @dev Returns the address of the new owner candidate.
     */
    function timelockOwnerNewCandidate() external view returns (address) {
        return timelockOwnerCandidate;
    }

    /**
     * @dev Proposes a new owner. Can only be called by the current
     * owner of the contract.
     */
    function proposeTimelockOwner(address newOwner) external checkOwner {
        if (newOwner == address(0x0)) revert addressCanNotBeZero();
        timelockOwnerCandidate = newOwner;
    }

    /**
     * @dev Assigns the ownership of the contract to _ownerCandidate.
     * Can only be called by the _ownerCandidate.
     */
    function acceptTimelockOwnership() external {
        if (timelockOwnerCandidate != msg.sender)
            revert invalidOwner();
        timelockOwner = msg.sender;
        emit TimeLockOwnerUpdated(msg.sender);
    }

    /**
     * @dev Cancels the new owner proposal.
     * Can only be called by the _ownerCandidate or the current owner
     * of the contract.
     */
    function cancelTimelockOwnerProposal() external {
        if (timelockOwnerCandidate != msg.sender && timelockOwner != msg.sender)
            revert invalidOwner();
        timelockOwnerCandidate = address(0x0);
    }

    /// @notice Set the locking period for the transfer of tokens
    /// @param _lockedPeriod time in secs for withholding transfer transaction
    function setLockedPeriod(uint256 _lockedPeriod) external onlyOwner {
        _lockedPeriod = fixedLockedPeriod + _lockedPeriod;
        if(_lockedPeriod == lockedPeriod) revert lockPeriodUnchanged();
        lockedPeriod = _lockedPeriod;
    }
}
