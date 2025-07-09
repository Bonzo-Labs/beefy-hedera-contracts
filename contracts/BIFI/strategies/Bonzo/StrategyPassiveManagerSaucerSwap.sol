// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20Metadata} from "@openzeppelin-4/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignedMath} from "@openzeppelin-4/contracts/utils/math/SignedMath.sol";
import {AddressUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "../Common/StratFeeManagerInitializable.sol";
import "../../interfaces/uniswap/IUniswapV3Pool.sol";
import "../../utils/LiquidityAmounts.sol";
import "../../utils/TickMath.sol";
import "../../utils/TickUtils.sol";
import "../../utils/Univ3Utils.sol";
import "../../utils/FullMath.sol";
import "../../interfaces/beefy/IBeefyVaultConcLiq.sol";
import "../../interfaces/beefy/IStrategyFactory.sol";
import "../../interfaces/beefy/IStrategyConcLiq.sol";
import "../../interfaces/beefy/IBeefySwapper.sol";
import "../../interfaces/uniswap/IQuoter.sol";
import "../../Hedera/IHederaTokenService.sol";
import "../../utils/GasFeeThrottler.sol";
import "../../interfaces/oracle/IBeefyOracle.sol";
import "./SaucerSwapCLMLib.sol";

/// @title Beefy Passive Position Manager for SaucerSwap (Hedera)
/// @author Bonzo Team, adapted from Beefy
/// @notice This is a contract for managing a passive concentrated liquidity position on SaucerSwap (UniswapV3 fork).
contract StrategyPassiveManagerSaucerSwap is
    ReentrancyGuardUpgradeable,
    StratFeeManagerInitializable,
    IStrategyConcLiq,
    GasFeeThrottler
{
    using SafeERC20 for IERC20Metadata;
    using TickMath for int24;
    using AddressUpgradeable for address payable;

    /// @notice The precision for pricing.
    uint256 private constant PRECISION = 1e36;
    uint256 private constant SQRT_PRECISION = 1e18;

    /// @notice The max and min ticks univ3 allows.
    int56 private constant MIN_TICK = -887272;
    int56 private constant MAX_TICK = 887272;

    /// @notice Address of the Hedera Token Service precompile
    address private constant HTS_PRECOMPILE = address(0x167);

    /// @notice HTS success response code
    int64 private constant HTS_SUCCESS = 22;

    /// @notice Error code when binding to the HTS precompile fails.
    int64 private constant PRECOMPILE_BIND_ERROR = -1;

    /// @notice Duration over which rewards are locked (6 hours)
    uint256 public constant DURATION = 21600;

    /// @notice The address of the SaucerSwap V3 pool.
    address public pool;
    /// @notice The address of the quoter.
    address public quoter;
    /// @notice The address of the first token in the liquidity pool.
    address public lpToken0;
    /// @notice The address of the second token in the liquidity pool.
    address public lpToken1;

    /// @notice The fees that are collected in the strategy but have not yet completed the harvest process.
    uint256 public fees0;
    uint256 public fees1;

    /// @notice The struct to store our tick positioning.
    struct Position {
        int24 tickLower;
        int24 tickUpper;
    }

    /// @notice Struct for initialization parameters to reduce stack depth
    struct InitParams {
        address pool;
        address quoter;
        int24 positionWidth;
        address native;
        address factory;
        address beefyOracle;
    }

    /// @notice Struct for balance information to reduce stack depth
    struct BalanceInfo {
        uint256 token0Bal;
        uint256 token1Bal;
        uint256 mainAmount0;
        uint256 mainAmount1;
        uint256 altAmount0;
        uint256 altAmount1;
    }

    /// @notice The main position of the strategy.
    /// @dev this will always be a 50/50 position that will be equal to position width * tickSpacing on each side.
    Position public positionMain;

    /// @notice The alternative position of the strategy.
    /// @dev this will always be a single sided (limit order) position that will start closest to current tick and continue to width * tickSpacing.
    /// This will always be in the token that has the most value after we fill our main position.
    Position public positionAlt;

    /// @notice The width of the position, thats a multiplier for tick spacing to find our range.
    int24 public positionWidth;

    /// @notice the max tick deviations we will allow for deposits/harvests.
    int56 public maxTickDeviation;

    /// @notice The twap interval seconds we use for the twap check.
    uint32 public twapInterval;

    /// @notice Bool switch to prevent reentrancy on the mint callback.
    bool private minting;

    /// @notice Initializes the ticks on first deposit.
    bool private initTicks;

    /// @notice The timestamp of the last deposit
    uint256 private lastDeposit;

    /// @notice Address of the native token (WHBAR for fee payments)
    address public native;

    /// @notice Address of the strategy factory
    address public factory;

    /// @notice Total locked profits for token0 and token1
    uint256 public totalLocked0;
    uint256 public totalLocked1;

    /// @notice Timestamp of last harvest
    uint256 public lastHarvest;

    /// @notice Timestamp of last position adjustment
    uint256 public lastPositionAdjustment;

    /// @notice Beefy Oracle for price feeds
    address public beefyOracle;

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

    // Events - Reduced for bytecode optimization
    event Harvest(uint256 fee0, uint256 fee1);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);
    event Deposit(address indexed user, uint256 amount0, uint256 amount1);
    event Withdraw(address indexed user, uint256 amount0, uint256 amount1);

    /// @notice Modifier to only allow deposit/harvest actions when current price is within a certain deviation of twap.
    modifier onlyCalmPeriods() {
        _onlyCalmPeriods();
        _;
    }

    modifier onlyRebalancers() {
        _checkManager();
        _;
    }

    /// @notice function to only allow deposit/harvest actions when current price is within a certain deviation of twap.
    function _onlyCalmPeriods() private view {
        if (!isCalm()) revert NotCalm();
    }

    /// @notice function to only allow deposit/harvest actions when current price is within a certain deviation of twap.
    function isCalm() public view returns (bool) {
        return SaucerSwapCLMLib.isPoolCalm(pool, twapInterval, maxTickDeviation);
    }

    /**
     * @notice Initializes the strategy and the inherited strat fee manager.
     * @dev Make sure cardinality is set appropriately for the twap.
     * @param _params The initialization parameters struct.
     * @param _commonAddresses The common addresses needed for the strat fee manager.
     */
    function initialize(InitParams calldata _params, CommonAddresses calldata _commonAddresses) external initializer {
        __StratFeeManager_init(_commonAddresses);
        __ReentrancyGuard_init();

        pool = _params.pool;
        quoter = _params.quoter;
        lpToken0 = IUniswapV3Pool(_params.pool).token0();
        lpToken1 = IUniswapV3Pool(_params.pool).token1();
        native = _params.native;
        factory = _params.factory;
        beefyOracle = _params.beefyOracle;

        // Our width multiplier. The tick distance of each side will be width * tickSpacing.
        positionWidth = _params.positionWidth;

        // Set the twap interval to 120 seconds.
        twapInterval = 120;

        // Set default max tick deviation to prevent deposits being blocked
        maxTickDeviation = 200;

        // Associate both tokens with this contract (all tokens on Hedera are HTS except native HBAR)
        // Only associate if not native HBAR - use safe association that doesn't revert
        if (lpToken0 != native) {
            _safeAssociateToken(lpToken0);
        }
        if (lpToken1 != native) {
            _safeAssociateToken(lpToken1);
        }

        // Give allowances - use try-catch to handle any HTS approval issues
        _safeGiveAllowances();
    }

    /// @notice Only allows the vault to call a function.
    function _onlyVault() private view {
        if (msg.sender != vault) revert NotVault();
    }

    /// @notice Called during deposit and withdraw to remove liquidity and harvest fees for accounting purposes.
    function beforeAction() external {
        _onlyVault();
        _claimEarnings();
        _removeLiquidity();
    }

    /// @notice Called during deposit to add all liquidity back to their positions.
    function deposit() external onlyCalmPeriods {
        _onlyVault();

        // Get current balances before adding liquidity
        (uint256 bal0, uint256 bal1) = balancesOfThis();

        // Add all liquidity
        if (!initTicks) {
            _setTicks();
            initTicks = true;
        }

        _addLiquidity();

        lastDeposit = block.timestamp;

        // Emit deposit event with the amounts that were deposited
        emit Deposit(vault, bal0, bal1);
    }

    /**
     * @notice Withdraws the specified amount of tokens from the strategy as calculated by the vault.
     * @param _amount0 The amount of token0 to withdraw.
     * @param _amount1 The amount of token1 to withdraw.
     */
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

        // Emit withdraw event with the amounts that were withdrawn
        emit Withdraw(vault, _amount0, _amount1);

        // After we take what is needed we add it all back to our positions.
        if (!_isPaused()) _addLiquidity();
    }

    /// @notice Adds liquidity to the main and alternative positions called on deposit, harvest and withdraw.
    function _addLiquidity() private onlyCalmPeriods {
        _whenStrategyNotPaused();

        (uint256 bal0, uint256 bal1) = balancesOfThis();

        // Then we fetch how much liquidity we get for adding at the main position ticks with our token balances.
        uint160 sqrtprice = sqrtPrice();
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtprice,
            TickMath.getSqrtRatioAtTick(positionMain.tickLower),
            TickMath.getSqrtRatioAtTick(positionMain.tickUpper),
            bal0,
            bal1
        );

        bool amountsOk = _checkAmounts(liquidity, positionMain.tickLower, positionMain.tickUpper);

        // Flip minting to true and call the pool to mint the liquidity.
        if (liquidity > 0 && amountsOk) {
            minting = true;
            IUniswapV3Pool(pool).mint(
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
            minting = true;
            IUniswapV3Pool(pool).mint(
                address(this),
                positionAlt.tickLower,
                positionAlt.tickUpper,
                liquidity,
                "Beefy Alt"
            );
        }
    }

    /// @notice Removes liquidity from the main and alternative positions, called on deposit, withdraw and harvest.
    function _removeLiquidity() private {
        // First we fetch our position keys in order to get our liquidity balances from the pool.
        (bytes32 keyMain, bytes32 keyAlt) = getKeys();

        // Fetch the liquidity balances from the pool.
        (uint128 liquidity, , , , ) = IUniswapV3Pool(pool).positions(keyMain);
        (uint128 liquidityAlt, , , , ) = IUniswapV3Pool(pool).positions(keyAlt);

        // If we have liquidity in the positions we remove it and collect our tokens.
        if (liquidity > 0) {
            IUniswapV3Pool(pool).burn(positionMain.tickLower, positionMain.tickUpper, liquidity);
            IUniswapV3Pool(pool).collect(
                address(this),
                positionMain.tickLower,
                positionMain.tickUpper,
                type(uint128).max,
                type(uint128).max
            );
        }

        if (liquidityAlt > 0) {
            IUniswapV3Pool(pool).burn(positionAlt.tickLower, positionAlt.tickUpper, liquidityAlt);
            IUniswapV3Pool(pool).collect(
                address(this),
                positionAlt.tickLower,
                positionAlt.tickUpper,
                type(uint128).max,
                type(uint128).max
            );
        }
    }

    /**
     *  @notice Checks if the amounts are ok to add liquidity.
     * @param _liquidity The liquidity to add.
     * @param _tickLower The lower tick of the position.
     * @param _tickUpper The upper tick of the position.
     * @return bool True if the amounts are ok, false if not.
     */
    function _checkAmounts(uint128 _liquidity, int24 _tickLower, int24 _tickUpper) private view returns (bool) {
        (uint256 amount0, uint256 amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPrice(),
            TickMath.getSqrtRatioAtTick(_tickLower),
            TickMath.getSqrtRatioAtTick(_tickUpper),
            _liquidity
        );

        if (amount0 == 0 || amount1 == 0) return false;
        else return true;
    }

    /// @notice Harvest call to claim fees from pool, charge fees for Beefy, then readjust our positions.
    /// @param _callFeeRecipient The address to send the call fee to.
    function harvest(address _callFeeRecipient) external {
        _harvest(_callFeeRecipient);
    }

    /// @notice Harvest call to claim fees from the pool, charge fees for Beefy, then readjust our positions.
    /// @dev Call fee goes to the tx.origin.
    function harvest() external {
        _harvest(tx.origin);
    }

    /// @notice Internal function to claim fees from the pool, charge fees for Beefy, then readjust our positions.
    function _harvest(address _callFeeRecipient) private onlyCalmPeriods {
        // Claim fees from the pool and collect them.
        _claimEarnings();
        _removeLiquidity();

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

    /// @notice Function called to moveTicks of the position
    function moveTicks() external onlyCalmPeriods onlyRebalancers {
        _claimEarnings();
        _removeLiquidity();
        _setTicks();
        _addLiquidity();

        // Event removed for bytecode optimization
    }

    /// @notice Claims fees from the pool and collects them.
    function claimEarnings() external returns (uint256 fee0, uint256 fee1, uint256 feeAlt0, uint256 feeAlt1) {
        (fee0, fee1, feeAlt0, feeAlt1) = _claimEarnings();
    }

    /// @notice Internal function to claim fees from the pool and collect them.
    function _claimEarnings() private returns (uint256 fee0, uint256 fee1, uint256 feeAlt0, uint256 feeAlt1) {
        // Claim fees
        (bytes32 keyMain, bytes32 keyAlt) = getKeys();
        (uint128 liquidity, , , , ) = IUniswapV3Pool(pool).positions(keyMain);
        (uint128 liquidityAlt, , , , ) = IUniswapV3Pool(pool).positions(keyAlt);

        // Burn 0 liquidity to make fees available to claim.
        if (liquidity > 0) IUniswapV3Pool(pool).burn(positionMain.tickLower, positionMain.tickUpper, 0);
        if (liquidityAlt > 0) IUniswapV3Pool(pool).burn(positionAlt.tickLower, positionAlt.tickUpper, 0);

        // Collect fees from the pool.
        (fee0, fee1) = IUniswapV3Pool(pool).collect(
            address(this),
            positionMain.tickLower,
            positionMain.tickUpper,
            type(uint128).max,
            type(uint128).max
        );
        (feeAlt0, feeAlt1) = IUniswapV3Pool(pool).collect(
            address(this),
            positionAlt.tickLower,
            positionAlt.tickUpper,
            type(uint128).max,
            type(uint128).max
        );

        // Set the total fees collected to state.
        fees0 = fees0 + fee0 + feeAlt0;
        fees1 = fees1 + fee1 + feeAlt1;
    }

    /**
     * @notice Internal function to charge fees for Beefy and send them to the appropriate addresses.
     * @param _callFeeRecipient The address to send the call fee to.
     * @param _amount0 The amount of token0 to charge fees on.
     * @param _amount1 The amount of token1 to charge fees on.
     * @return _amountLeft0 The amount of token0 left after fees.
     * @return _amountLeft1 The amount of token1 left after fees.
     */
    function _chargeFees(
        address _callFeeRecipient,
        uint256 _amount0,
        uint256 _amount1
    ) private returns (uint256 _amountLeft0, uint256 _amountLeft1) {
        IFeeConfig.FeeCategory memory fees = getFees();

        uint256 nativeEarned = _processToken0Fees(_amount0, fees.total);
        nativeEarned += _processToken1Fees(_amount1, fees.total);

        _amountLeft0 = _amount0 > 0 ? _amount0 - ((_amount0 * fees.total) / DIVISOR) : 0;
        _amountLeft1 = _amount1 > 0 ? _amount1 - ((_amount1 * fees.total) / DIVISOR) : 0;

        _distributeFees(_callFeeRecipient, nativeEarned, fees);
    }

    function _processToken0Fees(uint256 _amount0, uint256 _feePercent) private returns (uint256 nativeEarned) {
        if (_amount0 == 0) return 0;

        uint256 amountToSwap0 = (_amount0 * _feePercent) / DIVISOR;

        if (lpToken0 == native) {
            nativeEarned = amountToSwap0;
        } else {
            nativeEarned = IBeefySwapper(unirouter).swap(lpToken0, native, amountToSwap0);
        }
    }

    function _processToken1Fees(uint256 _amount1, uint256 _feePercent) private returns (uint256 nativeEarned) {
        if (_amount1 == 0) return 0;

        uint256 amountToSwap1 = (_amount1 * _feePercent) / DIVISOR;

        if (lpToken1 == native) {
            nativeEarned = amountToSwap1;
        } else {
            nativeEarned = IBeefySwapper(unirouter).swap(lpToken1, native, amountToSwap1);
        }
    }

    function _distributeFees(
        address _callFeeRecipient,
        uint256 _nativeEarned,
        IFeeConfig.FeeCategory memory _fees
    ) private {
        uint256 callFeeAmount = (_nativeEarned * _fees.call) / DIVISOR;
        uint256 strategistFeeAmount = (_nativeEarned * _fees.strategist) / DIVISOR;
        uint256 beefyFeeAmount = _nativeEarned - callFeeAmount - strategistFeeAmount;

        _transferTokens(native, address(this), _callFeeRecipient, callFeeAmount, true);
        _transferTokens(native, address(this), strategist, strategistFeeAmount, true);
        _transferTokens(native, address(this), beefyFeeRecipient, beefyFeeAmount, true);

        // Event removed for bytecode optimization
    }

    /**
     * @notice Returns total token balances in the strategy.
     * @return token0Bal The amount of token0 in the strategy.
     * @return token1Bal The amount of token1 in the strategy.
     */
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

    /**
     * @notice Returns total tokens sitting in the strategy.
     * @dev Since SaucerSwap uses WHBAR (not native HBAR), all tokens including WHBAR are checked as ERC20 balances.
     * @return token0Bal The amount of token0 in the strategy.
     * @return token1Bal The amount of token1 in the strategy.
     */
    function balancesOfThis() public view returns (uint256 token0Bal, uint256 token1Bal) {
        // All tokens on SaucerSwap (including WHBAR) are ERC20 tokens
        token0Bal = IERC20Metadata(lpToken0).balanceOf(address(this));
        token1Bal = IERC20Metadata(lpToken1).balanceOf(address(this));
    }

    /**
     * @notice Returns total tokens in pool positions.
     * @return balInfo The balance information struct containing all position amounts.
     */
    function balancesOfPool() public view returns (BalanceInfo memory balInfo) {
        (balInfo.mainAmount0, balInfo.mainAmount1) = _getMainPositionAmounts();
        (balInfo.altAmount0, balInfo.altAmount1) = _getAltPositionAmounts();

        balInfo.token0Bal = balInfo.mainAmount0 + balInfo.altAmount0;
        balInfo.token1Bal = balInfo.mainAmount1 + balInfo.altAmount1;
    }

    // Legacy function removed for bytecode optimization

    function _getMainPositionAmounts() private view returns (uint256 amount0, uint256 amount1) {
        if (!initTicks) {
            return (0, 0);
        }

        (bytes32 keyMain, ) = getKeys();
        (uint128 liquidity, , , uint256 owed0, uint256 owed1) = IUniswapV3Pool(pool).positions(keyMain);

        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPrice(),
            TickMath.getSqrtRatioAtTick(positionMain.tickLower),
            TickMath.getSqrtRatioAtTick(positionMain.tickUpper),
            liquidity
        );

        amount0 += owed0;
        amount1 += owed1;
    }

    function _getAltPositionAmounts() private view returns (uint256 amount0, uint256 amount1) {
        if (!initTicks) {
            return (0, 0);
        }

        (, bytes32 keyAlt) = getKeys();
        (uint128 liquidity, , , uint256 owed0, uint256 owed1) = IUniswapV3Pool(pool).positions(keyAlt);

        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPrice(),
            TickMath.getSqrtRatioAtTick(positionAlt.tickLower),
            TickMath.getSqrtRatioAtTick(positionAlt.tickUpper),
            liquidity
        );

        amount0 += owed0;
        amount1 += owed1;
    }

    /**
     * @notice Returns the amount of locked profit in the strategy, this is linearly release over a duration defined in the fee manager.
     * @return locked0 The amount of token0 locked in the strategy.
     * @return locked1 The amount of token1 locked in the strategy.
     */
    // lockedProfit function removed for bytecode optimization

    /**
     * @notice Returns the range of the pool, will always be the main position.
     * @return lowerPrice The lower price of the position.
     * @return upperPrice The upper price of the position.
     */
    function range() external view returns (uint256 lowerPrice, uint256 upperPrice) {
        return SaucerSwapCLMLib.calculateRangePrices(positionMain.tickLower, positionMain.tickUpper);
    }

    /**
     * @notice Returns the keys for the main and alternative positions.
     * @return keyMain The key for the main position.
     * @return keyAlt The key for the alternative position.
     */
    function getKeys() public view returns (bytes32 keyMain, bytes32 keyAlt) {
        keyMain = keccak256(abi.encodePacked(address(this), positionMain.tickLower, positionMain.tickUpper));
        keyAlt = keccak256(abi.encodePacked(address(this), positionAlt.tickLower, positionAlt.tickUpper));
    }

    /**
     * @notice The current tick of the pool.
     * @return tick The current tick of the pool.
     */
    function currentTick() public view returns (int24 tick) {
        (, tick, , , , , ) = IUniswapV3Pool(pool).slot0();
    }

    /**
     * @notice The current price of the pool.
     */
    function price() public view returns (uint256 _price) {
        return SaucerSwapCLMLib.getPoolPrice(pool);
    }

    /**
     * @notice The sqrt price of the pool.
     */
    function sqrtPrice() public view returns (uint160 sqrtPriceX96) {
        return SaucerSwapCLMLib.getPoolSqrtPrice(pool);
    }

    /**
     * @notice The swap fee variable is the fee charged for swaps in the underlying pool in 18 decimals
     * @return fee The swap fee of the underlying pool
     */
    function swapFee() external view override returns (uint256 fee) {
        return SaucerSwapCLMLib.getPoolFee(pool);
    }

    /**
     * @notice The tick distance of the pool.
     * @return int24 The tick distance/spacing of the pool.
     */
    function _tickDistance() private view returns (int24) {
        return IUniswapV3Pool(pool).tickSpacing();
    }

    /**
     * @notice Callback function for SaucerSwap V3 pool to call when minting liquidity.
     * @param amount0 Amount of token0 owed to the pool
     * @param amount1 Amount of token1 owed to the pool
     * bytes Additional data but unused in this case.
     */
    function uniswapV3MintCallback(uint256 amount0, uint256 amount1, bytes memory /*data*/) external {
        if (msg.sender != pool) revert NotPool();
        if (!minting) revert InvalidEntry();

        // Set minting to false BEFORE external calls to prevent reentrancy
        minting = false;

        if (amount0 > 0) {
            _transferTokens(lpToken0, address(this), pool, amount0, true);
        }
        if (amount1 > 0) {
            _transferTokens(lpToken1, address(this), pool, amount1, true);
        }
    }

    /// @notice Sets the tick positions for the main and alternative positions.
    function _setTicks() private onlyCalmPeriods {
        int24 tick = currentTick();
        int24 distance = _tickDistance();
        int24 width = positionWidth * distance;

        _setMainTick(tick, distance, width);
        _setAltTick(tick, distance, width);

        lastPositionAdjustment = block.timestamp;
    }

    /// @notice Sets the main tick position.
    function _setMainTick(int24 tick, int24 distance, int24 width) private {
        (positionMain.tickLower, positionMain.tickUpper) = TickUtils.baseTicks(tick, width, distance);
    }

    /// @notice Sets the alternative tick position.
    function _setAltTick(int24 tick, int24 distance, int24 width) private {
        (uint256 bal0, uint256 bal1) = balancesOfThis();

        // We calculate how much token0 we have in the price of token1.
        uint256 amount0;

        if (bal0 > 0) {
            // Use FullMath.mulDiv to prevent overflow
            amount0 = FullMath.mulDiv(bal0, price(), PRECISION);
        }

        // We set the alternative position based on the token that has the most value available.
        if (amount0 < bal1) {
            (positionAlt.tickLower, ) = TickUtils.baseTicks(tick, width, distance);

            (positionAlt.tickUpper, ) = TickUtils.baseTicks(tick, distance, distance);
        } else if (bal1 < amount0) {
            (, positionAlt.tickLower) = TickUtils.baseTicks(tick, distance, distance);

            (, positionAlt.tickUpper) = TickUtils.baseTicks(tick, width, distance);
        } else {
            // Default case when both balances are 0 or equal - set alt position to token0 side (different from main)
            (, positionAlt.tickLower) = TickUtils.baseTicks(tick, distance, distance);

            (, positionAlt.tickUpper) = TickUtils.baseTicks(tick, width, distance);
        }

        if (positionMain.tickLower == positionAlt.tickLower && positionMain.tickUpper == positionAlt.tickUpper)
            revert InvalidTicks();
    }

    /**
     * @notice Helper function to transfer tokens - handles native HBAR and HTS tokens
     * @param token The token address
     * @param from The sender address
     * @param to The recipient address
     * @param amount The amount to transfer
     * @param isFromContract Whether the transfer is from this contract
     */
    function _transferTokens(address token, address from, address to, uint256 amount, bool isFromContract) internal {
        if (amount == 0) return;

        bool isNative = (token == native);

        if (isNative) {
            // For native tokens (HBAR), use native transfer
            if (isFromContract) {
                AddressUpgradeable.sendValue(payable(to), amount);
            } else {
                // When receiving native tokens, they should come with msg.value
                require(msg.value >= amount, "Insufficient native token sent");
            }
        } else {
            // All other tokens on Hedera are HTS tokens, use HTS precompile
            _transferHTS(token, from, to, amount);
        }
    }

    /**
     * @notice Transfer HTS tokens using standard ERC20 interface
     * @param token The HTS token address
     * @param from The sender address
     * @param to The recipient address
     * @param amount The amount to transfer
     */
    function _transferHTS(address token, address from, address to, uint256 amount) internal {
        if (from == address(this)) {
            IERC20Metadata(token).safeTransfer(to, amount);
        } else {
            IERC20Metadata(token).safeTransferFrom(from, to, amount);
        }
    }

    /**
     * @notice Associate this contract with an HTS token
     * @param token The HTS token address to associate with this contract
     */
    function _associateToken(address token) internal {
        if (token == address(0)) revert InvalidTokenAddress();

        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;

        if (responseCode != HTS_SUCCESS) {
            revert HTSAssociationFailed();
        }

        // Event removed for bytecode optimization
    }

    /**
     * @notice Safely associate this contract with an HTS token without reverting
     * @param token The HTS token address to associate with this contract
     * @return success True if association succeeded or token was already associated
     */
    function _safeAssociateToken(address token) internal returns (bool success) {
        if (token == address(0)) return false;

        (bool callSuccess, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = callSuccess ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;

        // Success codes: 22 (SUCCESS) or 23 (TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT)
        return responseCode == HTS_SUCCESS || responseCode == 23;
    }

    // Path setter functions removed for bytecode optimization

    /**
     * @notice Sets the deviation from the twap we will allow on adding liquidity.
     * @param _maxDeviation The max deviation from twap we will allow.
     */
    function setDeviation(int56 _maxDeviation) external onlyOwner {
        // Event removed for bytecode optimization

        // Require the deviation to be less than or equal to 4 times the tick spacing.
        if (_maxDeviation >= _tickDistance() * 4) revert InvalidInput();

        maxTickDeviation = _maxDeviation;
    }

    // Token price functions removed for bytecode optimization

    /**
     * @notice The twap of the last minute from the pool.
     * @return twapTick The twap of the last minute from the pool.
     */
    function twap() public view returns (int56 twapTick) {
        return SaucerSwapCLMLib.getTwap(pool, twapInterval);
    }

    function setTwapInterval(uint32 _interval) external onlyOwner {
        // Event removed for bytecode optimization

        // Require the interval to be greater than 60 seconds.
        if (_interval < 60) revert InvalidInput();

        twapInterval = _interval;
    }

    // setPositionWidth function removed for bytecode optimization

    /**
     * @notice set the unirouter address
     * @param _unirouter The new unirouter address
     */
    function setUnirouter(address _unirouter) external override onlyOwner {
        _removeAllowances();
        unirouter = _unirouter;
        _giveAllowances();
        emit SetUnirouter(_unirouter);
    }

    /// @notice Retire the strategy and return all the dust to the fee recipient.
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

    /**
     * @notice Remove Liquidity and Allowances, then pause deposits.
     * @param _minAmount0 The minimum amount of token0 in the strategy after panic.
     * @param _minAmount1 The minimum amount of token1 in the strategy after panic.
     */
    function panic(uint256 _minAmount0, uint256 _minAmount1) public onlyManager {
        _claimEarnings();
        _removeLiquidity();
        _removeAllowances();
        _pause();

        (uint256 bal0, uint256 bal1) = balances();
        if (bal0 < _minAmount0 || bal1 < _minAmount1) revert TooMuchSlippage();
    }

    /// @notice Unpause deposits, give allowances and add liquidity.
    function unpause() external onlyManager {
        if (owner() == address(0)) revert NotAuthorized();
        _giveAllowances();
        _unpause();
        _setTicks();
        _addLiquidity();
    }

    /// @notice gives swap permisions for the tokens to the unirouter.
    function _giveAllowances() private {
        // Only approve non-native tokens (HTS tokens need ERC20 approvals for swapping)
        if (lpToken0 != native) {
            IERC20Metadata(lpToken0).approve(unirouter, type(uint256).max);
        }
        if (lpToken1 != native) {
            IERC20Metadata(lpToken1).approve(unirouter, type(uint256).max);
        }
    }

    /// @notice safely gives swap permisions for the tokens to the unirouter without reverting.
    function _safeGiveAllowances() private {
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
    }

    /// @notice removes swap permisions for the tokens from the unirouter.
    function _removeAllowances() private {
        // Only revoke approvals for non-native tokens
        if (lpToken0 != native) {
            IERC20Metadata(lpToken0).approve(unirouter, 0);
        }
        if (lpToken1 != native) {
            IERC20Metadata(lpToken1).approve(unirouter, 0);
        }
    }

    /// @notice Check if strategy is paused
    function _isPaused() internal view returns (bool) {
        return paused();
    }

    /// @notice Check if strategy is not paused
    function _whenStrategyNotPaused() internal view {
        require(!paused(), "Strategy is paused");
    }

    /// @notice Allow the owner to manually associate this contract with an HTS token
    function associateToken(address token) external onlyOwner {
        _associateToken(token);
    }

    /// @notice Update Beefy Oracle address
    function setBeefyOracle(address _beefyOracle) external onlyOwner {
        require(_beefyOracle != address(0), "Invalid oracle address");
        beefyOracle = _beefyOracle;
    }

    /// @notice Returns the price of the first token in native token
    function lpToken0ToNativePrice() external returns (uint256) {
        uint256 amount = 10 ** IERC20Metadata(lpToken0).decimals() / 10;
        if (lpToken0 == native) return amount * 10;

        // For SaucerSwap, we can use a simple direct path since it's based on UniswapV3
        // Path for token0 -> WHBAR (native)
        bytes memory path = abi.encodePacked(lpToken0, uint24(3000), native);

        try IQuoter(quoter).quoteExactInput(path, amount) returns (uint256 amountOut) {
            return amountOut * 10;
        } catch {
            // If quoter fails, return 0 to indicate unavailable price
            return 0;
        }
    }

    /// @notice Returns the price of the second token in native token
    function lpToken1ToNativePrice() external returns (uint256) {
        uint256 amount = 10 ** IERC20Metadata(lpToken1).decimals() / 10;
        if (lpToken1 == native) return amount * 10;

        // For SaucerSwap, we can use a simple direct path since it's based on UniswapV3
        // Path for token1 -> WHBAR (native)
        bytes memory path = abi.encodePacked(lpToken1, uint24(3000), native);

        try IQuoter(quoter).quoteExactInput(path, amount) returns (uint256 amountOut) {
            return amountOut * 10;
        } catch {
            // If quoter fails, return 0 to indicate unavailable price
            return 0;
        }
    }

    /// @notice Receive function to accept native token deposits
    receive() external payable {}
}
