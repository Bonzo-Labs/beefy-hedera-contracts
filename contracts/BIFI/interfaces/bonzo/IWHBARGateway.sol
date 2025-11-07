// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.8.23;

/**
 * @title IWHBARGateway
 * @dev Interface for WHBARGateway - Hedera-native HBAR wrapper gateway using an ERC20-compatible WHBAR contract.
 */
interface IWHBARGateway {
  // Events
  event DepositHBAR(
    address indexed user,
    address indexed lendingPool,
    address indexed onBehalfOf,
    uint256 hbarAmount,
    uint256 whbarAmount,
    uint16 referralCode
  );

  event WithdrawHBAR(
    address indexed user,
    address indexed lendingPool,
    address indexed to,
    uint256 amount,
    uint256 hbarAmount
  );

  event RepayHBAR(
    address indexed user,
    address indexed lendingPool,
    address indexed onBehalfOf,
    uint256 hbarAmount,
    uint256 whbarAmount,
    uint256 rateMode,
    uint256 refundAmount
  );

  event BorrowHBAR(
    address indexed user,
    address indexed lendingPool,
    uint256 amount,
    uint256 interestRateMode,
    uint16 referralCode
  );

  event LendingPoolAuthorized(
    address indexed lendingPool,
    address indexed authorizedBy,
    uint256 timestamp
  );

  event TokenAssociated(address indexed token, address indexed gateway, int32 responseCode);

  event ERC20Recovered(
    address indexed token,
    address indexed recipient,
    uint256 amount,
    address indexed recoveredBy
  );

  event NativeRecovered(address indexed recipient, uint256 amount, address indexed recoveredBy);

  /**
   * @dev Associates the WHBAR token with the gateway
   */
  function associateWhbarToken() external;

  /**
   * @dev Authorizes a lending pool and sets up approvals
   * @param lendingPool The lending pool address to authorize
   */
  function authorizeLendingPool(address lendingPool) external;

  /**
   * @dev Deposits HBAR into the lending pool
   * @param lendingPool The lending pool address
   * @param onBehalfOf The address to deposit on behalf of
   * @param referralCode The referral code
   */
  function depositHBAR(
    address lendingPool,
    address onBehalfOf,
    uint16 referralCode
  ) external payable;

  /**
   * @dev Withdraws HBAR from the lending pool
   * @param lendingPool The lending pool address
   * @param amount The amount to withdraw (use type(uint256).max for full withdrawal)
   * @param to The address to receive the HBAR
   */
  function withdrawHBAR(address lendingPool, uint256 amount, address to) external;

  /**
   * @dev Repays HBAR debt in the lending pool
   * @param lendingPool The lending pool address
   * @param amount The amount to repay
   * @param rateMode The interest rate mode (2 for variable)
   * @param onBehalfOf The address to repay on behalf of
   */
  function repayHBAR(
    address lendingPool,
    uint256 amount,
    uint256 rateMode,
    address onBehalfOf
  ) external payable;

  /**
   * @dev Borrows HBAR from the lending pool
   * @param lendingPool The lending pool address
   * @param amount The amount to borrow
   * @param interestRateMode The interest rate mode
   * @param referralCode The referral code
   */
  function borrowHBAR(
    address lendingPool,
    uint256 amount,
    uint256 interestRateMode,
    uint16 referralCode
  ) external;

  /**
   * @dev Returns the WHBAR token address
   * @return The WHBAR token address
   */
  function getWHBARAddress() external view returns (address);

  /**
   * @dev Returns the lending pool address
   * @return The lending pool address
   */
  function getLendingPool() external view returns (address);

  /**
   * @dev Recovers ERC20 tokens sent to the contract
   * @param token The token address
   * @param amount The amount to recover
   * @param recipient The address to send the tokens to
   */
  function recoverERC20(address token, uint256 amount, address recipient) external;

  /**
   * @dev Recovers native HBAR sent to the contract
   * @param recipient The address to send the HBAR to
   * @param amount The amount to recover
   */
  function recoverNative(address recipient, uint256 amount) external;
}

