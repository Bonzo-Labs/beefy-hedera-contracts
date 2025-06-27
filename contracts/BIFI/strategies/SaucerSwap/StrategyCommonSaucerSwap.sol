// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin-4/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin-4/contracts/utils/Address.sol";

import "../../interfaces/common/IUniswapRouterV3WithDeadline.sol";
import "../../interfaces/saucerswap/IUniswapV3Pool.sol";
import "../../interfaces/saucerswap/IUniswapV3Factory.sol";
import "../Common/StratFeeManagerInitializable.sol";
import "../../utils/GasFeeThrottler.sol";
import "../../utils/UniswapV3Utils.sol";
import "../../interfaces/saucerswap/INonfungiblePositionManager.sol";
import "../../Hedera/IHederaTokenService.sol";
import "../../Hedera/IWHBAR.sol";

contract StrategyCommonSaucerSwap is StratFeeManagerInitializable, GasFeeThrottler {
    using SafeERC20 for IERC20;
    using UniswapV3Utils for bytes;
    using Address for address payable;
    //testnet
    IWHBAR public constant _whbarContract = IWHBAR(0x0000000000000000000000000000000000003aD1); //testnet
    address private WHBAR = 0x0000000000000000000000000000000000003aD2;

    //Mainnet
    // IWHBAR public constant _whbarContract = IWHBAR(0x0000000000000000000000000000000000163B59); //mainnet
    // address private WHBAR = 0x0000000000000000000000000000000000163B59;

    // Tokens used
    address public pool;
    address public lpToken0;
    address public lpToken1;

    // Native token flags: adjust these based on the tokens you are using
    bool public isLpToken0Native = true;
    bool public isLpToken1Native = false;

    // Track total deposited amounts (more accurate than position calculations)
    uint256 public totalDeposited0;
    uint256 public totalDeposited1;

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
    address private constant HTS_PRECOMPILE = address(0x167);
    int64 private constant HTS_SUCCESS = 22;
    int64 private constant PRECOMPILE_BIND_ERROR = -2;
    bool private isLpToken0HTS;
    bool private isLpToken1HTS;

    // Constants
    uint256 public constant DEADLINE_BUFFER = 600; // 10 minutes
    uint256 public constant DIVISOR18 = 1e18;

    event StratHarvest(address indexed harvester, uint256 lp0Harvested, uint256 lp1Harvested);
    event Deposit(uint256 lp0Deposit, uint256 lp1Deposit);
    event Withdraw(uint256 lp0Withdraw, uint256 lp1Withdraw);
    event ChargedFees(uint256 callFees, uint256 beefyFees, uint256 strategistFees);
    event HTSTokenAssociated(address token, int64 responseCode);
    event HTSTokenDissociated(address token, int64 responseCode);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);
    event Harvest(uint256 amount0, uint256 amount1);

    error TestError(uint256 actualNativeBal, uint256 nativeBal, uint256 callFee, uint256 divisor);

    function initialize(
        address _lpToken0,
        address _lpToken1,
        address _positionManager,
        address _poolFactory,
        uint24 _poolFee,
        address[] calldata _lp0ToNativeRoute,
        address[] calldata _lp1ToNativeRoute,
        bool _isLpToken0HTS,
        bool _isLpToken1HTS,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        __common_init(
            _lpToken0,
            _lpToken1,
            _positionManager,
            _poolFactory,
            _poolFee,
            _lp0ToNativeRoute,
            _lp1ToNativeRoute,
            _isLpToken0HTS,
            _isLpToken1HTS,
            _commonAddresses
        );
    }

    function __common_init(
        address _lpToken0,
        address _lpToken1,
        address _positionManager,
        address _poolFactory,
        uint24 _poolFee,
        address[] calldata _lp0ToNativeRoute,
        address[] calldata _lp1ToNativeRoute,
        bool _isLpToken0HTS,
        bool _isLpToken1HTS,
        CommonAddresses calldata _commonAddresses
    ) internal onlyInitializing {
        __StratFeeManager_init(_commonAddresses);
        poolFactory = _poolFactory;
        positionManager = _positionManager;
        saucerSwapRouter = _commonAddresses.unirouter;

        lpToken0 = _lpToken0;
        lpToken1 = _lpToken1;
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
        require(responseCode == HTS_SUCCESS, "assoc fail");
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
        require(responseCode == HTS_SUCCESS, "dissoc failed");
        emit HTSTokenDissociated(token, responseCode);
    }

    /**
     * @dev Transfer tokens - uses HTS for HTS tokens, native transfer for native tokens, regular ERC20 for others
     * @param token The token to transfer
     * @param to Destination address
     * @param amount Amount to transfer
     * @param isHTS Whether the token is an HTS token
     * @param isNative Whether the token is native (HBAR)
     */
    function _transferTokens(address token, address to, uint256 amount, bool isHTS, bool isNative) internal {
        if (isNative) {
            // For native tokens, use native transfer like ETH
            Address.sendValue(payable(to), amount);
        } else if (isHTS) {
            (bool success, bytes memory result) = HTS_PRECOMPILE.call(
                abi.encodeWithSelector(
                    IHederaTokenService.transferToken.selector,
                    token,
                    address(this),
                    to,
                    int64(uint64(amount))
                )
            );
            int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
            if (responseCode != HTS_SUCCESS) {
                emit HTSTokenTransferFailed(token, address(this), to, responseCode);
                revert("HTS trf fail");
            }
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // Helper function to get token balance
    function _getTokenBalance(address token, bool isNative) internal view returns (uint256) {
        if (isNative) {
            // For native tokens, use address(this).balance
            return address(this).balance;
        } else {
            // For ERC20 and HTS tokens, use standard balanceOf
            return IERC20(token).balanceOf(address(this));
        }
    }

    // Common function to decrease liquidity and collect tokens
    function _decreaseLiquidityAndCollect(
        uint128 liquidityToDecrease,
        uint128 amount0Max,
        uint128 amount1Max
    ) internal {
        INonfungiblePositionManager.DecreaseLiquidityParams memory decreaseParams = INonfungiblePositionManager
            .DecreaseLiquidityParams({
                tokenSN: nftTokenId,
                liquidity: liquidityToDecrease,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp + DEADLINE_BUFFER
            });
        INonfungiblePositionManager(positionManager).decreaseLiquidity(decreaseParams);

        INonfungiblePositionManager.CollectParams memory collectParams = INonfungiblePositionManager.CollectParams({
            tokenSN: nftTokenId,
            recipient: address(this),
            amount0Max: amount0Max,
            amount1Max: amount1Max
        });
        INonfungiblePositionManager(positionManager).collect(collectParams);
    }

    // Common function to just collect tokens (for harvesting fees)
    function _collectTokens(
        uint128 amount0Max,
        uint128 amount1Max
    ) internal returns (uint256 amount0, uint256 amount1) {
        INonfungiblePositionManager.CollectParams memory collectParams = INonfungiblePositionManager.CollectParams({
            tokenSN: nftTokenId,
            recipient: address(this),
            amount0Max: amount0Max,
            amount1Max: amount1Max
        });
        return INonfungiblePositionManager(positionManager).collect(collectParams);
    }

    // puts the funds to work
    function deposit() public payable whenNotPaused returns (uint256 lp0Deposit, uint256 lp1Deposit) {
        uint256 lpToken0Bal = _getTokenBalance(lpToken0, isLpToken0Native);
        uint256 lpToken1Bal = _getTokenBalance(lpToken1, isLpToken1Native);

        if (lpToken0Bal > 0 || lpToken1Bal > 0) {
            // Track the amounts being deposited
            totalDeposited0 += lpToken0Bal;
            totalDeposited1 += lpToken1Bal;

            addLiquidity();

            uint256 lpToken0BalAfter = _getTokenBalance(lpToken0, isLpToken0Native);
            uint256 lpToken1BalAfter = _getTokenBalance(lpToken1, isLpToken1Native);
            if (lpToken0BalAfter > 0) {
                _transferTokens(lpToken0, tx.origin, lpToken0BalAfter, isLpToken0HTS, isLpToken0Native);
                totalDeposited0 -= lpToken0BalAfter;
            }
            if (lpToken1BalAfter > 0) {
                _transferTokens(lpToken1, tx.origin, lpToken1BalAfter, isLpToken1HTS, isLpToken1Native);
                totalDeposited1 -= lpToken1BalAfter;
            }

            emit Deposit(lpToken0Bal - lpToken0BalAfter, lpToken1Bal - lpToken1BalAfter);
            lp0Deposit = lpToken0Bal - lpToken0BalAfter;
            lp1Deposit = lpToken1Bal - lpToken1BalAfter;
        }
    }

    function withdraw(uint256 _amount0, uint256 _amount1) external payable {
        require(msg.sender == vault, "!vault");

        uint256 lp0Bal = _getTokenBalance(lpToken0, isLpToken0Native);
        uint256 lp1Bal = _getTokenBalance(lpToken1, isLpToken1Native);
        uint256 withdrawalFeeAmount = 0;

        if (tx.origin != owner() && !paused()) {
            withdrawalFeeAmount = (_amount0 * withdrawalFee) / WITHDRAWAL_MAX;
            _amount0 = _amount0 - withdrawalFeeAmount;
        }

        if (lp0Bal < _amount0 || lp1Bal < _amount1) {
            // Get current position info
            (, , , , , uint128 liquidity, , , , ) = INonfungiblePositionManager(positionManager).positions(nftTokenId);

            // Calculate deficit for each token (how much more we need)
            uint256 deficit0 = lp0Bal >= _amount0 ? 0 : _amount0 - lp0Bal;
            uint256 deficit1 = lp1Bal >= _amount1 ? 0 : _amount1 - lp1Bal;

            // Calculate what percentage of total deposited amounts we need
            uint256 percentageNeeded0 = totalDeposited0 > 0 ? (deficit0 * 1e18) / totalDeposited0 : 0;
            uint256 percentageNeeded1 = totalDeposited1 > 0 ? (deficit1 * 1e18) / totalDeposited1 : 0;

            // Take the maximum percentage to ensure we get enough of both tokens
            uint256 maxPercentage = percentageNeeded0 > percentageNeeded1 ? percentageNeeded0 : percentageNeeded1;

            // Calculate liquidity to decrease based on the percentage needed
            uint256 liquidityToDecrease = maxPercentage > 0 ? (uint256(liquidity) * maxPercentage) / 1e18 : 0;

            // Ensure we don't try to decrease more liquidity than we have
            if (liquidityToDecrease > uint256(liquidity)) {
                liquidityToDecrease = uint256(liquidity);
            }

            // Decrease liquidity proportionally
            _decreaseLiquidityAndCollect(uint128(liquidityToDecrease), uint128(deficit0), uint128(deficit1));

            if (isLpToken0Native) {
                uint256 balBfr = address(this).balance;
                _unwrapWHBARtoHBAR(lpToken0, IERC20(lpToken0).balanceOf(address(this)));
                _amount0 = address(this).balance - balBfr;
            } else {
                _amount0 = IERC20(lpToken0).balanceOf(address(this)) - lp0Bal;
            }
            if (isLpToken1Native) {
                uint256 balBfr = address(this).balance;
                _unwrapWHBARtoHBAR(lpToken1, IERC20(lpToken1).balanceOf(address(this)));
                _amount1 = address(this).balance - balBfr;
            } else {
                _amount1 = IERC20(lpToken1).balanceOf(address(this)) - lp1Bal;
            }
        }

        // Transfer tokens using appropriate method based on token type
        _transferTokens(lpToken0, vault, _amount0, isLpToken0HTS, isLpToken0Native);
        _transferTokens(lpToken1, vault, _amount1, isLpToken1HTS, isLpToken1Native);

        // Update tracked amounts
        totalDeposited0 = totalDeposited0 > _amount0 ? totalDeposited0 - _amount0 : 0;
        totalDeposited1 = totalDeposited1 > _amount1 ? totalDeposited1 - _amount1 : 0;

        emit Withdraw(balanceOfToken0(), balanceOfToken1());
    }

    function beforeDeposit() external virtual override {
        // if (harvestOnDeposit) {
        //     require(msg.sender == vault, "!vault");
        //     _harvest(tx.origin);
        // }
    }

    function harvest() external virtual gasThrottle {
        _harvest(tx.origin);
    }

    function harvest(address callFeeRecipient) external virtual gasThrottle {
        _harvest(callFeeRecipient);
    }

    function _unwrapWHBARtoHBAR(address token, uint256 amount) internal {
        IERC20(token).approve(address(_whbarContract), amount);
        IWHBAR(_whbarContract).withdraw(address(this), address(this), amount);
    }

    // compounds earnings and charges performance fee
    function _harvest(address callFeeRecipient) internal whenNotPaused {
        // Collect fees from the position
        (uint256 amount0, uint256 amount1) = _collectTokens(type(uint128).max, type(uint128).max);
        emit Harvest(amount0, amount1);
        if (amount0 > 0 && isLpToken0Native) {
            //unwrapp
            uint256 balanceBefore = address(this).balance;
            _unwrapWHBARtoHBAR(lpToken0, amount0);
            amount0 = address(this).balance - balanceBefore;
        }
        if (amount1 > 0 && isLpToken1Native) {
            //unwrapp
            uint256 balanceBefore = address(this).balance;
            _unwrapWHBARtoHBAR(lpToken1, amount1);
            amount1 = address(this).balance - balanceBefore;
        }
        if (amount0 > 0 || amount1 > 0) {
            chargeFees(callFeeRecipient, amount0, amount1);
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
        if (amount0 > 0 && !isLpToken0Native) {
            uint256 toNative0 = (amount0 * fees.total) / DIVISOR18;
            bytes memory path = UniswapV3Utils.routeToPath(lp0ToNativeRoute, getFeeTier(lp0ToNativeRoute.length - 1));
            IERC20(lpToken0).approve(saucerSwapRouter, toNative0);
            UniswapV3Utils.swap(saucerSwapRouter, path, toNative0);
        } else if (amount0 > 0 && isLpToken0Native) {
            nativeBal += (amount0 * fees.total) / DIVISOR18;
        }

        // Swap token1 to native if it's not native
        if (amount1 > 0 && !isLpToken1Native) {
            uint256 toNative1 = (amount1 * fees.total) / DIVISOR18;
            bytes memory path = UniswapV3Utils.routeToPath(lp1ToNativeRoute, getFeeTier(lp1ToNativeRoute.length - 1));
            IERC20(lpToken1).approve(saucerSwapRouter, toNative1);
            UniswapV3Utils.swap(saucerSwapRouter, path, toNative1);
        } else if (amount1 > 0 && isLpToken1Native) {
            nativeBal += (amount1 * fees.total) / DIVISOR18;
        }

        _unwrapWHBARtoHBAR(WHBAR, nativeBal);

        uint256 callFeeAmount = (nativeBal * fees.call) / DIVISOR18;
        Address.sendValue(payable(callFeeRecipient), callFeeAmount);

        uint256 beefyFeeAmount = (nativeBal * fees.beefy) / DIVISOR18;
        Address.sendValue(payable(beefyFeeRecipient), beefyFeeAmount);
        uint256 strategistFeeAmount = (nativeBal * fees.strategist) / DIVISOR18;
        Address.sendValue(payable(strategist), strategistFeeAmount);
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
        uint256 lp0Bal = _getTokenBalance(lpToken0, isLpToken0Native);
        uint256 lp1Bal = _getTokenBalance(lpToken1, isLpToken1Native);
        if (!isLpToken0Native) {
            //approve lpToken0 to position manager
            IERC20(lpToken0).approve(positionManager, lp0Bal);
        }
        if (!isLpToken1Native) {
            //approve lpToken1 to position manager
            IERC20(lpToken1).approve(positionManager, lp1Bal);
        }

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

        uint256 hbarToSend = isLpToken0Native ? lp0Bal : isLpToken1Native ? lp1Bal : 0;
        if (nftTokenId == 0) {
            (nftTokenId, , , ) = INonfungiblePositionManager(positionManager).mint{value: hbarToSend}(_params);
        } else {
            // If we already have a position, increase liquidity instead
            INonfungiblePositionManager.IncreaseLiquidityParams memory increaseParams = INonfungiblePositionManager
                .IncreaseLiquidityParams({
                    tokenSN: nftTokenId,
                    amount0Desired: lp0Bal,
                    amount1Desired: lp1Bal,
                    amount0Min: 1,
                    amount1Min: 1,
                    deadline: block.timestamp + DEADLINE_BUFFER
                });
            INonfungiblePositionManager(positionManager).increaseLiquidity{value: hbarToSend}(increaseParams);
        }
    }

    // it calculates how much 'want' this contract holds.
    function balanceOfToken0() public view returns (uint256) {
        return _getTokenBalance(lpToken0, isLpToken0Native);
    }

    function balanceOfToken1() public view returns (uint256) {
        return _getTokenBalance(lpToken1, isLpToken1Native);
    }

    // it calculates how much 'want' the strategy has working in the farm.
    function balanceOfPool() public view returns (uint256) {
        if (nftTokenId == 0) return 0;
        (, , , , , uint128 liquidity, , , , ) = INonfungiblePositionManager(positionManager).positions(nftTokenId);
        return uint256(liquidity);
    }

    // Combined balance including both token balance and position amounts
    function totalBalanceOfToken0() public view returns (uint256) {
        return balanceOfToken0() + totalDeposited0;
    }

    function totalBalanceOfToken1() public view returns (uint256) {
        return balanceOfToken1() + totalDeposited1;
    }

    function getPositionInfo()
        public
        view
        returns (
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
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

    // Add function to update native token status
    function updateTokenNativeStatus(bool _isLpToken0Native, bool _isLpToken1Native) external onlyManager {
        isLpToken0Native = _isLpToken0Native;
        isLpToken1Native = _isLpToken1Native;
    }

    // called as part of strat migration. Sends all the available funds back to the vault.
    function retireStrat() external {
        require(msg.sender == vault, "!vault");

        // First decrease liquidity
        (, , , , , uint128 liquidity, , , , ) = INonfungiblePositionManager(positionManager).positions(nftTokenId);

        _decreaseLiquidityAndCollect(liquidity, type(uint128).max, type(uint128).max);

        // Finally burn the NFT since we're removing all liquidity
        INonfungiblePositionManager(positionManager).burn(nftTokenId);
        nftTokenId = 0;

        // Transfer tokens back to vault using appropriate method
        uint256 lp0Bal = _getTokenBalance(lpToken0, isLpToken0Native);
        uint256 lp1Bal = _getTokenBalance(lpToken1, isLpToken1Native);

        _transferTokens(lpToken0, vault, lp0Bal, isLpToken0HTS, isLpToken0Native);
        _transferTokens(lpToken1, vault, lp1Bal, isLpToken1HTS, isLpToken1Native);

        // Reset tracked amounts since strategy is being retired
        totalDeposited0 = 0;
        totalDeposited1 = 0;
    }

    // pauses deposits and withdraws all funds from third party systems.
    function panic() public onlyManager {
        pause();

        // First decrease liquidity
        (, , , , , uint128 liquidity, , , , ) = INonfungiblePositionManager(positionManager).positions(nftTokenId);

        _decreaseLiquidityAndCollect(liquidity, type(uint128).max, type(uint128).max);

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
    }

    function _giveAllowances() internal {
        // For non-HTS and non-native tokens, we need to approve
        if (!isLpToken0HTS && !isLpToken0Native) {
            IERC20(lpToken0).approve(positionManager, type(uint).max);
            IERC20(lpToken0).approve(saucerSwapRouter, type(uint).max);
        }

        if (!isLpToken1HTS && !isLpToken1Native) {
            IERC20(lpToken1).approve(positionManager, type(uint).max);
            IERC20(lpToken1).approve(saucerSwapRouter, type(uint).max);
        }

        // Native and HTS tokens don't need approval
    }

    function _removeAllowances() internal {
        // Only remove allowances for non-HTS and non-native tokens
        if (!isLpToken0HTS && !isLpToken0Native) {
            IERC20(lpToken0).approve(positionManager, 0);
            IERC20(lpToken0).approve(saucerSwapRouter, 0);
        }

        if (!isLpToken1HTS && !isLpToken1Native) {
            IERC20(lpToken1).approve(positionManager, 0);
            IERC20(lpToken1).approve(saucerSwapRouter, 0);
        }

        // Native and HTS tokens don't need approval removal
    }

    // to receive native tokens
    receive() external payable {}
}
