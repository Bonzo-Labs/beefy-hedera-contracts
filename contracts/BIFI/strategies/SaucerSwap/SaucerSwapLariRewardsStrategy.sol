// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import "./StrategyCommonSaucerSwap.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../utils/UniswapV3Utils.sol";

contract SaucerSwapLariRewardsStrategy is StrategyCommonSaucerSwap {
    using SafeERC20 for IERC20;

    // Dynamic reward tokens structure
    struct RewardToken {
        address token;
        bool isHTS;
        bool isActive;
        address[] toLp0Route;
        address[] toLp1Route;
    }

    // Array of reward tokens
    RewardToken[] public rewardTokens;
    
    // Mapping for quick lookup
    mapping(address => uint256) private rewardTokenIndex;
    mapping(address => bool) private isRewardToken;

    // Keep original variables for backward compatibility
    bool private isLp0HTS = true;
    bool private isLp1HTS = true;

    event LariHarvested(address indexed rewardToken, uint256 amount);
    event RewardTokenAdded(address indexed token, bool isHTS);
    event RewardTokenRemoved(address indexed token);
    event RewardTokenUpdated(address indexed token, bool isActive);

    function initialize(
        address _lpToken0,
        address _lpToken1,
        address[] calldata _rewardTokens,
        address _positionManager,
        address _poolFactory,
        uint24 _poolFee,
        address[] calldata _lp0ToNativeRoute,
        address[] calldata _lp1ToNativeRoute,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        StrategyCommonSaucerSwap.__common_init(
            _lpToken0,
            _lpToken1,
            _positionManager,
            _poolFactory,
            _poolFee,
            _lp0ToNativeRoute,
            _lp1ToNativeRoute,
            isLp0HTS,
            isLp1HTS,
            _commonAddresses
        );
        
        // Initialize reward tokens
        for (uint256 i = 0; i < _rewardTokens.length; i++) {
            _addRewardToken(_rewardTokens[i], true); // Assume all are HTS initially
        }
    }

    function harvest() external override {
        _harvestLariRewards(tx.origin);
    }

    function harvest(address callFeeRecipient) external override {
        _harvestLariRewards(callFeeRecipient);
    }

    function _harvestLariRewards(address callFeeRecipient) internal {
        //collect fees
        INonfungiblePositionManager.CollectParams memory params = INonfungiblePositionManager.CollectParams({
            tokenSN: nftTokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        });
        (uint256 amount0, uint256 amount1) = INonfungiblePositionManager(positionManager).collect(params);
        if(amount0 > 0 && isLpToken0Native) {
            //unwrapp
            uint256 balanceBefore = address(this).balance;
            IERC20(lpToken0).approve(address(_whbarContract), amount0);
            IWHBAR(_whbarContract).withdraw(address(this),address(this),amount0);
            amount0 = address(this).balance - balanceBefore;
        }
        if(amount1 > 0 && isLpToken1Native) {
            //unwrapp
            uint256 balanceBefore = address(this).balance;
            IERC20(lpToken1).approve(address(_whbarContract), amount1);
            IWHBAR(_whbarContract).withdraw(address(this),address(this),amount1);
            amount1 = address(this).balance - balanceBefore;
        }
        // Check if any reward tokens have routes set
        bool hasRoutes = false;
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            if (rewardTokens[i].isActive && 
                (rewardTokens[i].toLp0Route.length > 1 || rewardTokens[i].toLp1Route.length > 1)) {
                hasRoutes = true;
                break;
            }
        }
        require(hasRoutes, "No routes");

        // Process each active reward token
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            RewardToken storage rewardToken = rewardTokens[i];
            if (!rewardToken.isActive) continue;

            uint256 balance = IERC20(rewardToken.token).balanceOf(address(this));
            if (balance == 0) continue;

            emit LariHarvested(rewardToken.token, balance);

            // Swap rewards to LP tokens
            if (rewardToken.token != lpToken0 && rewardToken.toLp0Route.length > 1) {
                uint256 balanceBefore = IERC20(lpToken0).balanceOf(address(this));
                IERC20(rewardToken.token).approve(address(saucerSwapRouter), balance / 2);
                _swap(balance / 2, rewardToken.toLp0Route);
                uint256 balanceAfter = IERC20(lpToken0).balanceOf(address(this));
                amount0 += balanceAfter - balanceBefore;
            }
            if (rewardToken.token != lpToken1 && rewardToken.toLp1Route.length > 1) {
                uint256 balanceBefore = IERC20(lpToken1).balanceOf(address(this));
                IERC20(rewardToken.token).approve(address(saucerSwapRouter), balance / 2);
                _swap(balance / 2, rewardToken.toLp1Route);
                uint256 balanceAfter = IERC20(lpToken1).balanceOf(address(this));
                amount1 += balanceAfter - balanceBefore;
            }
        }

        // Add liquidity with new LP token balances

        chargeFees(callFeeRecipient, amount0, amount1);
        deposit();

        lastHarvest = block.timestamp;
    }

    function _swap(uint256 amount, address[] memory route) internal {
        if (amount == 0 || route.length < 2) return;
        uint24[] memory fees = getFeeTier(route.length - 1);
        bytes memory path = UniswapV3Utils.routeToPath(route, fees);
        UniswapV3Utils.swap(saucerSwapRouter, path, amount);
    }

    /**
     * @dev Add a new reward token
     */
    function addRewardToken(address _token, bool _isHTS) external onlyManager {
        require(!isRewardToken[_token], "Token exists");
        _addRewardToken(_token, _isHTS);
    }

    function _addRewardToken(address _token, bool _isHTS) internal {
        require(_token != address(0), "Inv token");
        
        rewardTokens.push(RewardToken({
            token: _token,
            isHTS: _isHTS,
            isActive: true,
            toLp0Route: new address[](0),
            toLp1Route: new address[](0)
        }));
        
        rewardTokenIndex[_token] = rewardTokens.length - 1;
        isRewardToken[_token] = true;
        
        // Associate HTS token if needed
        if (_isHTS && _token != lpToken0 && _token != lpToken1) {
            _associateToken(_token);
        }
        
        emit RewardTokenAdded(_token, _isHTS);
    }


    /**
     * @dev Update reward token status
     */
    function updateRewardTokenStatus(address _token, bool _isActive) external onlyManager {
        require(isRewardToken[_token], "Token not found");
        uint256 index = rewardTokenIndex[_token];
        rewardTokens[index].isActive = _isActive;
        emit RewardTokenUpdated(_token, _isActive);
    }

    /**
     * @dev Set swap routes for multiple reward tokens at once
     * @param _token Reward token address
     * @param _toLp0Route Array of routes to LP token 0
     * @param _toLp1Route Array of routes to LP token 1
     */
    function setRewardRoute(
        address _token,
        address[] calldata _toLp0Route,
        address[] calldata _toLp1Route
    ) external onlyManager {
        require(isRewardToken[_token], "Token not found");
        uint256 index = rewardTokenIndex[_token];
        rewardTokens[index].toLp0Route = _toLp0Route;
        rewardTokens[index].toLp1Route = _toLp1Route;
    }


    function removeRewardToken(address _token) external onlyManager {
        require(isRewardToken[_token], "Token not found");
        uint256 index = rewardTokenIndex[_token];
        rewardTokens[index].isActive = false;
        emit RewardTokenRemoved(_token);
    }

}
