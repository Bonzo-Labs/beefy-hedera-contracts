// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20Metadata} from "@openzeppelin-4/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import {AddressUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "../Common/StratFeeManagerInitializable.sol";
import {IUniswapV3Pool as ISaucerSwapPool} from "../../interfaces/saucerswap/IUniswapV3Pool.sol";
import "../../utils/LiquidityAmounts.sol";
import "../../utils/TickMath.sol";
import "../../utils/TickUtils.sol";
import "../../utils/FullMath.sol";
import "../../interfaces/beefy/IBeefyVaultConcLiq.sol";
import "../../interfaces/beefy/IStrategyFactory.sol";
import "../../interfaces/beefy/IStrategyConcLiq.sol";
import "../../interfaces/uniswap/IQuoter.sol";
import "../../interfaces/saucerswap/IUniswapV3Factory.sol";
import "../../Hedera/IHederaTokenService.sol";
import "../../utils/GasFeeThrottler.sol";
import "../../interfaces/oracle/IBeefyOracle.sol";
import "../Bonzo/SaucerSwapCLMLib.sol";
import "../Bonzo/SaucerSwapLariLib.sol";

contract SaucerSwapLariRewardsCLMStrategy is
    ReentrancyGuardUpgradeable,
    StratFeeManagerInitializable,
    IStrategyConcLiq,
    GasFeeThrottler
{
    using SafeERC20 for IERC20Metadata;
    using TickMath for int24;
    using AddressUpgradeable for address payable;
    uint256 private constant PRECISION = 1e36;
    uint256 private constant DURATION = 21600;
    address private constant HTS_PRECOMPILE = address(0x167);
    int64 private constant HTS_SUCCESS = 22;
    int64 private constant PRECOMPILE_BIND_ERROR = -1;
    uint256 public constant MINT_SLIPPAGE_TOLERANCE = 500;
    uint256 public constant PRICE_DEVIATION_TOLERANCE = 200;
    address public pool;
    address public quoter;
    address public lpToken0;
    address public lpToken1;
    uint256 public fees0;
    uint256 public fees1;
    struct Position {
        int24 tickLower;
        int24 tickUpper;
    }
    struct InitParams {
        address pool;
        address quoter;
        int24 positionWidth;
        address native;
        address factory;
        address beefyOracle;
        address[] rewardTokens;
    }
    struct BalanceInfo {
        uint256 token0Bal;
        uint256 token1Bal;
        uint256 mainAmount0;
        uint256 mainAmount1;
        uint256 altAmount0;
        uint256 altAmount1;
    }
    Position public positionMain;
    Position public positionAlt;
    int24 public positionWidth;
    int56 public maxTickDeviation;
    uint32 public twapInterval;
    bool private minting;
    uint256 private expectedAmount0;
    uint256 private expectedAmount1;
    bool private initTicks;
    uint256 private lastDeposit;
    address public native;
    address public factory;
    uint256 public totalLocked0;
    uint256 public totalLocked1;
    uint256 public lastHarvest;
    uint256 public lastPositionAdjustment;
    address public beefyOracle;
    uint256 public leftover0;
    uint256 public leftover1;
    SaucerSwapLariLib.RewardToken[] public rewardTokens;
    mapping(address => uint256) private rewardTokenIndex;
    mapping(address => bool) private isRewardToken;
    // Errors
    error NotAuthorized();
    error NotPool();
    error InvalidEntry();
    error NotVault();
    error InvalidInput();
    error InvalidOutput();
    error NotCalm();
    error TooMuchSlippage();
    error InvalidTicks();
    error HTSTransferFailed();
    error HTSAssociationFailed();
    error InvalidTokenAddress();
    error NoRoutes();
    error TokenExists();
    error TokenNotFound();

    // Events
    event Harvest(uint256 fee0, uint256 fee1);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);
    event Deposit(address indexed user, uint256 amount0, uint256 amount1);
    event Withdraw(address indexed user, uint256 amount0, uint256 amount1);
    event LariHarvested(address indexed rewardToken, uint256 amount);
    event RewardTokenAdded(address indexed token, bool isHTS);
    event RewardTokenRemoved(address indexed token);
    event RewardTokenUpdated(address indexed token, bool isActive);
    modifier onlyCalmPeriods() {
        _onlyCalmPeriods();
        _;
    }

    modifier onlyRebalancers() {
        _checkManager();
        _;
    }

    function getMintFee() public view returns (uint256 mintFee) {
        address poolFactory = ISaucerSwapPool(pool).factory();
        return IUniswapV3Factory(poolFactory).mintFee();
    }

    function _onlyCalmPeriods() private view {
        if (!isCalm()) revert NotCalm();
    }

    function isCalm() public view returns (bool) {
        return SaucerSwapCLMLib.isPoolCalm(pool, twapInterval, maxTickDeviation);
    }

    function initialize(InitParams calldata _params, CommonAddresses calldata _commonAddresses) external initializer {
        __StratFeeManager_init(_commonAddresses);
        __ReentrancyGuard_init();

        pool = _params.pool;
        quoter = _params.quoter;
        lpToken0 = ISaucerSwapPool(_params.pool).token0();
        lpToken1 = ISaucerSwapPool(_params.pool).token1();
        native = _params.native;
        factory = _params.factory;
        beefyOracle = _params.beefyOracle;
        positionWidth = _params.positionWidth; // Our width multiplier. The tick distance of each side will be width * tickSpacing.
        twapInterval = 120; // Set the twap interval to 120 seconds.
        maxTickDeviation = 200; // Set default max tick deviation
        if (lpToken0 != native) {
            SaucerSwapCLMLib.safeAssociateToken(lpToken0);
        }
        if (lpToken1 != native) {
            SaucerSwapCLMLib.safeAssociateToken(lpToken1);
        }
        for (uint256 i = 0; i < _params.rewardTokens.length; i++) {
            _addRewardToken(_params.rewardTokens[i], true); // Assume all are HTS initially
        }
        _safeGiveAllowances();
    }

    function _onlyVault() private view {
        if (msg.sender != vault) revert NotVault();
    }

    function beforeAction() external {
        _onlyVault();
        _claimEarnings();
        _removeLiquidity();
    }

    function deposit() external onlyCalmPeriods {
        _onlyVault();
        (uint256 balBefore0, uint256 balBefore1) = balancesOfThis(); // Get current balances before adding liquidity
        if (!initTicks) {
            _setTicks();
            initTicks = true;
        }
        _addLiquidity();
        (uint256 balAfter0, uint256 balAfter1) = balancesOfThis();
        leftover0 = balAfter0;
        leftover1 = balAfter1;
        lastDeposit = block.timestamp;
        emit Deposit(vault, balBefore0, balBefore1);
    }

    function withdraw(uint256 _amount0, uint256 _amount1) external {
        _onlyVault();
        if (block.timestamp == lastDeposit) _onlyCalmPeriods();

        // Liquidity has already been removed in beforeAction() so this is just a simple withdraw.
        if (_amount0 > 0) {
            _transferTokens(lpToken0, address(this), vault, _amount0, true);
        }
        if (_amount1 > 0) {
            _transferTokens(lpToken1, address(this), vault, _amount1, true);
        }
        emit Withdraw(vault, _amount0, _amount1);
        if (!_isPaused()) _addLiquidity();
    }

    function _addLiquidity() private onlyCalmPeriods {
        _whenStrategyNotPaused();
        (uint256 bal0, uint256 bal1) = balancesOfThis();
        uint256 mintFee = getMintFee();
        uint160 sqrtprice = sqrtPrice();
        (uint128 liquidity, uint160 adjustedSqrtPrice) = _calculateLiquidityWithPriceCheck(
            sqrtprice,
            positionMain.tickLower,
            positionMain.tickUpper,
            bal0,
            bal1
        );
        (uint256 amount0, uint256 amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPrice(),
            TickMath.getSqrtRatioAtTick(positionMain.tickLower),
            TickMath.getSqrtRatioAtTick(positionMain.tickUpper),
            liquidity
        );
        bool amountsOk = SaucerSwapCLMLib.checkAmounts(amount0, amount1);
        if (liquidity > 0 && amountsOk) {
            _validatePreMintConditions(adjustedSqrtPrice, bal0, bal1);
            require(address(this).balance >= mintFee, "Insufficient HBAR for mint fee");
            (expectedAmount0, expectedAmount1) = LiquidityAmounts.getAmountsForLiquidity(
                adjustedSqrtPrice,
                TickMath.getSqrtRatioAtTick(positionMain.tickLower),
                TickMath.getSqrtRatioAtTick(positionMain.tickUpper),
                liquidity
            );
            minting = true;
            ISaucerSwapPool(pool).mint{value: mintFee}(
                address(this),
                positionMain.tickLower,
                positionMain.tickUpper,
                liquidity,
                "Beefy Main"
            );
        } else _onlyCalmPeriods();
        (bal0, bal1) = balancesOfThis();
        // Fetch how much liquidity we get for adding at the alternative position ticks with our token balances.
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtprice,
            TickMath.getSqrtRatioAtTick(positionAlt.tickLower),
            TickMath.getSqrtRatioAtTick(positionAlt.tickUpper),
            bal0,
            bal1
        );
        // Flip minting to true and call the pool to mint the liquidity.
        if (liquidity > 0) {
            // Additional pre-mint validation for alternative position
            _validatePreMintConditions(sqrtprice, bal0, bal1);
            // Check we have sufficient HBAR for mint fee
            require(address(this).balance >= mintFee, "Insufficient HBAR for alt mint fee");
            // Calculate expected amounts for slippage protection
            (expectedAmount0, expectedAmount1) = LiquidityAmounts.getAmountsForLiquidity(
                sqrtprice,
                TickMath.getSqrtRatioAtTick(positionAlt.tickLower),
                TickMath.getSqrtRatioAtTick(positionAlt.tickUpper),
                liquidity
            );
            minting = true;
            ISaucerSwapPool(pool).mint{value: mintFee}(
                address(this),
                positionAlt.tickLower,
                positionAlt.tickUpper,
                liquidity,
                "Beefy Alt"
            );
        }
    }

    function _removeLiquidity() private {
        // First we fetch our position keys in order to get our liquidity balances from the pool.
        (bytes32 keyMain, bytes32 keyAlt) = getKeys();
        // Fetch the liquidity balances from the pool.
        (uint128 liquidity, , , , ) = ISaucerSwapPool(pool).positions(keyMain);
        (uint128 liquidityAlt, , , , ) = ISaucerSwapPool(pool).positions(keyAlt);
        // If we have liquidity in the positions we remove it and collect our tokens.
        if (liquidity > 0) {
            ISaucerSwapPool(pool).burn(positionMain.tickLower, positionMain.tickUpper, liquidity);
            ISaucerSwapPool(pool).collect(
                address(this),
                positionMain.tickLower,
                positionMain.tickUpper,
                type(uint128).max,
                type(uint128).max
            );
        }
        if (liquidityAlt > 0) {
            ISaucerSwapPool(pool).burn(positionAlt.tickLower, positionAlt.tickUpper, liquidityAlt);
            ISaucerSwapPool(pool).collect(
                address(this),
                positionAlt.tickLower,
                positionAlt.tickUpper,
                type(uint128).max,
                type(uint128).max
            );
        }
    }
    function harvest(address _callFeeRecipient) external {
        _harvest(_callFeeRecipient);
    }

    function harvest() external {
        _harvest(tx.origin);
    }

    function _harvest(address _callFeeRecipient) private onlyCalmPeriods {
        // Claim fees from the pool and collect them.
        _claimEarnings();
        _removeLiquidity();
        _processLariRewards();
        // Charge fees for Beefy and send them to the appropriate addresses, charge fees to accrued state fee amounts.
        (uint256 fee0, uint256 fee1) = _chargeFees(_callFeeRecipient, fees0, fees1);
        _addLiquidity();
        // Reset state fees to 0.
        fees0 = 0;
        fees1 = 0;
        // We stream the rewards over time to the LP.
        uint256 currentLock0 = totalLocked0 > 0 ? (totalLocked0 * (block.timestamp - lastHarvest)) / DURATION : 0;
        uint256 currentLock1 = totalLocked1 > 0 ? (totalLocked1 * (block.timestamp - lastHarvest)) / DURATION : 0;
        totalLocked0 = fee0 + currentLock0;
        totalLocked1 = fee1 + currentLock1;
        // Log the last time we claimed fees.
        lastHarvest = block.timestamp;
        // Log the fees post Beefy fees.
        emit Harvest(fee0, fee1);
    }

    function _processLariRewards() private {
        (uint256 newFees0, uint256 newFees1) = SaucerSwapLariLib.processLariRewards(rewardTokens, unirouter, lpToken0, lpToken1);
        fees0 += newFees0;
        fees1 += newFees1;
    }


    function moveTicks() external onlyCalmPeriods onlyRebalancers {
        _claimEarnings();
        _removeLiquidity();
        _setTicks();
        _addLiquidity();
    }

    function claimEarnings() external returns (uint256 fee0, uint256 fee1, uint256 feeAlt0, uint256 feeAlt1) {
        (fee0, fee1, feeAlt0, feeAlt1) = _claimEarnings();
    }

    function _claimEarnings() private returns (uint256 fee0, uint256 fee1, uint256 feeAlt0, uint256 feeAlt1) {
        (fee0, fee1) = SaucerSwapLariLib.claimMainPositionFees(
            pool,
            positionMain.tickLower,
            positionMain.tickUpper,
            address(this)
        );
        (feeAlt0, feeAlt1) = SaucerSwapLariLib.claimAltPositionFees(
            pool,
            positionAlt.tickLower,
            positionAlt.tickUpper,
            address(this)
        );
        // Set the total fees collected to state.
        fees0 = fees0 + fee0 + feeAlt0;
        fees1 = fees1 + fee1 + feeAlt1;
    }

    function _chargeFees(
        address _callFeeRecipient,
        uint256 _amount0,
        uint256 _amount1
    ) private returns (uint256 _amountLeft0, uint256 _amountLeft1) {
        IFeeConfig.FeeCategory memory fees = getFees();
        (_amountLeft0, _amountLeft1) = SaucerSwapLariLib.calculateFeesLeft(_amount0, _amount1, fees.total, DIVISOR);
        (uint256 feeAmount0, uint256 feeAmount1) = SaucerSwapLariLib.calculateLPTokenFees(_amount0, _amount1, fees.total, DIVISOR);
        SaucerSwapLariLib.distributeLPTokenFees(_callFeeRecipient, strategist, beefyFeeRecipient, feeAmount0, feeAmount1, fees.call, fees.strategist, DIVISOR, lpToken0, lpToken1, native);
    }

    function balances() public view returns (uint256 token0Bal, uint256 token1Bal) {
        (uint256 thisBal0, uint256 thisBal1) = balancesOfThis();
        BalanceInfo memory poolInfo = balancesOfPool();
        uint256 locked0 = totalLocked0 > 0 ? (totalLocked0 * (block.timestamp - lastHarvest)) / DURATION : 0;
        uint256 locked1 = totalLocked1 > 0 ? (totalLocked1 * (block.timestamp - lastHarvest)) / DURATION : 0;
        uint256 total0 = thisBal0 + poolInfo.token0Bal - locked0;
        uint256 total1 = thisBal1 + poolInfo.token1Bal - locked1;
        uint256 unharvestedFees0 = fees0;
        uint256 unharvestedFees1 = fees1;
        // If pair is so imbalanced that we no longer have any enough tokens to pay fees, we set them to 0.
        if (unharvestedFees0 > total0) unharvestedFees0 = total0;
        if (unharvestedFees1 > total1) unharvestedFees1 = total1;
        // For token0 and token1 we return balance of this contract + balance of positions - locked profit - feesUnharvested.
        return (total0 - unharvestedFees0, total1 - unharvestedFees1);
    }

    function balancesOfThis() public view returns (uint256 token0Bal, uint256 token1Bal) {
        token0Bal = IERC20Metadata(lpToken0).balanceOf(address(this));
        token1Bal = IERC20Metadata(lpToken1).balanceOf(address(this));
    }

    function balancesOfPool() public view returns (BalanceInfo memory balInfo) {
        (balInfo.mainAmount0, balInfo.mainAmount1) = _getMainPositionAmounts();
        (balInfo.altAmount0, balInfo.altAmount1) = _getAltPositionAmounts();

        balInfo.token0Bal = balInfo.mainAmount0 + balInfo.altAmount0;
        balInfo.token1Bal = balInfo.mainAmount1 + balInfo.altAmount1;
    }

    function _getMainPositionAmounts() private view returns (uint256 amount0, uint256 amount1) {
        return SaucerSwapLariLib.getMainPositionAmounts(
            pool,
            address(this),
            positionMain.tickLower,
            positionMain.tickUpper,
            initTicks
        );
    }

    function _getAltPositionAmounts() private view returns (uint256 amount0, uint256 amount1) {
        return SaucerSwapLariLib.getAltPositionAmounts(
            pool,
            address(this),
            positionAlt.tickLower,
            positionAlt.tickUpper,
            initTicks
        );
    }

    function range() external view returns (uint256 lowerPrice, uint256 upperPrice) {
        return SaucerSwapCLMLib.calculateRangePrices(positionMain.tickLower, positionMain.tickUpper);
    }

    function getKeys() public view returns (bytes32 keyMain, bytes32 keyAlt) {
        keyMain = keccak256(abi.encodePacked(address(this), positionMain.tickLower, positionMain.tickUpper));
        keyAlt = keccak256(abi.encodePacked(address(this), positionAlt.tickLower, positionAlt.tickUpper));
    }

    function currentTick() public view returns (int24 tick) {
        (, tick, , , , , ) = ISaucerSwapPool(pool).slot0();
    }

    function price() public view returns (uint256 _price) {
        return SaucerSwapCLMLib.getPoolPrice(pool);
    }

    function sqrtPrice() public view returns (uint160 sqrtPriceX96) {
        return SaucerSwapCLMLib.getPoolSqrtPrice(pool);
    }

    function swapFee() external view override returns (uint256 fee) {
        return SaucerSwapCLMLib.getPoolFee(pool);
    }

    function _tickDistance() private view returns (int24) {
        return ISaucerSwapPool(pool).tickSpacing();
    }

    function uniswapV3MintCallback(uint256 amount0, uint256 amount1, bytes memory /*data*/) external nonReentrant {
        if (msg.sender != pool) revert NotPool();
        if (!minting) revert InvalidEntry();
        minting = false;
        _validateMintSlippage(amount0, amount1);
        if (amount0 > 0) {
            _transferTokens(lpToken0, address(this), pool, amount0, true);
        }
        if (amount1 > 0) {
            _transferTokens(lpToken1, address(this), pool, amount1, true);
        }
    }

    function _setTicks() private onlyCalmPeriods {
        int24 tick = currentTick();
        int24 distance = _tickDistance();
        int24 width = positionWidth * distance;
        _setMainTick(tick, distance, width);
        _setAltTick(tick, distance, width);
        lastPositionAdjustment = block.timestamp;
    }

    function _setMainTick(int24 tick, int24 distance, int24 width) private {
        (positionMain.tickLower, positionMain.tickUpper) = SaucerSwapLariLib.setMainTick(tick, distance, width);
    }

    function _setAltTick(int24 tick, int24 distance, int24 width) private {
        (uint256 bal0, uint256 bal1) = balancesOfThis();
        (positionAlt.tickLower, positionAlt.tickUpper) = SaucerSwapLariLib.setAltTick(
            tick,
            distance,
            width,
            bal0,
            bal1,
            price(),
            PRECISION
        );
        if (positionMain.tickLower == positionAlt.tickLower && positionMain.tickUpper == positionAlt.tickUpper)
            revert InvalidTicks();
    }

    function _transferTokens(address token, address /* from */, address to, uint256 amount, bool isFromContract) internal {
        if (isFromContract) {
            SaucerSwapLariLib.transferTokens(token, to, amount, native);
        } else {
            require(msg.value >= amount, "Insufficient native token sent");
        }
    }

    function _associateToken(address token) internal {
        SaucerSwapCLMLib.safeAssociateToken(token);
    }

    function setDeviation(int56 _maxDeviation) external onlyOwner {
        // Require the deviation to be less than or equal to 4 times the tick spacing.
        if (_maxDeviation >= _tickDistance() * 4) revert InvalidInput();
        maxTickDeviation = _maxDeviation;
    }

    function twap() public view returns (int56 twapTick) {
        return SaucerSwapCLMLib.getTwap(pool, twapInterval);
    }

    function setTwapInterval(uint32 _interval) external onlyOwner {
        // Require the interval to be greater than 60 seconds.
        if (_interval < 60) revert InvalidInput();
        twapInterval = _interval;
    }

    function setUnirouter(address _unirouter) external override onlyOwner {
        _removeAllowances();
        unirouter = _unirouter;
        _giveAllowances();
        emit SetUnirouter(_unirouter);
    }

    function retireVault() external onlyOwner {
        if (IBeefyVaultConcLiq(vault).totalSupply() != 10 ** 3) revert NotAuthorized();
        panic(0, 0);
        address feeRecipient = beefyFeeRecipient;
        (uint bal0, uint bal1) = balancesOfThis();
        if (bal0 > 0) {
            _transferTokens(lpToken0, address(this), feeRecipient, bal0, true);
        }
        if (bal1 > 0) {
            _transferTokens(lpToken1, address(this), feeRecipient, bal1, true);
        }
        _transferOwnership(address(0));
    }

    function panic(uint256 _minAmount0, uint256 _minAmount1) public onlyManager {
        _claimEarnings();
        _removeLiquidity();
        _removeAllowances();
        _pause();
        (uint256 bal0, uint256 bal1) = balances();
        if (bal0 < _minAmount0 || bal1 < _minAmount1) revert TooMuchSlippage();
    }

    function unpause() external onlyManager {
        if (owner() == address(0)) revert NotAuthorized();
        _giveAllowances();
        _unpause();
        _setTicks();
        _addLiquidity();
    }

    function _giveAllowances() private {
        SaucerSwapLariLib.giveAllowances(lpToken0, lpToken1, native, unirouter, rewardTokens);
    }

    function _safeGiveAllowances() private {
        SaucerSwapLariLib.safeGiveAllowances(lpToken0, lpToken1, native, unirouter, rewardTokens);
    }

    function _removeAllowances() private {
        SaucerSwapLariLib.removeAllowances(lpToken0, lpToken1, native, unirouter, rewardTokens);
    }

    function _isPaused() internal view returns (bool) {
        return paused();
    }

    function _whenStrategyNotPaused() internal view {
        require(!paused(), "Strategy is paused");
    }

    function associateToken(address token) external onlyOwner {
        _associateToken(token);
    }

    function setBeefyOracle(address _beefyOracle) external onlyOwner {
        require(_beefyOracle != address(0), "Invalid oracle address");
        beefyOracle = _beefyOracle;
    }

    function lpToken0ToNativePrice() external returns (uint256) {
        return SaucerSwapLariLib.quoteLpTokenToNativePrice(lpToken0, native, quoter, IERC20Metadata(lpToken0).decimals());
    }

    function lpToken1ToNativePrice() external returns (uint256) {
        return SaucerSwapLariLib.quoteLpTokenToNativePrice(lpToken1, native, quoter, IERC20Metadata(lpToken1).decimals());
    }

    function addRewardToken(address _token, bool _isHTS) external onlyManager {
        if (isRewardToken[_token]) revert TokenExists();
        _addRewardToken(_token, _isHTS);
    }

    function _addRewardToken(address _token, bool _isHTS) internal {
        SaucerSwapLariLib.addRewardToken(rewardTokens, rewardTokenIndex, isRewardToken, _token, _isHTS, lpToken0, lpToken1);
        emit RewardTokenAdded(_token, _isHTS);
    }

    function updateRewardTokenStatus(address _token, bool _isActive) external onlyManager {
        SaucerSwapLariLib.updateRewardTokenStatus(rewardTokens, rewardTokenIndex, isRewardToken, _token, _isActive);
        emit RewardTokenUpdated(_token, _isActive);
    }

    function setRewardRoute(
        address _token,
        address[] calldata _toLp0Route,
        address[] calldata _toLp1Route
    ) external onlyManager {
        SaucerSwapLariLib.setRewardRoute(rewardTokens, rewardTokenIndex, isRewardToken, _token, _toLp0Route, _toLp1Route);
    }

    function removeRewardToken(address _token) external onlyManager {
        SaucerSwapLariLib.removeRewardToken(rewardTokens, rewardTokenIndex, isRewardToken, _token);
        emit RewardTokenRemoved(_token);
    }

    function getRewardToken(uint256 index) external view returns (SaucerSwapLariLib.RewardToken memory) {
        require(index < rewardTokens.length, "Index out of bounds");
        return rewardTokens[index];
    }

    function getRewardTokensLength() external view returns (uint256) {
        return rewardTokens.length;
    }

    function getLeftoverAmounts() external view returns (uint256 leftover0Amount, uint256 leftover1Amount) {
        _onlyVault();
        return (leftover0, leftover1);
    }

    function returnLeftovers(address recipient) external {
        _onlyVault();
        if (leftover0 > 0) {
            _transferTokens(lpToken0, address(this), recipient, leftover0, true);
            leftover0 = 0;
        }
        if (leftover1 > 0) {
            _transferTokens(lpToken1, address(this), recipient, leftover1, true);
            leftover1 = 0;
        }
    }

    function _validatePreMintConditions(uint160 currentSqrtPrice, uint256 bal0, uint256 bal1) private view {
        SaucerSwapCLMLib.validatePreMintConditions(pool, twapInterval, maxTickDeviation, currentSqrtPrice, bal0, bal1);
    }

    function _validateMintSlippage(uint256 amount0, uint256 amount1) private view {
        (uint256 bal0, uint256 bal1) = balancesOfThis();
        SaucerSwapCLMLib.validateMintSlippage(amount0, amount1, expectedAmount0, expectedAmount1, MINT_SLIPPAGE_TOLERANCE, bal0, bal1);
    }

    function _calculateLiquidityWithPriceCheck(
        uint160 initialSqrtPrice,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0,
        uint256 amount1
    ) private view returns (uint128 liquidity, uint160 adjustedSqrtPrice) {
        return SaucerSwapCLMLib.calculateLiquidityWithPriceCheck(pool, initialSqrtPrice, tickLower, tickUpper, amount0, amount1, PRICE_DEVIATION_TOLERANCE);
    }

    receive() external payable {}
}
