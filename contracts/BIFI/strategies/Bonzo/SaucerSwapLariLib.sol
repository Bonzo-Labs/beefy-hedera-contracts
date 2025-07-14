// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20Metadata} from "@openzeppelin-4/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../interfaces/uniswap/IQuoter.sol";
import "./SaucerSwapCLMLib.sol";
import {IUniswapV3Pool} from "../../interfaces/saucerswap/IUniswapV3Pool.sol";
import "../../utils/LiquidityAmounts.sol";
import "../../utils/TickMath.sol";
import "../../utils/TickUtils.sol";
import "../../utils/FullMath.sol";
import "../../utils/UniswapV3Utils.sol";
import "../../Hedera/IWHBAR.sol";
import {AddressUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";

library SaucerSwapLariLib {
    using SafeERC20 for IERC20Metadata;

    address private constant HTS_PRECOMPILE = address(0x167);
    int256 private constant HTS_SUCCESS = 22;

    struct RewardToken {
        address token;
        bool isHTS;
        bool isActive;
        address[] toLp0Route;
        address[] toLp1Route;
    }

    struct FeeParams {
        address callFeeRecipient;
        address strategist;
        address beefyFeeRecipient;
        uint256 amount0;
        uint256 amount1;
        uint256 feeTotal;
        uint256 feeCall;
        uint256 feeStrategist;
        uint256 divisor;
        address native;
        address quoter;
        address lpToken0;
        address lpToken1;
    }


    function processRewardTokens(
        address[] memory rewardTokens,
        address unirouter,
        address native
    ) external returns (uint256 totalNative) {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address reward = rewardTokens[i];
            uint256 rewardBal = IERC20Metadata(reward).balanceOf(address(this));
            if (rewardBal > 0) {
                if (reward == native) {
                    totalNative += rewardBal;
                } else {
                    uint256 nativeBefore = IERC20Metadata(native).balanceOf(address(this));
                    bytes memory path = abi.encodePacked(reward, uint24(3000), native);
                    IERC20Metadata(reward).approve(unirouter, rewardBal);
                    UniswapV3Utils.swap(unirouter, path, rewardBal);
                    uint256 nativeAfter = IERC20Metadata(native).balanceOf(address(this));
                    totalNative += nativeAfter - nativeBefore;
                }
            }
        }
    }

    function giveRewardAllowances(
        address[] memory rewardTokens,
        address spender,
        address native
    ) external {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address reward = rewardTokens[i];
            if (reward != native) {
                try IERC20Metadata(reward).approve(spender, type(uint256).max) {} catch {}
            }
        }
    }

    function removeRewardAllowances(
        address[] memory rewardTokens,
        address spender,
        address native
    ) external {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address reward = rewardTokens[i];
            if (reward != native) {
                IERC20Metadata(reward).approve(spender, 0);
            }
        }
    }

    function transferTokens(address token, address to, uint256 amount, address native) internal {
        if (amount == 0) return;
        SaucerSwapCLMLib.transferHTS(token, to, amount);
       
        // bool isNative = (token == native);
        // if (isNative) {
        //     // Use safe native transfer for HBAR (only used for mint fees in strategies)
        //     AddressUpgradeable.sendValue(payable(to), amount);
        // } else {
        //     // All other tokens (including WHBAR) are treated as standard ERC20/HTS tokens
        //     // WHBAR conversion is handled exclusively by the vault
        //     SaucerSwapCLMLib.transferHTS(token, to, amount);
        // }
    }

    function swapRewardToNative(
        address unirouter,
        address rewardToken,
        address native,
        uint256 rewardAmount
    ) internal returns (uint256 nativeAmount) {
        if (rewardAmount == 0 || rewardToken == native) {
            return rewardAmount;
        }
        
        bytes memory path = abi.encodePacked(rewardToken, uint24(3000), native);
        return UniswapV3Utils.swap(unirouter, path, rewardAmount);
    }

    function swapReward(uint256 amount, address[] memory route, address unirouter) internal {
        if (amount == 0 || route.length < 2) return;
        address tokenIn = route[0];
        address tokenOut = route[route.length - 1];
        
        if (tokenIn == tokenOut) return;
        
        // Create fee array (3000 = 0.3% tier for all hops)
        uint24[] memory fees = new uint24[](route.length - 1);
        for (uint i = 0; i < fees.length; i++) {
            fees[i] = 3000;
        }
        
        bytes memory path = UniswapV3Utils.routeToPath(route, fees);
        UniswapV3Utils.swap(unirouter, path, amount);
    }

    function associateRewardTokens(
        address[] memory rewardTokens,
        address native
    ) external {
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            address reward = rewardTokens[i];
            if (reward != native) {
                SaucerSwapCLMLib.safeAssociateToken(reward);
            }
        }
    }

    function calculateFeesLeft(
        uint256 amount0,
        uint256 amount1,
        uint256 feeTotal,
        uint256 divisor
    ) external pure returns (uint256 amountLeft0, uint256 amountLeft1) {
        amountLeft0 = amount0 > 0 ? amount0 - ((amount0 * feeTotal) / divisor) : 0;
        amountLeft1 = amount1 > 0 ? amount1 - ((amount1 * feeTotal) / divisor) : 0;
    }
    
    function calculateLPTokenFees(
        uint256 amount0,
        uint256 amount1,
        uint256 feeTotal,
        uint256 divisor
    ) external pure returns (uint256 feeAmount0, uint256 feeAmount1) {
        feeAmount0 = amount0 > 0 ? (amount0 * feeTotal) / divisor : 0;
        feeAmount1 = amount1 > 0 ? (amount1 * feeTotal) / divisor : 0;
    }

    function distributeLPTokenFees(
        address callFeeRecipient,
        address strategist,
        address beefyFeeRecipient,
        uint256 feeAmount0,
        uint256 feeAmount1,
        uint256 feeCall,
        uint256 feeStrategist,
        uint256 divisor,
        address lpToken0,
        address lpToken1,
        address native
    ) external {
        if (feeAmount0 > 0) {
            uint256 callFee0 = (feeAmount0 * feeCall) / divisor;
            uint256 strategistFee0 = (feeAmount0 * feeStrategist) / divisor;
            uint256 beefyFee0 = feeAmount0 - callFee0 - strategistFee0;
            
            if (callFee0 > 0) transferTokens(lpToken0, callFeeRecipient, callFee0, native);
            if (strategistFee0 > 0) transferTokens(lpToken0, strategist, strategistFee0, native);
            if (beefyFee0 > 0) transferTokens(lpToken0, beefyFeeRecipient, beefyFee0, native);
        }
        
        if (feeAmount1 > 0) {
            uint256 callFee1 = (feeAmount1 * feeCall) / divisor;
            uint256 strategistFee1 = (feeAmount1 * feeStrategist) / divisor;
            uint256 beefyFee1 = feeAmount1 - callFee1 - strategistFee1;
            
            if (callFee1 > 0) transferTokens(lpToken1, callFeeRecipient, callFee1, native);
            if (strategistFee1 > 0) transferTokens(lpToken1, strategist, strategistFee1, native);
            if (beefyFee1 > 0) transferTokens(lpToken1, beefyFeeRecipient, beefyFee1, native);
        }
    }




    function processLariRewards(
        RewardToken[] storage rewardTokens,
        address unirouter,
        address lpToken0,
        address lpToken1,
        address native,
        IWHBAR whbarContract
    ) external returns (uint256 fees0, uint256 fees1) {
        // Check if any reward tokens have routes set
        bool hasRoutes = false;
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            if (
                rewardTokens[i].isActive &&
                (rewardTokens[i].toLp0Route.length > 1 || rewardTokens[i].toLp1Route.length > 1)
            ) {
                hasRoutes = true;
                break;
            }
        }
        if (!hasRoutes) return (0, 0); // Skip processing if no routes

        for (uint256 i = 0; i < rewardTokens.length; i++) {
            RewardToken storage rewardToken = rewardTokens[i];
            if (!rewardToken.isActive) continue;
            uint256 balance = 0;
            if(rewardToken.token == native){
                balance = address(this).balance - msg.value;
                //wrap
                IERC20Metadata(native).approve(unirouter, balance);
                IWHBAR(whbarContract).deposit{value: balance}(address(this), address(this));
            }else{
                balance = IERC20Metadata(rewardToken.token).balanceOf(address(this));
            }
            
            if (balance == 0) continue;
            IERC20Metadata(rewardToken.token).approve(unirouter, balance);

            // Swap rewards to LP tokens
            if (rewardToken.token != lpToken0 && rewardToken.toLp0Route.length > 1) {
                uint256 balanceBefore = IERC20Metadata(lpToken0).balanceOf(address(this));
                // IERC20Metadata(rewardToken.token).approve(unirouter, balance / 2);
                swapReward(balance / 2, rewardToken.toLp0Route, unirouter);
                uint256 balanceAfter = IERC20Metadata(lpToken0).balanceOf(address(this));
                fees0 += balanceAfter - balanceBefore;
            }
            if (rewardToken.token != lpToken1 && rewardToken.toLp1Route.length > 1) {
                uint256 balanceBefore = IERC20Metadata(lpToken1).balanceOf(address(this));
                // IERC20Metadata(rewardToken.token).approve(unirouter, balance / 2);
                swapReward(balance / 2, rewardToken.toLp1Route, unirouter);
                uint256 balanceAfter = IERC20Metadata(lpToken1).balanceOf(address(this));
                fees1 += balanceAfter - balanceBefore;
            }
        }
    }

    function addRewardToken(
        RewardToken[] storage rewardTokens,
        mapping(address => uint256) storage rewardTokenIndex,
        mapping(address => bool) storage isRewardToken,
        address _token,
        bool _isHTS,
        address lpToken0,
        address lpToken1
    ) external {
        require(_token != address(0), "Invalid token");
        rewardTokens.push(
            RewardToken({
                token: _token,
                isHTS: _isHTS,
                isActive: true,
                toLp0Route: new address[](0),
                toLp1Route: new address[](0)
            })
        );
        rewardTokenIndex[_token] = rewardTokens.length - 1;
        isRewardToken[_token] = true;
        
        // Associate HTS token if needed
        if (_isHTS && _token != lpToken0 && _token != lpToken1) {
            SaucerSwapCLMLib.safeAssociateToken(_token);
        }
    }

    function updateRewardTokenStatus(
        RewardToken[] storage rewardTokens,
        mapping(address => uint256) storage rewardTokenIndex,
        mapping(address => bool) storage isRewardToken,
        address _token,
        bool _isActive
    ) external {
        require(isRewardToken[_token], "Token not found");
        uint256 index = rewardTokenIndex[_token];
        rewardTokens[index].isActive = _isActive;
    }

    function setRewardRoute(
        RewardToken[] storage rewardTokens,
        mapping(address => uint256) storage rewardTokenIndex,
        mapping(address => bool) storage isRewardToken,
        address _token,
        address[] calldata _toLp0Route,
        address[] calldata _toLp1Route
    ) external {
        require(isRewardToken[_token], "Token not found");
        uint256 index = rewardTokenIndex[_token];
        rewardTokens[index].toLp0Route = _toLp0Route;
        rewardTokens[index].toLp1Route = _toLp1Route;
    }

    function removeRewardToken(
        RewardToken[] storage rewardTokens,
        mapping(address => uint256) storage rewardTokenIndex,
        mapping(address => bool) storage isRewardToken,
        address _token
    ) external {
        require(isRewardToken[_token], "Token not found");
        uint256 index = rewardTokenIndex[_token];
        rewardTokens[index].isActive = false;
    }

    function quoteLpTokenToNativePrice(
        address lpToken,
        address native,
        address quoter,
        uint8 decimals
    ) external returns (uint256) {
        uint256 amount = 10 ** decimals / 10;
        if (lpToken == native) return amount * 10;
        
        // For SaucerSwap, we can use a simple direct path since it's based on UniswapV3
        bytes memory path = abi.encodePacked(lpToken, uint24(3000), native);
        try IQuoter(quoter).quoteExactInput(path, amount) returns (uint256 amountOut) {
            return amountOut * 10;
        } catch {
            // If quoter fails, return 0 to indicate unavailable price
            return 0;
        }
    }

    function giveAllowances(
        address lpToken0,
        address lpToken1,
        address native,
        address unirouter,
        RewardToken[] storage rewardTokens
    ) external {
        // Skip if unirouter is zero address (not used in LARI strategies)
        if (unirouter == address(0)) return;
        
        // Only approve non-native tokens (HTS tokens need ERC20 approvals for swapping)
        if (lpToken0 != native) {
            IERC20Metadata(lpToken0).approve(unirouter, type(uint256).max);
        }
        if (lpToken1 != native) {
            IERC20Metadata(lpToken1).approve(unirouter, type(uint256).max);
        }
        // Give allowances for reward tokens
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            if (rewardTokens[i].isActive && rewardTokens[i].token != native) {
                IERC20Metadata(rewardTokens[i].token).approve(unirouter, type(uint256).max);
            }
        }
    }

    function safeGiveAllowances(
        address lpToken0,
        address lpToken1,
        address native,
        address unirouter,
        RewardToken[] storage rewardTokens
    ) external {
        // Skip if unirouter is zero address (not used in LARI strategies)
        if (unirouter == address(0)) return;
        
        // Only approve non-native tokens (HTS tokens need ERC20 approvals for swapping)
        if (lpToken0 != native) {
            try IERC20Metadata(lpToken0).approve(unirouter, type(uint256).max) {
                // Approval succeeded
            } catch {
                // Approval failed - continue anyway
            }
        }
        if (lpToken1 != native) {
            try IERC20Metadata(lpToken1).approve(unirouter, type(uint256).max) {
                // Approval succeeded
            } catch {
                // Approval failed - continue anyway
            }
        }
        // Give allowances for reward tokens
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            if (rewardTokens[i].isActive && rewardTokens[i].token != native) {
                try IERC20Metadata(rewardTokens[i].token).approve(unirouter, type(uint256).max) {
                    // Approval succeeded
                } catch {
                    // Approval failed - continue anyway
                }
            }
        }
    }

    function removeAllowances(
        address lpToken0,
        address lpToken1,
        address native,
        address unirouter,
        RewardToken[] storage rewardTokens
    ) external {
        // Skip if unirouter is zero address (not used in LARI strategies)
        if (unirouter == address(0)) return;
        
        // Only revoke approvals for non-native tokens
        if (lpToken0 != native) {
            IERC20Metadata(lpToken0).approve(unirouter, 0);
        }
        if (lpToken1 != native) {
            IERC20Metadata(lpToken1).approve(unirouter, 0);
        }
        // Remove allowances for reward tokens
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            if (rewardTokens[i].token != native) {
                IERC20Metadata(rewardTokens[i].token).approve(unirouter, 0);
            }
        }
    }

    function claimMainPositionFees(
        address pool,
        int24 tickLower,
        int24 tickUpper,
        address strategy
    ) external returns (uint256 fee0, uint256 fee1) {
        bytes32 key = keccak256(abi.encodePacked(strategy, tickLower, tickUpper));
        IUniswapV3Pool poolContract = IUniswapV3Pool(pool);
        
        (uint128 liquidity, , , , ) = poolContract.positions(key);
        if (liquidity > 0) poolContract.burn(tickLower, tickUpper, 0);
        (fee0, fee1) = poolContract.collect(strategy, tickLower, tickUpper, type(uint128).max, type(uint128).max);
    }

    function claimAltPositionFees(
        address pool,
        int24 tickLower,
        int24 tickUpper,
        address strategy
    ) external returns (uint256 fee0, uint256 fee1) {
        bytes32 key = keccak256(abi.encodePacked(strategy, tickLower, tickUpper));
        IUniswapV3Pool poolContract = IUniswapV3Pool(pool);
        
        (uint128 liquidity, , , , ) = poolContract.positions(key);
        if (liquidity > 0) poolContract.burn(tickLower, tickUpper, 0);
        (fee0, fee1) = poolContract.collect(strategy, tickLower, tickUpper, type(uint128).max, type(uint128).max);
    }

    function setMainTick(int24 tick, int24 distance, int24 width) external pure returns (int24 tickLower, int24 tickUpper) {
        return TickUtils.baseTicks(tick, width, distance);
    }

    function setAltTick(
        int24 tick,
        int24 distance,
        int24 width,
        uint256 bal0,
        uint256 bal1,
        uint256 poolPrice,
        uint256 precision
    ) external pure returns (int24 tickLower, int24 tickUpper) {
        // We calculate how much token0 we have in the price of token1.
        uint256 amount0;
        if (bal0 > 0) {
            amount0 = FullMath.mulDiv(bal0, poolPrice, precision);
        }
        // We set the alternative position based on the token that has the most value available.
        if (amount0 < bal1) {
            (tickLower, ) = TickUtils.baseTicks(tick, width, distance);
            (tickUpper, ) = TickUtils.baseTicks(tick, distance, distance);
        } else if (bal1 < amount0) {
            (, tickLower) = TickUtils.baseTicks(tick, distance, distance);
            (, tickUpper) = TickUtils.baseTicks(tick, width, distance);
        } else {
            // Default case when both balances are 0 or equal - set alt position to token0 side (different from main)
            (, tickLower) = TickUtils.baseTicks(tick, distance, distance);
            (, tickUpper) = TickUtils.baseTicks(tick, width, distance);
        }
    }

    function getMainPositionAmounts(
        address pool,
        address strategy,
        int24 tickLower,
        int24 tickUpper,
        bool initTicks
    ) external view returns (uint256 amount0, uint256 amount1) {
        if (!initTicks) return (0, 0);
        
        bytes32 key = keccak256(abi.encodePacked(strategy, tickLower, tickUpper));
        IUniswapV3Pool poolContract = IUniswapV3Pool(pool);
        
        (uint128 liquidity, , , uint256 owed0, uint256 owed1) = poolContract.positions(key);
        uint160 sqrtPrice = SaucerSwapCLMLib.getPoolSqrtPrice(pool);
        
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPrice,
            TickMath.getSqrtRatioAtTick(tickLower),
            TickMath.getSqrtRatioAtTick(tickUpper),
            liquidity
        );
        amount0 += owed0;
        amount1 += owed1;
    }

    function getAltPositionAmounts(
        address pool,
        address strategy,
        int24 tickLower,
        int24 tickUpper,
        bool initTicks
    ) external view returns (uint256 amount0, uint256 amount1) {
        if (!initTicks) return (0, 0);
        
        bytes32 key = keccak256(abi.encodePacked(strategy, tickLower, tickUpper));
        IUniswapV3Pool poolContract = IUniswapV3Pool(pool);
        
        (uint128 liquidity, , , uint256 owed0, uint256 owed1) = poolContract.positions(key);
        uint160 sqrtPrice = SaucerSwapCLMLib.getPoolSqrtPrice(pool);
        
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPrice,
            TickMath.getSqrtRatioAtTick(tickLower),
            TickMath.getSqrtRatioAtTick(tickUpper),
            liquidity
        );
        amount0 += owed0;
        amount1 += owed1;
    }
}