// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

interface IStrategyConcLiq {
    function balances() external view returns (uint256, uint256);
    function beforeAction() external;
    function deposit() external;
    function withdraw(uint256 _amount0, uint256 _amount1) external;
    function pool() external view returns (address);
    function lpToken0() external view returns (address);
    function lpToken1() external view returns (address);
    function native() external view returns (address);
    function isCalm() external view returns (bool);
    function swapFee() external view returns (uint256);

    /// @notice The current price of the pool in token1, encoded with 36 decimals.
    /// @return _price The current price of the pool in token1.
    function price() external view returns (uint256 _price);

    /// @notice Get the current mint fee required for pool operations (SaucerSwap specific)
    /// @return mintFee The mint fee in tinybars (HBAR)
    function getMintFee() external view returns (uint256 mintFee);

    /// @notice Get leftover token amounts after liquidity addition
    /// @return leftover0Amount Amount of token0 left over
    /// @return leftover1Amount Amount of token1 left over
    function getLeftoverAmounts() external view returns (uint256 leftover0Amount, uint256 leftover1Amount);

    /// @notice Return leftover tokens to specified recipient
    /// @param recipient Address to receive leftover tokens
    function returnLeftovers(address recipient) external;
}
