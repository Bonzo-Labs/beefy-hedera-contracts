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
import "../../interfaces/beefy/IStrategyConcLiq.sol";
import "../../interfaces/saucerswap/IUniswapV3Factory.sol";
import "../../Hedera/IHederaTokenService.sol";
import "../../interfaces/oracle/IBeefyOracle.sol";
import "../Bonzo/SaucerSwapCLMLib.sol";
import "../Bonzo/SaucerSwapLariLib.sol";

contract SaucerSwapLariRewardsCLMStrategy is
    ReentrancyGuardUpgradeable,
    StratFeeManagerInitializable,
    IStrategyConcLiq
{
    using SafeERC20 for IERC20Metadata;
    using TickMath for int24;
    using AddressUpgradeable for address payable;
    uint256 private constant PRECISION = 1e18;
    address private constant HTS_PRECOMPILE = address(0x167);
    int64 private constant HTS_SUCCESS = 22;
    int64 private constant PRECOMPILE_BIND_ERROR = -1;
    uint256 private constant MINT_SLIPPAGE_TOLERANCE = 2000;
    uint256 private constant PRICE_DEVIATION_TOLERANCE = 200;

    IWHBARHelper private whbarHelper;
    address public pool;
    address public lpToken0;
    address public lpToken1;
    uint256 private fees0;
    uint256 private fees1;
    struct Position {
        int24 tickLower;
        int24 tickUpper;
    }
    struct InitParams {
        address pool;
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
    uint256 private totalLocked0;
    uint256 private totalLocked1;
    uint256 public lastHarvest;
    uint256 private pendingRewardLock0;
    uint256 private pendingRewardLock1;
    uint256 private lastRewardLockUpdate;
    uint256 public lastPositionAdjustment;
    address private beefyOracle;
    uint256 private leftover0;
    uint256 private leftover1;
    // Track the strategy balances before the vault sends deposit tokens
    uint256 private balanceBeforeDeposit0;
    uint256 private balanceBeforeDeposit1;
    SaucerSwapLariLib.RewardToken[] public rewardTokens;
    mapping(address => uint256) private rewardTokenIndex;
    mapping(address => bool) private isRewardToken;
    uint256 public lockDuration;
    // Errors
    error NotAuthorized();
    error NotPool();
    error InvalidEntry();
    error NotVault();
    error InvalidInput();
    error NotCalm();
    error TooMuchSlippage();
    error InvalidTicks();
    error TokenExists();

    // Events
    event Harvest(uint256 fee0, uint256 fee1);
    event Deposit(address indexed user, uint256 amount0, uint256 amount1);
    event Withdraw(address indexed user, uint256 amount0, uint256 amount1);
    event RewardTokenAdded(address indexed token, bool isHTS);
    event RewardTokenRemoved(address indexed token);
    event RewardTokenUpdated(address indexed token, bool isActive);
    event ClaimEarnings(uint256 fee0, uint256 fee1, uint256 feeAlt0, uint256 feeAlt1);
    event LockDurationUpdated(uint256 oldDuration, uint256 newDuration);
    modifier onlyCalmPeriods() {
        _onlyCalmPeriods();
        _;
    }

    modifier onlyRebalancers() {
        _checkManager();
        _;
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
        lpToken0 = ISaucerSwapPool(_params.pool).token0();
        lpToken1 = ISaucerSwapPool(_params.pool).token1();
        native = _params.native;
        factory = _params.factory;
        beefyOracle = _params.beefyOracle;
        positionWidth = _params.positionWidth; // Our width multiplier. The tick distance of each side will be width * tickSpacing.
        twapInterval = 120; // Set the twap interval to 120 seconds.
        maxTickDeviation = 200; // Set default max tick deviation
        lockDuration = 21600;
        if (lpToken0 != native) {
            SaucerSwapCLMLib.safeAssociateToken(lpToken0);
        }
        if (lpToken1 != native) {
            SaucerSwapCLMLib.safeAssociateToken(lpToken1);
        }
        for (uint256 i = 0; i < _params.rewardTokens.length; i++) {
            _addRewardToken(_params.rewardTokens[i], true); // Assume all are HTS initially
        }
        whbarHelper = IWHBARHelper(
            block.chainid == 295
                ? 0x000000000000000000000000000000000058A2BA
                : 0x000000000000000000000000000000000050a8a7
        );
        // _safeGiveAllowances();
    }

    function _onlyVault() private view {
        if (msg.sender != vault) revert NotVault();
    }

    function beforeAction() external {
        _onlyVault();
        _claimEarnings();
        // Store balances before the vault sends new deposit tokens
        (balanceBeforeDeposit0, balanceBeforeDeposit1) = balancesOfThis();
        // _removeLiquidity();
    }

    function deposit() external onlyCalmPeriods {
        _onlyVault();
        (uint256 balBefore0, uint256 balBefore1) = balancesOfThis(); // Current balances before adding liquidity
        if (!initTicks) {
            _setTicks();
            initTicks = true;
        }
        _addLiquidity();
        (uint256 balAfter0, uint256 balAfter1) = balancesOfThis();
        // Only report the unused portion from THIS deposit as leftovers
        leftover0 = balAfter0 > balanceBeforeDeposit0 ? balAfter0 - balanceBeforeDeposit0 : 0;
        leftover1 = balAfter1 > balanceBeforeDeposit1 ? balAfter1 - balanceBeforeDeposit1 : 0;
        lastDeposit = block.timestamp;
        // Emit only the amounts deposited by the current user (not entire balance)
        uint256 userDeposited0 = balBefore0 > balanceBeforeDeposit0 ? balBefore0 - balanceBeforeDeposit0 : 0;
        uint256 userDeposited1 = balBefore1 > balanceBeforeDeposit1 ? balBefore1 - balanceBeforeDeposit1 : 0;
        emit Deposit(vault, userDeposited0, userDeposited1);
    }

    function withdraw(uint256 _amount0, uint256 _amount1) external {
        _onlyVault();
        if (block.timestamp == lastDeposit) _onlyCalmPeriods();

        _removeLiquidity(); // Since we commented it out in beforeAction(), we need to remove it here.
        if (_amount0 > 0) {
            if(withdrawalFee > 0) {
                uint256 wfee0 = (_amount0 * withdrawalFee) / WITHDRAWAL_MAX;
                _amount0 = _amount0 - wfee0;
                _transferTokens(lpToken0, address(this), beefyFeeRecipient, wfee0, true);
            }
            _transferTokens(lpToken0, address(this), vault, _amount0, true);
        }
        if (_amount1 > 0) {
            if(withdrawalFee > 0) {
                uint256 wfee1 = (_amount1 * withdrawalFee) / WITHDRAWAL_MAX;
                _amount1 = _amount1 - wfee1;
                _transferTokens(lpToken1, address(this), beefyFeeRecipient, wfee1, true);
            }
            _transferTokens(lpToken1, address(this), vault, _amount1, true);
        }
        emit Withdraw(vault, _amount0, _amount1);
        if (!_isPaused()) _addLiquidity();
    }

    function _addLiquidity() private onlyCalmPeriods {
        _whenStrategyNotPaused();
        uint256 hbarBalanceBefore = address(this).balance > 0 && address(this).balance > msg.value ? address(this).balance - msg.value : 0;

        (uint256 bal0, uint256 bal1) = balancesOfThis();
        uint256 mintFee = updateMintFeeWithFreshPrice();
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
            require(address(this).balance >= mintFee, "Insuf HBAR Mint Fee");
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
            require(address(this).balance >= mintFee, "Insuf HBAR Mint Fee");
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

        uint256 hbarBalanceAfter = address(this).balance;
        // Return excess HBAR to msg.sender (the immediate caller)
        // This prevents tx.origin exploits where malicious signers could drain treasury funds
        // The vault can receive HBAR and will handle user refunds appropriately
        if (hbarBalanceAfter > hbarBalanceBefore) {
            AddressUpgradeable.sendValue(payable(msg.sender), hbarBalanceAfter - hbarBalanceBefore);
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

    function processLariRewards() external {
        _processLariRewards();
    }
    
    function harvest(address _callFeeRecipient) external payable {
        _harvest(_callFeeRecipient);
    }

    function harvest() external payable {
        _harvest(tx.origin);
    }

    // In the harvest function, we WILL NOT remove and add liquidity because this creates >50 child transactions and fails on-chain.
    // What we do in the cron job - we call harvest() and then moveTicks() one after the other.
    function _harvest(address _callFeeRecipient) private onlyCalmPeriods {
        require(msg.value >= 2*getMintFee(), "IMF");
        // Claim fees from the pool and collect them.
        _claimEarnings();
        _removeLiquidity();
        // Charge fees for Beefy and send them to the appropriate addresses, charge fees to accrued state fee amounts.
        (uint256 fee0, uint256 fee1) = _chargeFees(_callFeeRecipient, fees0, fees1);
        _addLiquidity();
        // Reset state fees to 0.
        fees0 = 0;
        fees1 = 0;

        _refreshRewardLocks();
        if (pendingRewardLock0 > 0 || pendingRewardLock1 > 0) {
            pendingRewardLock0 = 0;
            pendingRewardLock1 = 0;
            lastRewardLockUpdate = block.timestamp;
        }
        
        // Calculate remaining locked amounts and add new fees
        uint256 timeElapsed = block.timestamp - lastHarvest;
        
        uint256 duration = lockDuration;
        if (duration == 0 || timeElapsed >= duration) {
            // All locked amounts have been unlocked (or locking disabled)
            totalLocked0 = fee0;
            totalLocked1 = fee1;
        } else {
            // Calculate remaining locked amounts
            uint256 remaining = duration - timeElapsed;
            totalLocked0 = (totalLocked0 * remaining) / duration + fee0;
            totalLocked1 = (totalLocked1 * remaining) / duration + fee1;
        }
        // Log the last time we claimed fees.
        lastHarvest = block.timestamp;
        // Log the fees post Beefy fees.
        emit Harvest(fee0, fee1);
    }

    function _processLariRewards() private {
        (uint256 newFees0, uint256 newFees1) = SaucerSwapLariLib.processLariRewards(
            rewardTokens,
            unirouter,
            lpToken0,
            lpToken1,
            native,
            whbarHelper
        );
        fees0 += newFees0;
        fees1 += newFees1;
        _lockRewardFees(newFees0, newFees1);
    }

    // This function will be called by Bonzo every 30 min or so in order to re-balance the positions.
    // What we do in the cron job - we call harvest() and then moveTicks() one after the other.
    function moveTicks() external payable onlyCalmPeriods onlyRebalancers {
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
        emit ClaimEarnings(fee0, fee1, feeAlt0, feeAlt1);
    }

    function _chargeFees(
        address _callFeeRecipient,
        uint256 _amount0,
        uint256 _amount1
    ) private returns (uint256 _amountLeft0, uint256 _amountLeft1) {
        IFeeConfig.FeeCategory memory fees = getFees();
        (_amountLeft0, _amountLeft1) = SaucerSwapLariLib.calculateFeesLeft(_amount0, _amount1, fees.total, DIVISOR);
        (uint256 feeAmount0, uint256 feeAmount1) = SaucerSwapLariLib.calculateLPTokenFees(
            _amount0,
            _amount1,
            fees.total,
            DIVISOR
        );
        SaucerSwapLariLib.distributeLPTokenFees(
            _callFeeRecipient,
            strategist,
            beefyFeeRecipient,
            feeAmount0,
            feeAmount1,
            fees.call,
            fees.strategist,
            DIVISOR,
            lpToken0,
            lpToken1,
            native
        );
    }

    function balances() public view returns (uint256 token0Bal, uint256 token1Bal) {
        (uint256 thisBal0, uint256 thisBal1) = balancesOfThis();
        BalanceInfo memory poolInfo = balancesOfPool();
        return (thisBal0 + poolInfo.token0Bal, thisBal1 + poolInfo.token1Bal);
    }

    function lockedBalances() external view returns (uint256 locked0, uint256 locked1) {
        return _lockedBalances();
    }

    function _lockedBalances() private view returns (uint256 locked0, uint256 locked1) {
        uint256 duration = lockDuration;
        if (duration != 0) {
            uint256 timeElapsed = block.timestamp - lastHarvest;
            if (timeElapsed < duration) {
                uint256 remaining = duration - timeElapsed;
                locked0 = (totalLocked0 * remaining) / duration;
                locked1 = (totalLocked1 * remaining) / duration;
            }
        }

        (uint256 rewardLocked0, uint256 rewardLocked1) = _pendingRewardLocks();
        locked0 += rewardLocked0;
        locked1 += rewardLocked1;
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
        return
            SaucerSwapLariLib.getMainPositionAmounts(
                pool,
                address(this),
                positionMain.tickLower,
                positionMain.tickUpper,
                initTicks
            );
    }

    function _getAltPositionAmounts() private view returns (uint256 amount0, uint256 amount1) {
        return
            SaucerSwapLariLib.getAltPositionAmounts(
                pool,
                address(this),
                positionAlt.tickLower,
                positionAlt.tickUpper,
                initTicks
            );
    }

    function getMintFee() public view returns (uint256 mintFee) {
        mintFee = _getMintFeeFromPool();
        // Convert tinycent US to HBAR using oracle
        if (beefyOracle != address(0)) {
            try IBeefyOracle(beefyOracle).getPriceInUSD(native) returns (uint256 hbarPrice) {
                if (hbarPrice > 0) {
                    //get the price of usdc in hbar
                    //hbar price is in usd
                    //1e26: 1e18 * 1e8 (1e18 is the decimals of usdc, 1e8 is the decimals of hbar)
                    //1e10: 1e18 * 1e-8 (1e18 is the decimals of usdc , 1e-8  since tinycentUSFee is in usdc)
                    mintFee = (mintFee * 1e26) / (hbarPrice * 1e10);
                    mintFee = mintFee * 150 / 100;
                } else {
                    revert("HBAR-PF");
                }
            } catch {
                revert("HBAR-PF2");
            }
        } else {
            revert("!BO");
        }
    }

    function _getMintFeeFromPool() private view returns (uint256 mintFee) {
        address poolFactory = ISaucerSwapPool(pool).factory();
        uint256 tinycentUSFee = IUniswapV3Factory(poolFactory).mintFee();
        //add 10% to the mint fee
        mintFee = (tinycentUSFee * 110) / 100;
        return mintFee;
    }

    function updateMintFeeWithFreshPrice() public returns (uint256 mintFee) {
        mintFee = _getMintFeeFromPool();
        
        if (beefyOracle != address(0)) {
            try IBeefyOracle(beefyOracle).getFreshPriceInUSD(native) returns (uint256 hbarPrice, bool success) {
                if (success && hbarPrice > 0) {
                    mintFee = (mintFee * 1e26) / (hbarPrice * 1e10);
                    mintFee = mintFee * 150 / 100;
                } else {
                    revert("HBAR-PF");
                }
            } catch {
                revert("HBAR-PF2");
            }
        } else {
            revert("!BO");
        }
        return mintFee;
    }

    function range() external view returns (uint256 lowerPrice, uint256 upperPrice) {
        return SaucerSwapCLMLib.calculateRangePrices(pool, positionMain.tickLower, positionMain.tickUpper);
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

    function uniswapV3MintCallback(uint256 amount0, uint256 amount1, bytes memory /*data*/) external payable nonReentrant {
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

    function _transferTokens(
        address token,
        address /* from */,
        address to,
        uint256 amount,
        bool /* isFromContract */
    ) internal {
        if(amount == 0) return;
        SaucerSwapLariLib.transferTokens(token, to, amount);
    }

    function _lockRewardFees(uint256 amount0, uint256 amount1) private {
        if (lockDuration == 0 || (amount0 == 0 && amount1 == 0)) {
            return;
        }
        _refreshRewardLocks();
        pendingRewardLock0 += amount0;
        pendingRewardLock1 += amount1;
        lastRewardLockUpdate = block.timestamp;
    }

    function _refreshRewardLocks() private {
        if (pendingRewardLock0 == 0 && pendingRewardLock1 == 0) {
            return;
        }

        uint256 duration = lockDuration;
        if (duration == 0) {
            pendingRewardLock0 = 0;
            pendingRewardLock1 = 0;
            lastRewardLockUpdate = block.timestamp;
            return;
        }

        uint256 lastUpdate = lastRewardLockUpdate;
        if (lastUpdate == 0) {
            lastRewardLockUpdate = block.timestamp;
            return;
        }

        uint256 elapsed = block.timestamp - lastUpdate;
        if (elapsed == 0) {
            return;
        }

        if (elapsed >= duration) {
            pendingRewardLock0 = 0;
            pendingRewardLock1 = 0;
        } else {
            uint256 remaining = duration - elapsed;
            pendingRewardLock0 = (pendingRewardLock0 * remaining) / duration;
            pendingRewardLock1 = (pendingRewardLock1 * remaining) / duration;
        }
        lastRewardLockUpdate = block.timestamp;
    }

    function _pendingRewardLocks() private view returns (uint256 locked0, uint256 locked1) {
        uint256 duration = lockDuration;
        uint256 lastUpdate = lastRewardLockUpdate;
        if (
            duration == 0 ||
            lastUpdate == 0 ||
            (pendingRewardLock0 == 0 && pendingRewardLock1 == 0)
        ) {
            return (0, 0);
        }

        uint256 elapsed = block.timestamp - lastUpdate;
        if (elapsed >= duration) {
            return (0, 0);
        }

        uint256 remaining = duration - elapsed;
        locked0 = (pendingRewardLock0 * remaining) / duration;
        locked1 = (pendingRewardLock1 * remaining) / duration;
    }

    function _associateToken(address token) internal {
        SaucerSwapCLMLib.safeAssociateToken(token);
    }

    function setPositionWidth(int24 _positionWidth) external onlyOwner payable {
        // Validate width against tick spacing and global tick bounds
        int24 distance = _tickDistance();
        // if (_positionWidth <= 0) revert InvalidInput();
        int24 width = _positionWidth * distance;
        int24 tick = currentTick();
        int24 tickFloor = TickUtils.floor(tick, distance);
        if (tickFloor - width < -887272 || tickFloor + width > 887272) revert InvalidInput();

        _removeLiquidity();
        positionWidth = _positionWidth;
        _setTicks();
        _addLiquidity();
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

    function retireStrategy() external onlyOwner {
        panic(0, 0);
        (uint bal0, uint bal1) = balancesOfThis();
        if (bal0 > 0) {
            _transferTokens(lpToken0, address(this), vault, bal0, true);
        }
        if (bal1 > 0) {
            _transferTokens(lpToken1, address(this), vault, bal1, true);
        }
        if(address(this).balance > 0) {
            AddressUpgradeable.sendValue(payable(vault), address(this).balance);
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
        // _giveAllowances();
        _unpause();
        // _setTicks();
        // _addLiquidity();
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
        require(!paused(), "SP");
    }

    function associateToken(address token) external onlyOwner {
        _associateToken(token);
    }

    function setBeefyOracle(address _beefyOracle) external onlyOwner {
        require(_beefyOracle != address(0), "BO-IA");
        beefyOracle = _beefyOracle;
    }


    function addRewardToken(address _token, bool _isHTS) external onlyManager {
        if (isRewardToken[_token]) revert TokenExists();
        _addRewardToken(_token, _isHTS);
    }

    function _addRewardToken(address _token, bool _isHTS) internal {
        SaucerSwapLariLib.addRewardToken(
            rewardTokens,
            rewardTokenIndex,
            isRewardToken,
            _token,
            _isHTS,
            lpToken0,
            lpToken1
        );
        emit RewardTokenAdded(_token, _isHTS);
    }

    function updateRewardTokenStatus(address _token, bool _isActive) external onlyManager {
        SaucerSwapLariLib.updateRewardTokenStatus(rewardTokens, rewardTokenIndex, isRewardToken, _token, _isActive);
        emit RewardTokenUpdated(_token, _isActive);
    }

    function setRewardRoute(
        address _token,
        address[] calldata _toLp0Route,
        address[] calldata _toLp1Route,
        uint24[] calldata _lp0RoutePoolFees,
        uint24[] calldata _lp1RoutePoolFees
    ) external onlyManager {
        SaucerSwapLariLib.setRewardRoute(
            rewardTokens,
            rewardTokenIndex,
            isRewardToken,
            _token,
            _toLp0Route,
            _toLp1Route,
            _lp0RoutePoolFees,
            _lp1RoutePoolFees
        );
    }

    function setLockDuration(uint256 _lockDuration) external onlyManager {
        _refreshRewardLocks();
        uint256 oldDuration = lockDuration;
        lockDuration = _lockDuration;
        if (_lockDuration == 0) {
            pendingRewardLock0 = 0;
            pendingRewardLock1 = 0;
            lastRewardLockUpdate = block.timestamp;
        }
        emit LockDurationUpdated(oldDuration, _lockDuration);
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
        SaucerSwapCLMLib.validateMintSlippage(
            amount0,
            amount1,
            expectedAmount0,
            expectedAmount1,
            MINT_SLIPPAGE_TOLERANCE,
            bal0,
            bal1
        );
    }

    function _calculateLiquidityWithPriceCheck(
        uint160 initialSqrtPrice,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0,
        uint256 amount1
    ) private view returns (uint128 liquidity, uint160 adjustedSqrtPrice) {
        return
            SaucerSwapCLMLib.calculateLiquidityWithPriceCheck(
                pool,
                initialSqrtPrice,
                tickLower,
                tickUpper,
                amount0,
                amount1,
                PRICE_DEVIATION_TOLERANCE
            );
    }

    receive() external payable {}
    // fallback() external payable {}
}
