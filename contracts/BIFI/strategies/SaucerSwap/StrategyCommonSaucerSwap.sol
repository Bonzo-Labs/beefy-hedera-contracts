// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin-4/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";

import "../../interfaces/common/IUniswapRouterV3WithDeadline.sol";
import "../../interfaces/saucerswap/IUniswapV3Pool.sol";
import "../../interfaces/saucerswap/IUniswapV3Factory.sol";
import "../Common/StratFeeManagerInitializable.sol";
import "../../utils/GasFeeThrottler.sol";
import "../../utils/UniswapV3Utils.sol";
import "../../interfaces/saucerswap/INonfungiblePositionManager.sol";
import "../../Hedera/IHederaTokenService.sol";


contract StrategyCommonSaucerSwap is StratFeeManagerInitializable, GasFeeThrottler {
    using SafeERC20 for IERC20;
    using UniswapV3Utils for bytes;

    // Tokens used
    address public native;
    address public pool;
    address public lpToken0;
    address public lpToken1;

    // Third party contracts
    address public positionManager;
    address public saucerSwapRouter;
    address public poolFactory;
    uint24 public poolFee;
    bool public harvestOnDeposit;
    uint256 public lastHarvest;
    uint256 public nftTokenId;
    
    address[] public lp0ToNativeRoute;
    address[] public lp1ToNativeRoute;


    // Hedera specific
    address constant private HTS_PRECOMPILE = address(0x167);
    int64 constant private HTS_SUCCESS = 22;
    int64 constant private PRECOMPILE_BIND_ERROR = -2;
    bool public isLpToken0HTS;
    bool public isLpToken1HTS;

    // Constants
    uint256 public constant DEADLINE_BUFFER = 600; // 10 minutes
    uint256 public constant DIVISOR8 = 1e8;

    event StratHarvest(address indexed harvester, uint256 lp0Harvested, uint256 lp1Harvested);
    event Deposit(uint256 lp0Deposit, uint256 lp1Deposit);
    event Withdraw(uint256 lp0Withdraw, uint256 lp1Withdraw);
    event ChargedFees(uint256 callFees, uint256 beefyFees, uint256 strategistFees);
    event HTSTokenAssociated(address token, int64 responseCode);
    event HTSTokenDissociated(address token, int64 responseCode);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);

    function initialize(
        address _lpToken0,
        address _lpToken1,
        // address _pool,
        address _positionManager,
        // address _saucerSwapRouter,
        address _poolFactory,
        uint24 _poolFee,
        address[] calldata _lp0ToNativeRoute,
        address[] calldata _lp1ToNativeRoute,
        bool _isLpToken0HTS,
        bool _isLpToken1HTS,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        __StratFeeManager_init(_commonAddresses);
        poolFactory = _poolFactory;
        positionManager = _positionManager;
        saucerSwapRouter = _commonAddresses.unirouter;

        lpToken0 = _lpToken0;
        lpToken1 = _lpToken1;
        native = _lp0ToNativeRoute[_lp0ToNativeRoute.length - 1];
        lp0ToNativeRoute = _lp0ToNativeRoute;
        lp1ToNativeRoute = _lp1ToNativeRoute;
       
        isLpToken0HTS = _isLpToken0HTS;
        isLpToken1HTS = _isLpToken1HTS;

        poolFee = _poolFee;
        pool = IUniswapV3Factory(poolFactory).getPool(lpToken0, lpToken1, poolFee);

        // Associate HTS tokens if needed
        if (isLpToken0HTS) {
            _associateToken(lpToken0);
        }
        if (isLpToken1HTS) {
            _associateToken(lpToken1);
        }
        // Native is always HTS
        _associateToken(native);

        _giveAllowances();
    }

    /**
     * @dev Allow the contract to associate with an HTS token
     * @param token The HTS token address to associate with this contract
     */
    function _associateToken(address token) internal {
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        require(responseCode == HTS_SUCCESS, "HTS token association failed");
        emit HTSTokenAssociated(token, responseCode);
    }

    /**
     * @dev Allow the owner to manually associate this contract with an HTS token
     * @param token The HTS token address to associate with this contract
     */
    function associateToken(address token) external onlyManager {
        _associateToken(token);
    }

    /**
     * @dev Allow the owner to manually dissociate this contract from an HTS token
     * @param token The HTS token address to dissociate from this contract
     */
    function dissociateToken(address token) external onlyManager {
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.dissociateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        require(responseCode == HTS_SUCCESS, "HTS token dissociation failed");
        emit HTSTokenDissociated(token, responseCode);
    }

    /**
     * @dev Transfer tokens - uses HTS for HTS tokens, regular ERC20 for others
     * @param token The token to transfer
     * @param to Destination address
     * @param amount Amount to transfer
     * @param isHTS Whether the token is an HTS token
     */
    function _transferTokens(address token, address to, uint256 amount, bool isHTS) internal {
        if (isHTS) {
            (bool success, bytes memory result) = HTS_PRECOMPILE.call(
                abi.encodeWithSelector(IHederaTokenService.transferToken.selector, token, address(this), to, int64(uint64(amount)))
            );
            int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
            if (responseCode != HTS_SUCCESS) {
                emit HTSTokenTransferFailed(token, address(this), to, responseCode);
                revert("HTS token transfer failed");
            }
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // puts the funds to work
    function deposit() public whenNotPaused {
        uint256 lpToken0Bal = IERC20(lpToken0).balanceOf(address(this));
        uint256 lpToken1Bal = IERC20(lpToken1).balanceOf(address(this));

        if (lpToken0Bal > 0 || lpToken1Bal > 0) {
            addLiquidity();
            emit Deposit(lpToken0Bal, lpToken1Bal);
        }
    }

    function withdraw(uint256 _amount0, uint256 _amount1) external {
        require(msg.sender == vault, "!vault");

        uint256 lp0Bal = IERC20(lpToken0).balanceOf(address(this));
        uint256 lp1Bal = IERC20(lpToken1).balanceOf(address(this));
        uint256 withdrawalFeeAmount = 0;

        if (tx.origin != owner() && !paused()) {
            withdrawalFeeAmount = _amount0 * withdrawalFee / WITHDRAWAL_MAX;
            _amount0 = _amount0 - withdrawalFeeAmount;
        }

        if (lp0Bal < _amount0 || lp1Bal < _amount1) {
            // Get current position info
            (,,,int24 tickLower, int24 tickUpper, uint128 liquidity,,,,) = INonfungiblePositionManager(positionManager).positions(nftTokenId);
            
            // Calculate position value
            uint256 positionValue = balanceOfPool();

            // Calculate deficit for each token (how much more we need)
            uint256 deficit0 = lp0Bal >= _amount0 ? 0 : _amount0 - lp0Bal;
            uint256 deficit1 = lp1Bal >= _amount1 ? 0 : _amount1 - lp1Bal;

            // Calculate liquidity to decrease for each token
            uint256 liquidityForToken0 = deficit0 > 0 ? (liquidity * deficit0) / positionValue : 0;
            uint256 liquidityForToken1 = deficit1 > 0 ? (liquidity * deficit1) / positionValue : 0;

            // Take the maximum to ensure we get enough of both tokens
            uint256 liquidityToDecrease = liquidityForToken0 > liquidityForToken1 ? liquidityForToken0 : liquidityForToken1;
            
            // Decrease liquidity proportionally
            INonfungiblePositionManager.DecreaseLiquidityParams memory decreaseParams = INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenSN: nftTokenId,
                liquidity: uint128(liquidityToDecrease),
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp + DEADLINE_BUFFER
            });
            INonfungiblePositionManager(positionManager).decreaseLiquidity(decreaseParams);

            _harvest(tx.origin);
        }

        // Transfer tokens using appropriate method based on token type
        _transferTokens(lpToken0, vault, _amount0, isLpToken0HTS);
        _transferTokens(lpToken1, vault, _amount1, isLpToken1HTS);

        emit Withdraw(balanceOfToken0(), balanceOfToken1());
    }

    function beforeDeposit() external virtual override {
        if (harvestOnDeposit) {
            require(msg.sender == vault, "!vault");
            _harvest(tx.origin);
        }
    }

    function harvest() external gasThrottle virtual {
        _harvest(tx.origin);
    }

    function harvest(address callFeeRecipient) external gasThrottle virtual {
        _harvest(callFeeRecipient);
    }

    // function managerHarvest() external onlyManager {
    //     _harvest(tx.origin);
    // }

    // compounds earnings and charges performance fee
    function _harvest(address callFeeRecipient) internal whenNotPaused {
        // Collect fees from the position
        INonfungiblePositionManager.CollectParams memory params = INonfungiblePositionManager.CollectParams({
            tokenSN: nftTokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        });
        (uint256 amount0, uint256 amount1) = INonfungiblePositionManager(positionManager).collect(params);

        if (amount0 > 0 || amount1 > 0) {
            chargeFees(callFeeRecipient, amount0, amount1);
            addLiquidity();
            deposit();
            lastHarvest = block.timestamp;
            emit StratHarvest(msg.sender, balanceOfToken0(), balanceOfToken1());
        }
    }

    // performance fees
    function chargeFees(address callFeeRecipient, uint256 amount0, uint256 amount1) internal {
        IFeeConfig.FeeCategory memory fees = getFees();
        uint256 nativeBal = 0;
        
        // Swap token0 to native if it's not native
        if (amount0 > 0 && lpToken0 != native) {
            uint256 toNative0 = amount0 * fees.total / DIVISOR8;
            bytes memory path = UniswapV3Utils.routeToPath(lp0ToNativeRoute, getFeeTier(lp0ToNativeRoute.length - 1));
           
            UniswapV3Utils.swap(saucerSwapRouter, path, toNative0);
        } else if (amount0 > 0 && lpToken0 == native) {
            nativeBal += amount0 * fees.total / DIVISOR8;
        }
        
        // Swap token1 to native if it's not native
        if (amount1 > 0 && lpToken1 != native) {
            uint256 toNative1 = amount1 * fees.total / DIVISOR8;
            bytes memory path = UniswapV3Utils.routeToPath(lp1ToNativeRoute, getFeeTier(lp1ToNativeRoute.length - 1));
            UniswapV3Utils.swap(saucerSwapRouter, path, toNative1);
        } else if (amount1 > 0 && lpToken1 == native) {
            nativeBal += amount1 * fees.total / DIVISOR8;
        }

        nativeBal += IERC20(native).balanceOf(address(this));

        uint256 callFeeAmount = nativeBal * fees.call / DIVISOR8;
        _transferTokens(native, callFeeRecipient, callFeeAmount, true); // Native is always HTS

        uint256 beefyFeeAmount = nativeBal * fees.beefy / DIVISOR8;
        _transferTokens(native, beefyFeeRecipient, beefyFeeAmount, true); // Native is always HTS

        uint256 strategistFeeAmount = nativeBal * fees.strategist / DIVISOR8;
        _transferTokens(native, strategist, strategistFeeAmount, true); // Native is always HTS

        emit ChargedFees(callFeeAmount, beefyFeeAmount, strategistFeeAmount);
    }

    // Helper function to create fee array for a route
    function getFeeTier(uint256 routeLength) internal view returns (uint24[] memory) {
        uint24[] memory fees = new uint24[](routeLength);
        for (uint256 i = 0; i < routeLength; i++) {
            fees[i] = poolFee;
        }
        return fees;
    }

    // Adds liquidity to AMM using harvested tokens
    function addLiquidity() internal {
        uint256 lp0Bal = IERC20(lpToken0).balanceOf(address(this));
        uint256 lp1Bal = IERC20(lpToken1).balanceOf(address(this));

        // Add liquidity using SaucerSwap V3 router
        INonfungiblePositionManager.MintParams memory _params = INonfungiblePositionManager.MintParams({
            token0: lpToken0,
            token1: lpToken1,
            fee: poolFee,
            tickLower: -887220,
            tickUpper: 887220,
            amount0Desired: lp0Bal,
            amount1Desired: lp1Bal,
            amount0Min: 1,
            amount1Min: 1,
            recipient: address(this),
            deadline: block.timestamp + DEADLINE_BUFFER
        });

        if (nftTokenId == 0) {
            (nftTokenId,,,) = INonfungiblePositionManager(positionManager).mint(_params);
        } else {
            // If we already have a position, increase liquidity instead
            INonfungiblePositionManager.IncreaseLiquidityParams memory increaseParams = INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenSN: nftTokenId,
                amount0Desired: lp0Bal,
                amount1Desired: lp1Bal,
                amount0Min: 1,
                amount1Min: 1,
                deadline: block.timestamp + DEADLINE_BUFFER
            });
            INonfungiblePositionManager(positionManager).increaseLiquidity(increaseParams);
        }
    }

    // it calculates how much 'want' this contract holds.
    function balanceOfToken0() public view returns (uint256) {
        return IERC20(lpToken0).balanceOf(address(this));
    }

    function balanceOfToken1() public view returns (uint256) {  
        return IERC20(lpToken1).balanceOf(address(this));
    }

    // it calculates how much 'want' the strategy has working in the farm.
    function balanceOfPool() public view returns (uint256) {
        if (nftTokenId == 0) return 0;
        (,,,int24 tickLower, int24 tickUpper, uint128 liquidity,,,,) = INonfungiblePositionManager(positionManager).positions(nftTokenId);
        return uint256(liquidity);
    }

    function getPositionInfo() public view returns (address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1) {
        return INonfungiblePositionManager(positionManager).positions(nftTokenId);
    }

    function setHarvestOnDeposit(bool _harvestOnDeposit) external onlyManager {
        harvestOnDeposit = _harvestOnDeposit;
        if (harvestOnDeposit) {
            setWithdrawalFee(0);
        } else {
            setWithdrawalFee(10);
        }
    }

    function setShouldGasThrottle(bool _shouldGasThrottle) external onlyManager {
        shouldGasThrottle = _shouldGasThrottle;
    }

    // Update HTS status for tokens
    function updateTokenHTSStatus(bool _isLpToken0HTS, bool _isLpToken1HTS) external onlyManager {
        isLpToken0HTS = _isLpToken0HTS;
        isLpToken1HTS = _isLpToken1HTS;
    }

    // called as part of strat migration. Sends all the available funds back to the vault.
    function retireStrat() external {
        require(msg.sender == vault, "!vault");

        // First decrease liquidity
        (,,,int24 tickLower, int24 tickUpper, uint128 liquidity,,,,) = INonfungiblePositionManager(positionManager).positions(nftTokenId);
        
        INonfungiblePositionManager.DecreaseLiquidityParams memory decreaseParams = INonfungiblePositionManager.DecreaseLiquidityParams({
            tokenSN: nftTokenId,
            liquidity: liquidity,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + DEADLINE_BUFFER
        });
        INonfungiblePositionManager(positionManager).decreaseLiquidity(decreaseParams);

        // Then collect the tokens
        INonfungiblePositionManager.CollectParams memory collectParams = INonfungiblePositionManager.CollectParams({
            tokenSN: nftTokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        });
        INonfungiblePositionManager(positionManager).collect(collectParams);

        // Finally burn the NFT since we're removing all liquidity
        INonfungiblePositionManager(positionManager).burn(nftTokenId);
        nftTokenId = 0;

        // Transfer tokens back to vault using appropriate method
        uint256 lp0Bal = IERC20(lpToken0).balanceOf(address(this));
        uint256 lp1Bal = IERC20(lpToken1).balanceOf(address(this));
        
        _transferTokens(lpToken0, vault, lp0Bal, isLpToken0HTS);
        _transferTokens(lpToken1, vault, lp1Bal, isLpToken1HTS);
    }

    // pauses deposits and withdraws all funds from third party systems.
    function panic() public onlyManager {
        pause();
        
        // First decrease liquidity
        (,,,int24 tickLower, int24 tickUpper, uint128 liquidity,,,,) = INonfungiblePositionManager(positionManager).positions(nftTokenId);
        
        INonfungiblePositionManager.DecreaseLiquidityParams memory decreaseParams = INonfungiblePositionManager.DecreaseLiquidityParams({
            tokenSN: nftTokenId,
            liquidity: liquidity,
            amount0Min: 0,
            amount1Min: 0,
            deadline: block.timestamp + DEADLINE_BUFFER
        });
        INonfungiblePositionManager(positionManager).decreaseLiquidity(decreaseParams);

        // Then collect the tokens
        INonfungiblePositionManager.CollectParams memory collectParams = INonfungiblePositionManager.CollectParams({
            tokenSN: nftTokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        });
        INonfungiblePositionManager(positionManager).collect(collectParams);

        // Finally burn the NFT since we're removing all liquidity
        INonfungiblePositionManager(positionManager).burn(nftTokenId);
        nftTokenId = 0;
    }

    function pause() public onlyManager {
        _pause();

        _removeAllowances();
    }

    function unpause() external onlyManager {
        _unpause();

        _giveAllowances();

        deposit();
    }

    function _giveAllowances() internal {
        // For non-HTS tokens, we need to approve
        if (!isLpToken0HTS) {
            IERC20(lpToken0).approve(positionManager, type(uint).max);
            IERC20(lpToken0).approve(saucerSwapRouter, type(uint).max);
        }
        
        if (!isLpToken1HTS) {
            IERC20(lpToken1).approve(positionManager, type(uint).max);
            IERC20(lpToken1).approve(saucerSwapRouter, type(uint).max);
        }
        
        // Native is always HTS, no approval needed
    }

    function _removeAllowances() internal {
        // Only remove allowances for non-HTS tokens
        if (!isLpToken0HTS) {
            IERC20(lpToken0).approve(positionManager, 0);
            IERC20(lpToken0).approve(saucerSwapRouter, 0);
        }
        
        if (!isLpToken1HTS) {
            IERC20(lpToken1).approve(positionManager, 0);
            IERC20(lpToken1).approve(saucerSwapRouter, 0);
        }
        
        // Native is always HTS, no approval to remove
    }
}
