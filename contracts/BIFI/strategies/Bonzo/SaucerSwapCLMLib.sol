// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20Metadata} from "@openzeppelin-4/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../../interfaces/saucerswap/IUniswapV3Pool.sol";
import "../../utils/LiquidityAmounts.sol";
import "../../utils/TickMath.sol";
import "../../utils/TickUtils.sol";
import "../../utils/Univ3Utils.sol";
import "../../utils/FullMath.sol";
import "../../interfaces/uniswap/IQuoter.sol";

library SaucerSwapCLMLib {
    using TickMath for int24;

    uint256 private constant PRECISION = 1e36;
    uint256 private constant SQRT_PRECISION = 1e18;
    int24 private constant MIN_TICK = -887272;
    int24 private constant MAX_TICK = 887272;
    address private constant HTS_PRECOMPILE = address(0x167);
    int256 private constant HTS_SUCCESS = 22;
    int256 private constant PRECOMPILE_BIND_ERROR = -1;
    uint256 private constant DURATION = 21600;

    struct Position {
        int24 tickLower;
        int24 tickUpper;
    }
    struct BalanceInfo {
        uint256 token0Bal;
        uint256 token1Bal;
        uint256 mainAmount0;
        uint256 mainAmount1;
        uint256 altAmount0;
        uint256 altAmount1;
    }
    struct StrategyStorage {
        IUniswapV3Pool pool;
        Position mainPosition;
        Position altPosition;
        address lpToken0;
        address lpToken1;
        bool useAltPosition;
    }

    function calculatePrice(uint160 sqrtPriceX96) external pure returns (uint256 _price) {
        uint256 scaledPrice = FullMath.mulDiv(uint256(sqrtPriceX96), SQRT_PRECISION, (2 ** 96));
        _price = FullMath.mulDiv(scaledPrice, scaledPrice, SQRT_PRECISION);
    }

    function getPoolPrice(address pool) external view returns (uint256 _price) {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        uint256 scaledPrice = FullMath.mulDiv(uint256(sqrtPriceX96), SQRT_PRECISION, (2 ** 96));
        _price = FullMath.mulDiv(scaledPrice, scaledPrice, SQRT_PRECISION);
    }

    function getPoolSqrtPrice(address pool) external view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
    }

    function getPoolSlot0(address pool) external view returns (uint160 sqrtPriceX96, int24 tick) {
        (sqrtPriceX96, tick, , , , , ) = IUniswapV3Pool(pool).slot0();
    }

    function getPoolFee(address pool) external view returns (uint256 fee) {
        fee = (uint256(IUniswapV3Pool(pool).fee()) * SQRT_PRECISION) / 1e6;
    }

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

    function calculatePositionTicks(
        int24 tick,
        int24 width,
        int24 distance
    ) external pure returns (int24 tickLower, int24 tickUpper) {
        int24 positionWidth = width * distance;
        (tickLower, tickUpper) = TickUtils.baseTicks(tick, positionWidth, distance);
    }

    function calculateAltTicks(
        int24 tick,
        int24 distance,
        bool isToken0
    ) external pure returns (int24 tickLower, int24 tickUpper) {
        if (isToken0) {
            tickLower = TickUtils.floor(tick, distance);
            tickUpper = tickLower + distance;
        } else {
            int24 tickFloor = TickUtils.floor(tick, distance);
            tickUpper = tickFloor + distance;
            tickLower = tickUpper - distance;
        }
    }

    function getTwap(address pool, uint32 twapInterval) external view returns (int56 twapTick) {
        uint32[] memory secondsAgo = new uint32[](2);
        secondsAgo[0] = twapInterval;
        secondsAgo[1] = 0;

        (int56[] memory tickCuml, ) = IUniswapV3Pool(pool).observe(secondsAgo);
        twapTick = (tickCuml[1] - tickCuml[0]) / int32(twapInterval);
    }

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

    function pathToRoute(bytes memory path) external pure returns (address[] memory route) {
        if (path.length == 0) return new address[](0);
        return UniV3Utils.pathToRoute(path);
    }

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

    function calculateRangePrices(
        int24 tickLower,
        int24 tickUpper
    ) external pure returns (uint256 lowerPrice, uint256 upperPrice) {
        uint160 sqrtPriceLower = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtPriceUpper = TickMath.getSqrtRatioAtTick(tickUpper);

        uint256 scaledLowerPrice = FullMath.mulDiv(uint256(sqrtPriceLower), SQRT_PRECISION, (2 ** 96));
        uint256 scaledUpperPrice = FullMath.mulDiv(uint256(sqrtPriceUpper), SQRT_PRECISION, (2 ** 96));
        lowerPrice = FullMath.mulDiv(scaledLowerPrice, scaledLowerPrice, SQRT_PRECISION);
        upperPrice = FullMath.mulDiv(scaledUpperPrice, scaledUpperPrice, SQRT_PRECISION);
    }
    function checkAmounts(uint256 amount0, uint256 amount1) external pure returns (bool) {
        return amount0 > 0 && amount1 > 0;
    }
    function safeAssociateToken(address token) external returns (bool success) {
        (bool result, bytes memory response) = HTS_PRECOMPILE.call(abi.encodeWithSignature("associateToken(address,address)", address(this), token));
        success = result && response.length > 0 && abi.decode(response, (int256)) == HTS_SUCCESS;
    }
    function transferHTS(address token, address to, uint256 amount) external {
        // WHBAR and other ERC20-compatible tokens should use standard ERC20 transfer
        // while pure HTS tokens use the precompile
        try IERC20Metadata(token).transfer(to, amount) returns (bool success) {
            require(success, "Token transfer failed");
        } catch {
            // Fallback to HTS precompile for pure HTS tokens
            (bool success,) = HTS_PRECOMPILE.call(abi.encodeWithSignature("transferToken(address,address,address,int64)", token, address(this), to, int64(uint64(amount))));
            require(success, "HTS transfer failed");
        }
    }

    function validatePreMintConditions(
        address pool,
        uint32 twapInterval,
        int56 maxTickDeviation,
        uint160 currentSqrtPrice,
        uint256 bal0,
        uint256 bal1
    ) external view {
        require(bal0 != 0 || bal1 != 0, "Invalid input");
        
        (, int24 tick, , , , , ) = IUniswapV3Pool(pool).slot0();
        uint32[] memory secondsAgo = new uint32[](2);
        secondsAgo[0] = twapInterval;
        secondsAgo[1] = 0;
        (int56[] memory tickCuml, ) = IUniswapV3Pool(pool).observe(secondsAgo);
        int56 twapTick = (tickCuml[1] - tickCuml[0]) / int32(twapInterval);
        int56 deviation = tick > twapTick ? tick - twapTick : twapTick - tick;
        require(deviation <= maxTickDeviation, "Not calm");
        
        uint160 sqrtPriceTWAP = TickMath.getSqrtRatioAtTick(int24(twapTick));
        uint256 priceDeviation;
        
        if (currentSqrtPrice > sqrtPriceTWAP) {
            priceDeviation = ((currentSqrtPrice - sqrtPriceTWAP) * 10000) / sqrtPriceTWAP;
        } else {
            priceDeviation = ((sqrtPriceTWAP - currentSqrtPrice) * 10000) / sqrtPriceTWAP;
        }
        
        require(priceDeviation <= uint256(int256(maxTickDeviation)), "Price deviation too high");
    }

    function validateMintSlippage(
        uint256 amount0,
        uint256 amount1,
        uint256 expectedAmount0,
        uint256 expectedAmount1,
        uint256 tolerance,
        uint256 bal0,
        uint256 bal1
    ) external pure {
        uint256 maxAmount0 = expectedAmount0 + ((expectedAmount0 * tolerance) / 10000);
        uint256 maxAmount1 = expectedAmount1 + ((expectedAmount1 * tolerance) / 10000);
        
        require(amount0 <= maxAmount0 && amount1 <= maxAmount1, "Mint slippage exceeded");
        require(amount0 <= bal0 && amount1 <= bal1, "Insufficient balance");
    }

    function calculateLiquidityWithPriceCheck(
        address pool,
        uint160 initialSqrtPrice,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0,
        uint256 amount1,
        uint256 priceDeviationTolerance
    ) external view returns (uint128 liquidity, uint160 adjustedSqrtPrice) {
        (adjustedSqrtPrice, , , , , , ) = IUniswapV3Pool(pool).slot0();
        uint256 priceDeviation;
        
        if (adjustedSqrtPrice > initialSqrtPrice) {
            priceDeviation = ((adjustedSqrtPrice - initialSqrtPrice) * 10000) / initialSqrtPrice;
        } else {
            priceDeviation = ((initialSqrtPrice - adjustedSqrtPrice) * 10000) / initialSqrtPrice;
        }
        
        if (priceDeviation > priceDeviationTolerance) {
            (adjustedSqrtPrice, , , , , , ) = IUniswapV3Pool(pool).slot0();
        } else {
            adjustedSqrtPrice = initialSqrtPrice;
        }
        
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            adjustedSqrtPrice,
            TickMath.getSqrtRatioAtTick(tickLower),
            TickMath.getSqrtRatioAtTick(tickUpper),
            amount0,
            amount1
        );
    }
}
