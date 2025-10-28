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
import "../../interfaces/oracle/IBeefyOracle.sol";
import "./SaucerSwapCLMLib.sol";

contract StrategyPassiveManagerSaucerSwap is
    ReentrancyGuardUpgradeable,
    StratFeeManagerInitializable,
    IStrategyConcLiq
{
    using SafeERC20 for IERC20Metadata;
    using TickMath for int24;
    using AddressUpgradeable for address payable;

    uint256 public constant DURATION = 21600;
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
    uint256 public constant MINT_SLIPPAGE_TOLERANCE = 1000;
    uint256 public constant PRICE_DEVIATION_TOLERANCE = 200;
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
    uint256 private balanceBeforeDeposit0;
    uint256 private balanceBeforeDeposit1;
    bool private depositPrepared;

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
    error InsufficientHBARForMintFee();
    error MintSlippageExceeded();
    error DepositNotPrepared();

    event Harvest(uint256 fee0, uint256 fee1);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);
    event Deposit(address indexed user, uint256 amount0, uint256 amount1);
    event Withdraw(address indexed user, uint256 amount0, uint256 amount1);

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
        quoter = _params.quoter;
        lpToken0 = ISaucerSwapPool(_params.pool).token0();
        lpToken1 = ISaucerSwapPool(_params.pool).token1();
        native = _params.native;
        factory = _params.factory;
        beefyOracle = _params.beefyOracle;

        positionWidth = _params.positionWidth;
        twapInterval = 120;
        maxTickDeviation = 200;

        if (lpToken0 != native) {
            SaucerSwapCLMLib.safeAssociateToken(lpToken0);
        }
        if (lpToken1 != native) {
            SaucerSwapCLMLib.safeAssociateToken(lpToken1);
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
        (balanceBeforeDeposit0, balanceBeforeDeposit1) = balancesOfThis();
        depositPrepared = true;
    }

    function deposit() external onlyCalmPeriods {
        _onlyVault();
        if (!depositPrepared) revert DepositNotPrepared();
        (uint256 balBefore0, uint256 balBefore1) = balancesOfThis();
        if (!initTicks) {
            _setTicks();
            initTicks = true;
        }
        _addLiquidity();
        (uint256 balAfter0, uint256 balAfter1) = balancesOfThis();
        leftover0 = balAfter0 > balanceBeforeDeposit0 ? balAfter0 - balanceBeforeDeposit0 : 0;
        leftover1 = balAfter1 > balanceBeforeDeposit1 ? balAfter1 - balanceBeforeDeposit1 : 0;
        lastDeposit = block.timestamp;
        uint256 userDeposited0 = balBefore0 > balanceBeforeDeposit0 ? balBefore0 - balanceBeforeDeposit0 : 0;
        uint256 userDeposited1 = balBefore1 > balanceBeforeDeposit1 ? balBefore1 - balanceBeforeDeposit1 : 0;
        emit Deposit(vault, userDeposited0, userDeposited1);
        balanceBeforeDeposit0 = 0;
        balanceBeforeDeposit1 = 0;
        depositPrepared = false;
    }

    function withdraw(uint256 _amount0, uint256 _amount1) external {
        // It removes liquidity in beforeAction()
        _onlyVault();
        if (block.timestamp == lastDeposit) _onlyCalmPeriods();
        if (_amount0 > 0) {
            _transferTokens(lpToken0, address(this), vault, _amount0, true);
        }
        if (_amount1 > 0) {
            _transferTokens(lpToken1, address(this), vault, _amount1, true);
        }
        emit Withdraw(vault, _amount0, _amount1);
        if (!_isPaused()) _addLiquidity();
        balanceBeforeDeposit0 = 0;
        balanceBeforeDeposit1 = 0;
        depositPrepared = false;
    }

    function _addLiquidity() private onlyCalmPeriods {
        _whenStrategyNotPaused();
        uint256 hbarBalanceBefore = address(this).balance > 0 ? address(this).balance - msg.value : 0;

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
            if (address(this).balance < mintFee) revert InsufficientHBARForMintFee();

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
        (liquidity, adjustedSqrtPrice) = _calculateLiquidityWithPriceCheck(
            sqrtprice,
            positionAlt.tickLower,
            positionAlt.tickUpper,
            bal0,
            bal1
        );

        // Flip minting to true and call the pool to mint the liquidity.
        if (liquidity > 0) {
            // Additional pre-mint validation for alternative position
            _validatePreMintConditions(adjustedSqrtPrice, bal0, bal1);
            // Check we have sufficient HBAR for mint fee
            if (address(this).balance < mintFee) revert InsufficientHBARForMintFee();
            // Calculate expected amounts for slippage protection
            (expectedAmount0, expectedAmount1) = LiquidityAmounts.getAmountsForLiquidity(
                adjustedSqrtPrice,
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
        //return the excess hbar to caller
        if (hbarBalanceAfter > hbarBalanceBefore) {
            AddressUpgradeable.sendValue(payable(tx.origin), hbarBalanceAfter - hbarBalanceBefore);
        }
    }

    function _removeLiquidity() private {
        (bytes32 keyMain, bytes32 keyAlt) = getKeys();
        (uint128 liquidity, , , , ) = ISaucerSwapPool(pool).positions(keyMain);
        (uint128 liquidityAlt, , , , ) = ISaucerSwapPool(pool).positions(keyAlt);
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

    function harvest(address _callFeeRecipient) external payable {
        _harvest(_callFeeRecipient);
    }

    function harvest() external payable {
        _harvest(tx.origin);
    }

    function _harvest(address _callFeeRecipient) private onlyCalmPeriods {
        _claimEarnings();
        _removeLiquidity();
        (uint256 fee0, uint256 fee1) = _chargeFees(_callFeeRecipient, fees0, fees1);
        _addLiquidity();
        fees0 = 0;
        fees1 = 0;
         // Calculate remaining locked amounts and add new fees
        uint256 timeElapsed = block.timestamp - lastHarvest;
        
        if (timeElapsed >= DURATION) {
            // All locked amounts have been unlocked
            totalLocked0 = fee0;
            totalLocked1 = fee1;
        } else {
            // Calculate remaining locked amounts
            totalLocked0 = (totalLocked0 * (DURATION - timeElapsed)) / DURATION + fee0;
            totalLocked1 = (totalLocked1 * (DURATION - timeElapsed)) / DURATION + fee1;
        }
        lastHarvest = block.timestamp;
        emit Harvest(fee0, fee1);
    }

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
        (bytes32 keyMain, bytes32 keyAlt) = getKeys();
        (uint128 liquidity, , , , ) = ISaucerSwapPool(pool).positions(keyMain);
        (uint128 liquidityAlt, , , , ) = ISaucerSwapPool(pool).positions(keyAlt);
        if (liquidity > 0) ISaucerSwapPool(pool).burn(positionMain.tickLower, positionMain.tickUpper, 0);
        if (liquidityAlt > 0) ISaucerSwapPool(pool).burn(positionAlt.tickLower, positionAlt.tickUpper, 0);
        (fee0, fee1) = ISaucerSwapPool(pool).collect(
            address(this),
            positionMain.tickLower,
            positionMain.tickUpper,
            type(uint128).max,
            type(uint128).max
        );
        (feeAlt0, feeAlt1) = ISaucerSwapPool(pool).collect(
            address(this),
            positionAlt.tickLower,
            positionAlt.tickUpper,
            type(uint128).max,
            type(uint128).max
        );
        fees0 = fees0 + fee0 + feeAlt0;
        fees1 = fees1 + fee1 + feeAlt1;
    }

    function _chargeFees(
        address _callFeeRecipient,
        uint256 _amount0,
        uint256 _amount1
    ) private returns (uint256 _amountLeft0, uint256 _amountLeft1) {
        IFeeConfig.FeeCategory memory fees = getFees();
        _amountLeft0 = _amount0 > 0 ? _amount0 - ((_amount0 * fees.total) / DIVISOR) : 0;
        _amountLeft1 = _amount1 > 0 ? _amount1 - ((_amount1 * fees.total) / DIVISOR) : 0;
        uint256 feeAmount0 = _amount0 > 0 ? (_amount0 * fees.total) / DIVISOR : 0;
        uint256 feeAmount1 = _amount1 > 0 ? (_amount1 * fees.total) / DIVISOR : 0;
        _distributeLPTokenFees(_callFeeRecipient, feeAmount0, feeAmount1, fees);
    }

    function _distributeLPTokenFees(
        address _callFeeRecipient,
        uint256 _feeAmount0,
        uint256 _feeAmount1,
        IFeeConfig.FeeCategory memory _fees
    ) private {
        if (_feeAmount0 > 0) {
            uint256 callFee0 = (_feeAmount0 * _fees.call) / DIVISOR;
            uint256 strategistFee0 = (_feeAmount0 * _fees.strategist) / DIVISOR;
            uint256 beefyFee0 = _feeAmount0 - callFee0 - strategistFee0;

            if (callFee0 > 0) _transferTokens(lpToken0, address(this), _callFeeRecipient, callFee0, true);
            if (strategistFee0 > 0) _transferTokens(lpToken0, address(this), strategist, strategistFee0, true);
            if (beefyFee0 > 0) _transferTokens(lpToken0, address(this), beefyFeeRecipient, beefyFee0, true);
        }

        if (_feeAmount1 > 0) {
            uint256 callFee1 = (_feeAmount1 * _fees.call) / DIVISOR;
            uint256 strategistFee1 = (_feeAmount1 * _fees.strategist) / DIVISOR;
            uint256 beefyFee1 = _feeAmount1 - callFee1 - strategistFee1;

            if (callFee1 > 0) _transferTokens(lpToken1, address(this), _callFeeRecipient, callFee1, true);
            if (strategistFee1 > 0) _transferTokens(lpToken1, address(this), strategist, strategistFee1, true);
            if (beefyFee1 > 0) _transferTokens(lpToken1, address(this), beefyFeeRecipient, beefyFee1, true);
        }
    }

    function balances() public view returns (uint256 token0Bal, uint256 token1Bal) {
        (uint256 thisBal0, uint256 thisBal1) = balancesOfThis();
        BalanceInfo memory poolInfo = balancesOfPool();
        uint256 timeElapsed = block.timestamp - lastHarvest;
        uint256 locked0;
        uint256 locked1;
        if (timeElapsed >= DURATION) {
            locked0 = 0;
            locked1 = 0;
        } else {
            locked0 = totalLocked0 * (DURATION - timeElapsed) / DURATION;
            locked1 = totalLocked1 * (DURATION - timeElapsed) / DURATION;
        }

        uint256 available0 = thisBal0 + poolInfo.token0Bal;
        uint256 available1 = thisBal1 + poolInfo.token1Bal;

        // Prevent underflow: locked0/locked1 cannot exceed available balances
        if (locked0 > available0) locked0 = available0;
        if (locked1 > available1) locked1 = available1;

        uint256 total0 = available0 - locked0;
        uint256 total1 = available1 - locked1;

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
        if (!initTicks) {
            return (0, 0);
        }
        (bytes32 keyMain, ) = getKeys();
        (uint128 liquidity, , , uint256 owed0, uint256 owed1) = ISaucerSwapPool(pool).positions(keyMain);
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
        (uint128 liquidity, , , uint256 owed0, uint256 owed1) = ISaucerSwapPool(pool).positions(keyAlt);
        (amount0, amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPrice(),
            TickMath.getSqrtRatioAtTick(positionAlt.tickLower),
            TickMath.getSqrtRatioAtTick(positionAlt.tickUpper),
            liquidity
        );
        amount0 += owed0;
        amount1 += owed1;
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

    function getMintFee() public view returns (uint256 mintFee) {
        address poolFactory = ISaucerSwapPool(pool).factory();
        uint256 tinycentUSFee = IUniswapV3Factory(poolFactory).mintFee();
        //add 20% to the mint fee
        mintFee = (tinycentUSFee * 110) / 100;
        // Convert tinycent US to HBAR using oracle
        if (beefyOracle != address(0)) {
            try IBeefyOracle(beefyOracle).getPriceInUSD(native) returns (uint256 hbarPrice) {
                if (hbarPrice > 0) {
                    //get the price of usdc in hbar
                    //hbar price is in usd
                    //1e26: 1e18 * 1e8 (1e18 is the decimals of usdc, 1e8 is the decimals of hbar)
                    //1e10: 1e18 * 1e-8 (1e18 is the decimals of usdc , 1e-8  since tinycentUSFee is in usdc)
                    mintFee = (mintFee * 1e26) / (hbarPrice * 1e10);
                } else {
                    revert("HBAR price is zero");
                }
            } catch {
                revert("HBAR price fetch failed in getMintFee");
            }
        } else {
            revert("BeefyOracle not set");
        }
    }

    function getRawMintFee() public view returns (uint256 tinycentUSFee) {
        address poolFactory = ISaucerSwapPool(pool).factory();
        return IUniswapV3Factory(poolFactory).mintFee();
    }

    function updateMintFeeWithFreshPrice() public returns (uint256 mintFee) {
        address poolFactory = ISaucerSwapPool(pool).factory();
        uint256 tinycentUSFee = IUniswapV3Factory(poolFactory).mintFee();
        //add 10% to the mint fee
        mintFee = (tinycentUSFee * 110) / 100;
        
        if (beefyOracle != address(0)) {
            try IBeefyOracle(beefyOracle).getFreshPriceInUSD(native) returns (uint256 hbarPrice, bool success) {
                if (success && hbarPrice > 0) {
                    mintFee = (mintFee * 1e26) / (hbarPrice * 1e10);
                } else {
                    revert("Fresh HBAR price fetch failed");
                }
            } catch {
                revert("Fresh HBAR price fetch failed in updateMintFeeWithFreshPrice");
            }
        } else {
            revert("BeefyOracle not set");
        }
        return mintFee;
    }

    function _tickDistance() private view returns (int24) {
        return ISaucerSwapPool(pool).tickSpacing();
    }

    function uniswapV3MintCallback(uint256 amount0, uint256 amount1, bytes memory /*data*/) external payable {
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

    function _validatePreMintConditions(uint160 currentSqrtPrice, uint256 bal0, uint256 bal1) private view {
        SaucerSwapCLMLib.validatePreMintConditions(pool, twapInterval, maxTickDeviation, currentSqrtPrice, bal0, bal1);
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

    function _setTicks() private onlyCalmPeriods {
        int24 tick = currentTick();
        int24 distance = _tickDistance();
        int24 width = positionWidth * distance;

        _setMainTick(tick, distance, width);
        _setAltTick(tick, distance, width);

        lastPositionAdjustment = block.timestamp;
    }

    function _setMainTick(int24 tick, int24 distance, int24 width) private {
        (positionMain.tickLower, positionMain.tickUpper) = TickUtils.baseTicks(tick, width, distance);
    }

    function _setAltTick(int24 tick, int24 distance, int24 width) private {
        (uint256 bal0, uint256 bal1) = balancesOfThis();
        uint256 amount0;
        if (bal0 > 0) {
            amount0 = FullMath.mulDiv(bal0, price(), 1e18);
        }
        if (amount0 < bal1) {
            (positionAlt.tickLower, ) = TickUtils.baseTicks(tick, width, distance);
            (positionAlt.tickUpper, ) = TickUtils.baseTicks(tick, distance, distance);
        } else if (bal1 < amount0) {
            (, positionAlt.tickLower) = TickUtils.baseTicks(tick, distance, distance);
            (, positionAlt.tickUpper) = TickUtils.baseTicks(tick, width, distance);
        } else {
            (, positionAlt.tickLower) = TickUtils.baseTicks(tick, distance, distance);
            (, positionAlt.tickUpper) = TickUtils.baseTicks(tick, width, distance);
        }
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
        if (amount == 0) return;
        SaucerSwapCLMLib.transferHTS(token, to, amount);
    }

    function setDeviation(int56 _maxDeviation) external onlyOwner {
        if (_maxDeviation >= _tickDistance() * 4) revert InvalidInput();
        maxTickDeviation = _maxDeviation;
    }

    function twap() public view returns (int56 twapTick) {
        return SaucerSwapCLMLib.getTwap(pool, twapInterval);
    }

    function setTwapInterval(uint32 _interval) external onlyOwner {
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
        if (lpToken0 != native) {
            IERC20Metadata(lpToken0).approve(unirouter, type(uint256).max);
        }
        if (lpToken1 != native) {
            IERC20Metadata(lpToken1).approve(unirouter, type(uint256).max);
        }
    }

    function _safeGiveAllowances() private {
        if (lpToken0 != native) {
            try IERC20Metadata(lpToken0).approve(unirouter, type(uint256).max) {} catch {}
        }
        if (lpToken1 != native) {
            try IERC20Metadata(lpToken1).approve(unirouter, type(uint256).max) {} catch {}
        }
    }

    function _removeAllowances() private {
        if (lpToken0 != native) {
            IERC20Metadata(lpToken0).approve(unirouter, 0);
        }
        if (lpToken1 != native) {
            IERC20Metadata(lpToken1).approve(unirouter, 0);
        }
    }

    function _isPaused() internal view returns (bool) {
        return paused();
    }

    function _whenStrategyNotPaused() internal view {
        require(!paused(), "Strategy is paused");
    }

    function associateToken(address token) external onlyOwner {
        SaucerSwapCLMLib.safeAssociateToken(token);
    }

    function setBeefyOracle(address _beefyOracle) external onlyOwner {
        require(_beefyOracle != address(0), "Invalid oracle address");
        beefyOracle = _beefyOracle;
    }

    function lpToken0ToNativePrice() external returns (uint256) {
        uint256 amount = 10 ** IERC20Metadata(lpToken0).decimals() / 10;
        if (lpToken0 == native) return amount * 10;
        bytes memory path = abi.encodePacked(lpToken0, uint24(3000), native);
        try IQuoter(quoter).quoteExactInput(path, amount) returns (uint256 amountOut) {
            return amountOut * 10;
        } catch {
            return 0;
        }
    }

    function lpToken1ToNativePrice() external returns (uint256) {
        uint256 amount = 10 ** IERC20Metadata(lpToken1).decimals() / 10;
        if (lpToken1 == native) return amount * 10;
        bytes memory path = abi.encodePacked(lpToken1, uint24(3000), native);
        try IQuoter(quoter).quoteExactInput(path, amount) returns (uint256 amountOut) {
            return amountOut * 10;
        } catch {
            return 0;
        }
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

    receive() external payable {}
    fallback() external payable {}
}
