// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

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
    mapping(address => uint256) public rewardTokenIndex;
    mapping(address => bool) public isRewardToken;

    // Keep original variables for backward compatibility
    bool public isLp0HTS = true;
    bool public isLp1HTS = true;

    event LariHarvested(address indexed rewardToken, uint256 amount);
    event RewardTokenAdded(address indexed token, bool isHTS);
    event RewardTokenRemoved(address indexed token);
    event RewardTokenUpdated(address indexed token, bool isActive);

    function initialize(
        address _lpToken0,
        address _lpToken1,
        address[] calldata _rewardTokens,
        // address _pool,
        address _positionManager,
        address _poolFactory,
        uint24 _poolFee,
        address[] calldata _lp0ToNativeRoute,
        address[] calldata _lp1ToNativeRoute,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        StrategyCommonSaucerSwap.initialize(
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
        // Check if any reward tokens have routes set
        bool hasRoutes = false;
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            if (rewardTokens[i].isActive && 
                (rewardTokens[i].toLp0Route.length > 1 || rewardTokens[i].toLp1Route.length > 1)) {
                hasRoutes = true;
                break;
            }
        }
        require(hasRoutes, "No reward routes configured");

        // Process each active reward token
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            RewardToken storage rewardToken = rewardTokens[i];
            if (!rewardToken.isActive) continue;

            uint256 balance = IERC20(rewardToken.token).balanceOf(address(this));
            if (balance == 0) continue;

            emit LariHarvested(rewardToken.token, balance);

            // Swap rewards to LP tokens
            if (rewardToken.token != lpToken0 && rewardToken.toLp0Route.length > 1) {
                _swap(rewardToken.token, balance / 2, rewardToken.toLp0Route);
            }
            if (rewardToken.token != lpToken1 && rewardToken.toLp1Route.length > 1) {
                _swap(rewardToken.token, balance / 2, rewardToken.toLp1Route);
            }
        }

        // Add liquidity with new LP token balances
        addLiquidity();

        lastHarvest = block.timestamp;
    }

    function _swap(address from, uint256 amount, address[] memory route) internal {
        if (amount == 0 || route.length < 2) return;
        uint24[] memory fees = getFeeTier(route.length - 1);
        bytes memory path = UniswapV3Utils.routeToPath(route, fees);
        UniswapV3Utils.swap(saucerSwapRouter, path, amount);
    }

    /**
     * @dev Add a new reward token
     */
    function addRewardToken(address _token, bool _isHTS) external onlyManager {
        require(!isRewardToken[_token], "Token already exists");
        _addRewardToken(_token, _isHTS);
    }

    function _addRewardToken(address _token, bool _isHTS) internal {
        require(_token != address(0), "Invalid token address");
        
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
        if (_isHTS) {
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
     * @param _tokens Array of reward token addresses
     * @param _toLp0Routes Array of routes to LP token 0 (each element is an array of addresses)
     * @param _toLp1Routes Array of routes to LP token 1 (each element is an array of addresses)
     */
    function setRewardRoutes(
        address[] calldata _tokens,
        address[][] calldata _toLp0Routes,
        address[][] calldata _toLp1Routes
    ) external onlyManager {
        require(_tokens.length == _toLp0Routes.length && _tokens.length == _toLp1Routes.length, "Array lengths must match");
        
        for (uint256 i = 0; i < _tokens.length; i++) {
            require(isRewardToken[_tokens[i]], "Token not found");
            uint256 index = rewardTokenIndex[_tokens[i]];
            rewardTokens[index].toLp0Route = _toLp0Routes[i];
            rewardTokens[index].toLp1Route = _toLp1Routes[i];
        }
    }


    /**
     * @dev Get all active reward tokens
     */
    function getActiveRewardTokens() external view returns (address[] memory) {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            if (rewardTokens[i].isActive) {
                activeCount++;
            }
        }
        
        address[] memory activeTokens = new address[](activeCount);
        uint256 currentIndex = 0;
        for (uint256 i = 0; i < rewardTokens.length; i++) {
            if (rewardTokens[i].isActive) {
                activeTokens[currentIndex] = rewardTokens[i].token;
                currentIndex++;
            }
        }
        return activeTokens;
    }


    function removeRewardToken(address _token) external onlyManager {
        require(isRewardToken[_token], "Token not found");
        uint256 index = rewardTokenIndex[_token];
        rewardTokens[index].isActive = false;
        emit RewardTokenRemoved(_token);
    }

    /**
     * @dev Get reward token info
     */
    function getRewardTokenInfo(address _token) external view returns (RewardToken memory) {
        require(isRewardToken[_token], "Token not found");
        return rewardTokens[rewardTokenIndex[_token]];
    }

    /**
     * @dev Get total number of reward tokens
     */
    function getRewardTokenCount() external view returns (uint256) {
        return rewardTokens.length;
    }

    /**
     * @dev Get reward token by index
     */
    function getRewardTokenByIndex(uint256 _index) external view returns (RewardToken memory) {
        require(_index < rewardTokens.length, "Index out of bounds");
        return rewardTokens[_index];
    }
}
