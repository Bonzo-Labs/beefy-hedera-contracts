// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin-4/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../interfaces/bonzo/ILendingPool.sol";
import "../../interfaces/bonzo/IRewardsController.sol";
import "../Common/StratFeeManagerInitializable.sol";
import "../../utils/GasFeeThrottler.sol";
import "../../Hedera/IHederaTokenService.sol";
import "../../interfaces/beefy/IStrategyV7.sol";
import "../../interfaces/oracle/IBeefyOracle.sol";

/**
 * @title YieldLoopConfigurable
 * @author Beefy Finance
 * @notice Configurable leverage strategy that can loop 1-5 times
 * @dev Implements security improvements and edge case handling
 */
contract YieldLoopConfigurable is StratFeeManagerInitializable {
    using SafeERC20 for IERC20;

    // Tokens used
    address public want; // Deposit token
    address public aToken; // Receipt token for supply
    address public debtToken; // Debt token for borrowing
    address public output; // Reward token

    // Third party contracts
    address public lendingPool;
    address public rewardsController;
    address public beefyOracle; // Oracle for price feeds

    // Strategy settings
    uint256 public borrowFactor = 2000; // 40% in basis points (100% = 10000) - kept conservative
    uint256 public constant BORROW_FACTOR_MAX = 6000; // Max 60% to prevent liquidation
    uint256 public leverageLoops = 2; // Number of leverage loops (1-5)
    uint256 public constant MAX_LOOPS = 5; // Maximum allowed loops

    // Hedera specific
    address private constant HTS_PRECOMPILE = address(0x167);
    int64 private constant HTS_SUCCESS = 22;
    int64 private constant PRECOMPILE_BIND_ERROR = -2;

    bool public harvestOnDeposit;
    uint256 public lastHarvest;
    bool public isHederaToken; // Flag to determine if tokens are Hedera tokens
    uint8 public wantDecimals; // Decimals of the want token

    // Note: We don't track individual leverage levels since this is a multi-user vault
    // The lending pool's actual data is the source of truth

    // Events
    event StratHarvest(address indexed harvester, uint256 wantHarvested, uint256 tvl);
    event Deposit(uint256 tvl);
    event Withdraw(uint256 tvl);
    event ChargedFees(uint256 callFees, uint256 beefyFees, uint256 strategistFees);
    event HTSTokenAssociated(address token, int64 responseCode);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);
    event BorrowFactorUpdated(uint256 newBorrowFactor);
    event LeverageLoopsUpdated(uint256 newLoops);
    event EmergencyDeleveraged(uint256 totalRepaid, uint256 totalWithdrawn);
    event OracleUpdated(address newOracle);

    // Custom errors for gas efficiency
    error InvalidAmount();
    error InvalidBorrowFactor();
    error InvalidLeverageLoops();
    error HarvestTooSoon();
    error HTSTransferFailed(int64 responseCode);
    error NotVault();
    error InsufficientBalance();
    error OraclePriceFail();
    error OraclePriceZero();
    
    function initialize(
        address _want,
        address _aToken,
        address _debtToken,
        address _lendingPool,
        address _rewardsController,
        address _output,
        bool _isHederaToken,
        uint256 _leverageLoops,
        address _beefyOracle,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        __StratFeeManager_init(_commonAddresses);

        want = _want;
        aToken = _aToken;
        debtToken = _debtToken;
        lendingPool = _lendingPool;
        rewardsController = _rewardsController;
        output = _output;
        isHederaToken = _isHederaToken;
        beefyOracle = _beefyOracle;
        
        // Get want token decimals
        wantDecimals = IERC20Metadata(_want).decimals();

        if (_leverageLoops == 0 || _leverageLoops > MAX_LOOPS) revert InvalidLeverageLoops();
        leverageLoops = _leverageLoops;

        // No need to initialize tracking arrays - we use lending pool data directly

        if (isHederaToken) {
            // Associate HTS tokens
            _associateToken(_want);
            if (_want != _output) {
                _associateToken(_output);
            }
        }

        _giveAllowances();
    }

    // ===== User Functions =====

    function deposit() public whenNotPaused nonReentrant {
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal == 0) revert InvalidAmount();

        _leverage(wantBal);
        emit Deposit(balanceOf());
    }

    function withdraw(uint256 _amount) external nonReentrant {
        if (msg.sender != vault) revert NotVault();
        if (_amount == 0) revert InvalidAmount();

        uint256 wantBal = IERC20(want).balanceOf(address(this));

        if (wantBal < _amount) {
            uint256 amountToWithdraw = _amount - wantBal;
            _deleverage(amountToWithdraw);
            wantBal = IERC20(want).balanceOf(address(this));
        }

        if (wantBal > _amount) {
            wantBal = _amount;
        }

        // Apply withdrawal fee if not owner and not paused
        if (msg.sender != owner() && !paused()) {
            uint256 withdrawalFeeAmount = (wantBal * withdrawalFee) / WITHDRAWAL_MAX;
            wantBal = wantBal - withdrawalFeeAmount;
            if(withdrawalFeeAmount > 0) {
                _safeTransfer(want, address(this), beefyFeeRecipient, withdrawalFeeAmount);
            }
        }

        _safeTransfer(want, address(this), vault, wantBal);
        emit Withdraw(balanceOf());
    }

    function beforeDeposit() external virtual override nonReentrant {
        if (harvestOnDeposit) {
            if (msg.sender != vault) revert NotVault();
            _harvest(msg.sender); // Use msg.sender instead of tx.origin
        }
    }

    // ===== Internal Core Functions =====

    function _leverage(uint256 _amount) internal {
        // Approve lending pool to spend want tokens
        IERC20(want).approve(lendingPool, _amount * (leverageLoops + 1));
        ILendingPool(lendingPool).deposit(want, _amount, address(this), 0);

        uint256 currentCollateral = _amount;

        // Loop for additional leverage
        for (uint256 i = 0; i < leverageLoops - 1; i++) {
            // Get current position data to check LTV limits
            (uint256 currentCollateralBase, uint256 currentDebtBase, , , uint256 currentLtv, ) = ILendingPool(
                lendingPool
            ).getUserAccountData(address(this));

            // Convert currentCollateralBase to want token units for accurate calculations
            // currentCollateralBase is in HBAR units (18 decimals), but we need to convert to want token units
            uint256 currentCollateralInWantUnits = _convertFromBaseToWant(currentCollateralBase);

            // Calculate borrow amount using conservative borrowFactor based on actual collateral
            uint256 borrowableAmount = (currentCollateralInWantUnits * borrowFactor) / 10000;

            // Calculate maximum borrow amount that keeps us under LTV
            uint256 maxBorrowBase = ((currentCollateralBase * currentLtv) / 10000) - currentDebtBase;
            uint256 maxBorrowInWantUnits = _convertFromBaseToWant(maxBorrowBase);

            // Use the smaller of borrowFactor calculation and LTV limit
            if (borrowableAmount > maxBorrowInWantUnits) {
                borrowableAmount = maxBorrowInWantUnits;
            }

            // If we can't borrow more, stop
            if (borrowableAmount == 0) break;

            // Borrow tokens
            ILendingPool(lendingPool).borrow(want, borrowableAmount, 2, 0, address(this));

            ILendingPool(lendingPool).deposit(want, borrowableAmount, address(this), 0);

            // Update collateral for next iteration
            currentCollateral = borrowableAmount;
        }
    }

    /**
     * @dev Convert from base units (ETH/HBAR in 18 decimals) to want token units using oracle price
     * @param baseAmount Amount in base units (ETH/HBAR in 18 decimals)
     * @return wantAmount Amount in want token units
     */
    function _convertFromBaseToWant(uint256 baseAmount) internal view returns (uint256 wantAmount) {
        if (baseAmount == 0) return 0;
        
        // Get want token price from oracle
        uint256 wantPrice;
        try IBeefyOracle(beefyOracle).getPrice(want) returns (uint256 price) {
            if(price == 0) revert OraclePriceZero();
            wantPrice = price;
        } catch {
            revert OraclePriceFail();
        }
        
        // Convert base amount to want token units
        // baseAmount is in ETH/HBAR units (18 decimals), wantPrice is in ETH/HBAR with 18 decimals
        // We need to convert to want token units with proper decimal handling
        // Formula: (baseAmount * 10^wantDecimals) / wantPrice
        wantAmount = (baseAmount * 10**wantDecimals) / wantPrice;
    }

    /**
     * @dev Convert from want token units to base units (ETH/HBAR in 18 decimals) using oracle price
     * @param wantAmount Amount in want token units
     * @return baseAmount Amount in base units (ETH/HBAR in 18 decimals)
     */
    function _convertFromWantToBase(uint256 wantAmount) internal view returns (uint256 baseAmount) {
        if (wantAmount == 0) return 0;
        
        // Get want token price from oracle
        uint256 wantPrice;
        try IBeefyOracle(beefyOracle).getPrice(want) returns (uint256 price) {
            if(price == 0) revert OraclePriceZero();
            wantPrice = price;
        } catch {
            revert OraclePriceFail();
        }
        
        // Convert want token units to base amount with proper decimal handling
        // Formula: (wantAmount * wantPrice) / (10^wantDecimals)
        baseAmount = (wantAmount * wantPrice) / (10**wantDecimals);
    }

    function _deleverage(uint256 _targetAmount) internal {
        uint256 totalAssets = balanceOf();
        if (totalAssets == 0) return;

        // Calculate withdrawal percentage in basis points (10000 = 100%)
        uint256 withdrawBps = (_targetAmount * 10000) / totalAssets;
        if (withdrawBps > 10000) withdrawBps = 10000; // Cap at 100%

        // For near-complete withdrawal (>99.5%), exit all positions to avoid rounding issues
        if (withdrawBps >= 9950) {
            _completePositionExit();
            return;
        }

        // Convert to ratio for calculations (1e18 = 100%)
        uint256 withdrawRatio = (_targetAmount * 1e18) / totalAssets;

        // Calculate total supply and debt from lending pool
        uint256 totalSupply = balanceOfSupply();
        uint256 totalDebt = balanceOfBorrow();

        // Withdraw proportionally from total supply
        uint256 supplyToWithdraw = (totalSupply * withdrawRatio) / 1e18;
        if (supplyToWithdraw > 0) {
            ILendingPool(lendingPool).withdraw(want, supplyToWithdraw, address(this));
        }

        // Repay debt proportionally
        uint256 debtToRepay = (totalDebt * withdrawRatio) / 1e18;
        if (debtToRepay > 0) {
            // Ensure we have enough to repay
            uint256 currentBal = IERC20(want).balanceOf(address(this));
            if (currentBal < debtToRepay) {
                // Need to withdraw more to cover debt
                uint256 additionalWithdraw = debtToRepay - currentBal;
                ILendingPool(lendingPool).withdraw(want, additionalWithdraw, address(this));
            }

            ILendingPool(lendingPool).repay(want, debtToRepay, 2, address(this));
        }
    }

    // ===== Harvest Functions =====

    function harvest() external virtual nonReentrant {
        _harvest(msg.sender);
    }

    function harvest(address callFeeRecipient) external virtual nonReentrant {
        if (callFeeRecipient == address(0)) revert InvalidAmount();
        _harvest(callFeeRecipient);
    }

    function _harvest(address callFeeRecipient) internal whenNotPaused {
        // Claim rewards for both aToken and debtToken
        address[] memory assets = new address[](2);
        assets[0] = aToken;
        assets[1] = debtToken;
        uint256 amount = rewardsAvailable();

        if (amount > 0) {
            IRewardsController(rewardsController).claimRewards(assets, amount, address(this), output);

            uint256 outputBal = IERC20(output).balanceOf(address(this));
            if (outputBal > 0) {
                chargeFees(callFeeRecipient);

                // Since output == want, no swapping needed - tokens are already in desired form
                uint256 wantHarvested = balanceOfWant();
                if (wantHarvested > 0) {
                    deposit();
                }

                lastHarvest = block.timestamp;
                emit StratHarvest(msg.sender, wantHarvested, balanceOf());
            }
        }
    }

    function chargeFees(address callFeeRecipient) internal {
        IFeeConfig.FeeCategory memory fees = getFees();
        uint256 outputBal = IERC20(output).balanceOf(address(this));
        uint256 totalFees = (outputBal * fees.total) / DIVISOR;

        uint256 callFeeAmount = (totalFees * fees.call) / DIVISOR;
        _safeTransfer(output, address(this), callFeeRecipient, callFeeAmount);

        uint256 beefyFeeAmount = (totalFees * fees.beefy) / DIVISOR;
        _safeTransfer(output, address(this), beefyFeeRecipient, beefyFeeAmount);

        uint256 strategistFeeAmount = (totalFees * fees.strategist) / DIVISOR;
        _safeTransfer(output, address(this), strategist, strategistFeeAmount);

        emit ChargedFees(callFeeAmount, beefyFeeAmount, strategistFeeAmount);
    }


    // ===== Management Functions =====

    function setHarvestOnDeposit(bool _harvestOnDeposit) external onlyManager {
        harvestOnDeposit = _harvestOnDeposit;
        if (harvestOnDeposit) {
            setWithdrawalFee(0);
        } else {
            setWithdrawalFee(10);
        }
    }

    function setBorrowFactor(uint256 _borrowFactor) external onlyManager {
        if (_borrowFactor > BORROW_FACTOR_MAX) revert InvalidBorrowFactor();
        borrowFactor = _borrowFactor;
        emit BorrowFactorUpdated(_borrowFactor);
    }

    function setLeverageLoops(uint256 _leverageLoops) external onlyManager {
        if (_leverageLoops == 0 || _leverageLoops > MAX_LOOPS) revert InvalidLeverageLoops();

        // If reducing loops, need to deleverage first
        if (_leverageLoops < leverageLoops) {
            _emergencyDeleverage();
        }

        leverageLoops = _leverageLoops;
        emit LeverageLoopsUpdated(_leverageLoops);

        // Re-leverage with new loop count
        if (!paused()) {
            deposit();
        }
    }

    /**
     * @dev Update the Beefy Oracle address
     * @param _beefyOracle The new oracle address
     */
    function setBeefyOracle(address _beefyOracle) external onlyManager {
        require(_beefyOracle != address(0), "Invalid oracle address");
        beefyOracle = _beefyOracle;
        emit OracleUpdated(_beefyOracle);
    }

    // ===== Emergency Functions =====

    function retireStrat() external nonReentrant {
        if (msg.sender != vault) revert NotVault();

        _emergencyDeleverage();

        uint256 wantBal = IERC20(want).balanceOf(address(this));
        _safeTransfer(want, address(this), vault, wantBal);
    }

    function panic() public onlyManager nonReentrant {
        pause();
        _emergencyDeleverage();
    }

    function _completePositionExit() internal {
        uint256 totalDebt = balanceOfBorrow();
        uint256 totalRepaid;
        uint256 totalWithdrawn;

        // Withdraw all positions and repay all debt
        while (totalDebt > 0) {
            // Withdraw enough to cover all debt
            uint256 toWithdraw = totalDebt + (totalDebt * 100) / 10000; // Add 1% buffer
            uint256 maxWithdraw = balanceOfSupply();

            if (toWithdraw > maxWithdraw) {
                toWithdraw = maxWithdraw;
            }

            if (toWithdraw > 0) {
                ILendingPool(lendingPool).withdraw(want, toWithdraw, address(this));
                totalWithdrawn += toWithdraw;
            }

            // Repay as much debt as possible
            uint256 wantBal = IERC20(want).balanceOf(address(this));
            uint256 toRepay = wantBal > totalDebt ? totalDebt : wantBal;

            if (toRepay > 0) {
                ILendingPool(lendingPool).repay(want, toRepay, 2, address(this));
                totalRepaid += toRepay;
            }

            // Update debt amount
            uint256 newDebt = balanceOfBorrow();
            if (newDebt >= totalDebt) break; // Prevent infinite loop
            totalDebt = newDebt;
        }

        // Withdraw any remaining supply
        uint256 remainingSupply = balanceOfSupply();
        if (remainingSupply > 0) {
            ILendingPool(lendingPool).withdraw(want, type(uint256).max, address(this));
        }

        // No tracking arrays to reset - we use lending pool data directly
    }

    function _emergencyDeleverage() internal {
        _completePositionExit();

        uint256 totalRepaid = 0; // We could track this in _completePositionExit if needed
        uint256 totalWithdrawn = 0; // We could track this in _completePositionExit if needed
        emit EmergencyDeleveraged(totalRepaid, totalWithdrawn);
    }

    function pause() public onlyManager {
        _pause();
        _removeAllowances();
    }

    function unpause() external onlyManager nonReentrant {
        _unpause();
        _giveAllowances();
        deposit();
    }

    // ===== Token Management Functions =====

    function _associateToken(address token) internal {
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        if (responseCode != HTS_SUCCESS) revert HTSTransferFailed(responseCode);
        emit HTSTokenAssociated(token, responseCode);
    }

    function _safeTransfer(address token, address from, address to, uint256 amount) internal {
        if (amount == 0) return;

        if (from == address(this)) {
            IERC20(token).safeTransfer(to, amount);
        } else {
            IERC20(token).safeTransferFrom(from, to, amount);
        }
    }

    function _transferHTS(address token, address from, address to, int64 amount) internal {
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.transferToken.selector, token, from, to, amount)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        if (responseCode != HTS_SUCCESS) {
            emit HTSTokenTransferFailed(token, from, to, responseCode);
            revert HTSTransferFailed(responseCode);
        }
    }

    function _giveAllowances() internal {
        if (!isHederaToken) {
            IERC20(want).approve(lendingPool, type(uint).max);
        }
    }

    function _removeAllowances() internal {
        if (!isHederaToken) {
            IERC20(want).approve(lendingPool, 0);
        }
    }

    // ===== View Functions =====

    function balanceOf() public view returns (uint256) {
        return balanceOfWant() + balanceOfSupply() - balanceOfBorrow();
    }

    function balanceOfWant() public view returns (uint256) {
        return IERC20(want).balanceOf(address(this));
    }

    function balanceOfSupply() public view returns (uint256) {
        return IERC20(aToken).balanceOf(address(this));
    }

    function balanceOfBorrow() public view returns (uint256) {
        return IERC20(debtToken).balanceOf(address(this));
    }

    function rewardsAvailable() public view returns (uint256) {
        (uint256 supplyRewards, , , ) = IRewardsController(rewardsController).getRewardsData(aToken, output);
        (uint256 borrowRewards, , , ) = IRewardsController(rewardsController).getRewardsData(debtToken, output);
        return supplyRewards + borrowRewards;
    }

    function callReward() public view returns (uint256) {
        IFeeConfig.FeeCategory memory fees = getFees();
        uint256 outputBal = rewardsAvailable();
        return (((outputBal * fees.total) / DIVISOR) * fees.call) / DIVISOR;
    }

    function getSupplyAtLevel(uint256 level) public view returns (uint256) {
        // Since this is a multi-user vault, we don't track individual levels
        // Return total supply for level 0, 0 for other levels
        if (level == 0) {
            return balanceOfSupply();
        }
        return 0;
    }

    function getBorrowAtLevel(uint256 level) public view returns (uint256) {
        // Since this is a multi-user vault, we don't track individual levels
        // Return total debt for level 0, 0 for other levels
        if (level == 0) {
            return balanceOfBorrow();
        }
        return 0;
    }

}
