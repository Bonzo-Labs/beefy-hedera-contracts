// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20Metadata} from "@openzeppelin-4/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../../interfaces/uniswap/IUniswapV3Pool.sol";
import "../../utils/LiquidityAmounts.sol";
import "../../utils/TickMath.sol";
import "../../utils/TickUtils.sol";
import "../../utils/Univ3Utils.sol";
import "../../utils/FullMath.sol";
import "../../interfaces/uniswap/IQuoter.sol";

/// @title SaucerSwap CLM Library
/// @notice Library containing utility functions for CLM strategy to reduce main contract size
library SaucerSwapCLMLib {
    using TickMath for int24;

    /// @notice The precision for pricing.
    uint256 private constant PRECISION = 1e36;
    uint256 private constant SQRT_PRECISION = 1e18;

    /// @notice Struct for position data
    struct Position {
        int24 tickLower;
        int24 tickUpper;
    }

    /// @notice Struct for balance information
    struct BalanceInfo {
        uint256 token0Bal;
        uint256 token1Bal;
        uint256 mainAmount0;
        uint256 mainAmount1;
        uint256 altAmount0;
        uint256 altAmount1;
    }

    /**
     * @notice Calculate price from sqrt price
     * @param sqrtPriceX96 The sqrt price
     * @return _price The calculated price
     */
    function calculatePrice(uint160 sqrtPriceX96) external pure returns (uint256 _price) {
        _price = FullMath.mulDiv(uint256(sqrtPriceX96), SQRT_PRECISION, (2 ** 96)) ** 2;
    }

    /**
     * @notice Get pool price directly from slot0 data
     * @param pool The pool address
     * @return _price The current pool price
     */
    function getPoolPrice(address pool) external view returns (uint256 _price) {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        _price = FullMath.mulDiv(uint256(sqrtPriceX96), SQRT_PRECISION, (2 ** 96)) ** 2;
    }

    /**
     * @notice Get pool sqrt price directly from slot0 data
     * @param pool The pool address
     * @return sqrtPriceX96 The current pool sqrt price
     */
    function getPoolSqrtPrice(address pool) external view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
    }

    /**
     * @notice Get pool slot0 data
     * @param pool The pool address
     * @return sqrtPriceX96 The sqrt price
     * @return tick The current tick
     */
    function getPoolSlot0(address pool) external view returns (uint160 sqrtPriceX96, int24 tick) {
        (sqrtPriceX96, tick, , , , , ) = IUniswapV3Pool(pool).slot0();
    }

    /**
     * @notice Get pool fee
     * @param pool The pool address
     * @return fee The pool fee in 18 decimals
     */
    function getPoolFee(address pool) external view returns (uint256 fee) {
        fee = (uint256(IUniswapV3Pool(pool).fee()) * SQRT_PRECISION) / 1e6;
    }

    /**
     * @notice Get position amounts for a given position
     * @param pool The pool address
     * @param positionKey The position key
     * @param positionData The position tick data
     * @param sqrtPriceX96 Current sqrt price
     * @return amount0 Token0 amount
     * @return amount1 Token1 amount
     */
    function getPositionAmounts(
        address pool,
        bytes32 positionKey,
        Position memory positionData,
        uint160 sqrtPriceX96
    ) external view returns (uint256 amount0, uint256 amount1) {
        (uint128 liquidity, , , uint256 owed0, uint256 owed1) = IUniswapV3Pool(pool).positions(positionKey);

        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(positionData.tickLower),
            TickMath.getSqrtRatioAtTick(positionData.tickUpper),
            liquidity
        );

        amount0 += owed0;
        amount1 += owed1;
    }

    /**
     * @notice Calculate position ticks based on current tick and width
     * @param tick Current tick
     * @param width Position width multiplier
     * @param distance Tick distance/spacing
     * @return tickLower Lower tick
     * @return tickUpper Upper tick
     */
    function calculatePositionTicks(
        int24 tick,
        int24 width,
        int24 distance
    ) external pure returns (int24 tickLower, int24 tickUpper) {
        int24 positionWidth = width * distance;
        (tickLower, tickUpper) = TickUtils.baseTicks(tick, positionWidth, distance);
    }

    /**
     * @notice Calculate alternative position ticks for limit order
     * @param tick Current tick
     * @param distance Tick distance/spacing
     * @param isToken0 Whether to create position for token0 or token1
     * @return tickLower Lower tick
     * @return tickUpper Upper tick
     */
    function calculateAltTicks(
        int24 tick,
        int24 distance,
        bool isToken0
    ) external pure returns (int24 tickLower, int24 tickUpper) {
        if (isToken0) {
            // Token0 position: above current tick (selling token0 for token1)
            tickLower = TickUtils.floor(tick, distance);
            tickUpper = tickLower + distance;
        } else {
            // Token1 position: below current tick (selling token1 for token0)
            int24 tickFloor = TickUtils.floor(tick, distance);
            tickUpper = tickFloor + distance;
            tickLower = tickUpper - distance;
        }
    }

    /**
     * @notice Get TWAP from pool
     * @param pool The pool address
     * @param twapInterval The TWAP interval in seconds
     * @return twapTick The TWAP tick
     */
    function getTwap(address pool, uint32 twapInterval) external view returns (int56 twapTick) {
        uint32[] memory secondsAgo = new uint32[](2);
        secondsAgo[0] = twapInterval;
        secondsAgo[1] = 0;

        (int56[] memory tickCuml, ) = IUniswapV3Pool(pool).observe(secondsAgo);
        twapTick = (tickCuml[1] - tickCuml[0]) / int32(twapInterval);
    }

    /**
     * @notice Check if current price is within deviation from TWAP
     * @param pool The pool address
     * @param twapInterval The TWAP interval
     * @param maxDeviation Maximum allowed deviation
     * @return isCalm True if within acceptable deviation
     */
    function isPoolCalm(address pool, uint32 twapInterval, int56 maxDeviation) external view returns (bool isCalm) {
        (, int24 tick, , , , , ) = IUniswapV3Pool(pool).slot0();

        uint32[] memory secondsAgo = new uint32[](2);
        secondsAgo[0] = twapInterval;
        secondsAgo[1] = 0;

        (int56[] memory tickCuml, ) = IUniswapV3Pool(pool).observe(secondsAgo);
        int56 twapTick = (tickCuml[1] - tickCuml[0]) / int32(twapInterval);

        int56 deviation = tick > twapTick ? tick - twapTick : twapTick - tick;
        isCalm = deviation <= maxDeviation;
    }

    /**
     * @notice Convert path to route for display
     * @param path The encoded path
     * @return route Array of token addresses
     */
    function pathToRoute(bytes memory path) external pure returns (address[] memory route) {
        if (path.length == 0) return new address[](0);
        return UniV3Utils.pathToRoute(path);
    }

    /**
     * @notice Get token price via quoter
     * @param quoter The quoter address
     * @param token The token address
     * @param native The native token address
     * @param path The swap path
     * @return price The token price in native token
     */
    function getTokenPrice(
        address quoter,
        address token,
        address native,
        bytes memory path
    ) external returns (uint256 price) {
        uint256 amount = 10 ** IERC20Metadata(token).decimals() / 10;
        if (token == native) return amount * 10;
        return IQuoter(quoter).quoteExactInput(path, amount) * 10;
    }

    /**
     * @notice Calculate range prices from ticks
     * @param tickLower Lower tick
     * @param tickUpper Upper tick
     * @return lowerPrice Lower range price
     * @return upperPrice Upper range price
     */
    function calculateRangePrices(
        int24 tickLower,
        int24 tickUpper
    ) external pure returns (uint256 lowerPrice, uint256 upperPrice) {
        uint160 sqrtPriceLower = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtPriceUpper = TickMath.getSqrtRatioAtTick(tickUpper);

        lowerPrice = FullMath.mulDiv(uint256(sqrtPriceLower), SQRT_PRECISION, (2 ** 96)) ** 2;
        upperPrice = FullMath.mulDiv(uint256(sqrtPriceUpper), SQRT_PRECISION, (2 ** 96)) ** 2;
    }
}
