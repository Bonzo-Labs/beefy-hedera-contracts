// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin-4/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../interfaces/bonzo/ILendingPool.sol";
import "../../interfaces/bonzo/IRewardsController.sol";
import "../Common/StratFeeManagerInitializable.sol";
import "../../interfaces/common/IFeeConfig.sol";
import "./SaucerSwap/ISaucerSwapMothership.sol";
import "../../Hedera/IHederaTokenService.sol";

contract BonzoSAUCELevergedLiqStaking is StratFeeManagerInitializable {
    using SafeERC20 for IERC20;

    // Hedera Token Service constants
    address constant HTS_PRECOMPILE = address(0x167);
    int64 constant HTS_SUCCESS = 22;
    int64 constant PRECOMPILE_BIND_ERROR = -1;

    // Tokens used
    address public want; // xSAUCE token
    address public borrowToken; // SAUCE token
    address public aToken; // axSAUCE token
    address public debtToken; // debtSAUCE token
    address public stakingPool; // Staking pool for xSAUCE
    uint8 public wantTokenDecimals = 6; // Token decimals
    uint8 public borrowTokenDecimals = 6; // Token decimals

    // Third party contracts
    address public lendingPool;
    address public rewardsController;

    // Yield loop parameters
    uint256 public maxLoops = 1; // Maximum number of yield loops (e.g., 3 for 3x)
    uint256 public maxBorrowable; // Maximum borrowable amount (e.g., 8000 for 80%)
    uint256 public slippageTolerance; // Slippage tolerance in basis points (e.g., 50 for 0.5%)

    bool public harvestOnDeposit;
    uint256 public lastHarvest;
    bool public isRewardsAvailable;
    bool public isBonzoDeployer;

    // Events
    event StratHarvest(address indexed harvester, uint256 wantHarvested, uint256 tvl);
    event Deposit(uint256 totalCollateral, uint256 totalBorrowed);
    event Withdraw(uint256 withdrawAmount);
    event ChargedFees(uint256 callFees, uint256 beefyFees, uint256 strategistFees);
    event Staked(uint256 amount);
    event Unstaked(uint256 amount);
    event SlippageToleranceUpdated(uint256 oldValue, uint256 newValue);
    event MaxLoopsUpdated(uint256 oldValue, uint256 newValue);
    event MaxBorrowableUpdated(uint256 oldValue, uint256 newValue);
    event RewardsAvailabilityUpdated(bool oldValue, bool newValue);
    event HarvestOnDepositUpdated(bool oldValue, bool newValue);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);
    event StratPanicCalled();
    event StrategyRetired();
    event OracleUpdated(address oldValue, address newValue);
    event DebugValues(
        uint256 collateralBase,
        uint256 debtBase,
        uint256 ltv,
        uint256 saucePrice,
        uint256 maxBorrowBase,
        uint256 desired
    );

    error MaxBorrowTokenIsZero(
        uint256 baseCollateral,
        uint256 baseDebt,
        uint256 currentLtv,
        uint256 decimalDiff,
        uint256 saucePrice
    );

    error InsufficientSauceForDebtRepayment(uint256 layerDebt, uint256 expectedSauce, uint256 minSauce);
    error NotEnoughSAUCE(uint256 availableSAUCE, uint256 requiredSAUCE);
    error WithdrawFailed(uint256 withdrawAmount, uint256 currentSupply);

    function initialize(
        address _want,
        address _borrowToken,
        address _aToken,
        address _debtToken,
        address _lendingPool,
        address _rewardsController,
        address _stakingPool,
        uint256 _maxBorrowable,
        uint256 _slippageTolerance,
        bool _isRewardsAvailable,
        bool _isBonzoDeployer,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        __StratFeeManager_init(_commonAddresses);
        __Ownable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        require(_want != address(0), "want cannot be zero address");
        require(_borrowToken != address(0), "borrowToken cannot be zero address");
        require(_aToken != address(0), "aToken cannot be zero address");
        require(_debtToken != address(0), "debtToken cannot be zero address");
        require(_lendingPool != address(0), "lendingPool cannot be zero address");
        require(_stakingPool != address(0), "stakingPool cannot be zero address");
        require(_maxBorrowable > 0 && _maxBorrowable <= 10000, "maxBorrowable must be between 0 and 10000");

        want = _want; // xSAUCE
        borrowToken = _borrowToken; // SAUCE
        aToken = _aToken; // axSAUCE
        debtToken = _debtToken; // debtSAUCE
        lendingPool = _lendingPool;
        rewardsController = _rewardsController;
        stakingPool = _stakingPool;
        maxBorrowable = _maxBorrowable;
        slippageTolerance = _slippageTolerance;
        isRewardsAvailable = _isRewardsAvailable;
        isBonzoDeployer = _isBonzoDeployer;

        // Associate HTS tokens
        _associateToken(_want);
        _associateToken(_borrowToken);
    }

    function _associateToken(address token) internal {
        require(token != address(0), "Invalid token address");
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        require(responseCode == HTS_SUCCESS, "HTS token association failed");
    }

    function _safeTransfer(address token, address from, address to, uint256 amount) internal {
        require(token != address(0), "Invalid token address");
        require(from != address(0), "Invalid from address");
        require(to != address(0), "Invalid to address");
        require(amount > 0, "Amount must be greater than 0");
        require(amount <= uint256(uint64(type(int64).max)), "Amount too large for int64");
        _transferHTS(token, from, to, int64(uint64(amount)));
    }

    function _transferHTS(address token, address from, address to, int64 amount) internal {
        require(token != address(0), "Invalid token address");
        require(from != address(0), "Invalid from address");
        require(to != address(0), "Invalid to address");
        require(amount > 0, "Amount must be greater than 0");

        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.transferToken.selector, token, from, to, amount)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        if (responseCode != HTS_SUCCESS) {
            emit HTSTokenTransferFailed(token, from, to, responseCode);
            revert("HTS token transfer failed");
        }
    }

    function deposit() public whenNotPaused nonReentrant {
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        require(wantBal > 0, "No funds to deposit");
        _createYieldLoops(wantBal);
    }

    function _createYieldLoops(uint256 amount) internal {
        require(amount > 0, "Amount must be > 0");

        // Approve once for everything we'll need
        uint256 approvalAmount = amount * (maxLoops * 2);
        IERC20(want).approve(lendingPool, approvalAmount);
        IERC20(borrowToken).approve(lendingPool, approvalAmount);
        IERC20(borrowToken).approve(stakingPool, approvalAmount);

        // Initial deposit
        ILendingPool(lendingPool).deposit(want, amount, address(this), 0);
        uint256 currentCollateral = amount;
        uint256 totalBorrowed = 0;

        uint256 xSaucePerSauce = ISaucerSwapMothership(stakingPool).xSauceForSauce(1e6);
       
        for (uint256 i = 0; i < maxLoops; i++) {
            uint256 inputCollateralValueInSauce = (currentCollateral * xSaucePerSauce) / 1e6;
            uint256 borrowAmt = (inputCollateralValueInSauce * maxBorrowable) / 10_000;
            if (borrowAmt == 0) break;
            if(totalBorrowed > 0 && borrowAmt > totalBorrowed) {
                borrowAmt = borrowAmt - totalBorrowed;
            }
            // [4] borrow & stake → xSAUCE
            ILendingPool(lendingPool).borrow(borrowToken, borrowAmt, 2, 0, address(this));
            uint256 xAmt = _enter(borrowAmt);

            // [5] update and re-deposit
            currentCollateral += xAmt;
            totalBorrowed += borrowAmt;
            ILendingPool(lendingPool).deposit(want, xAmt, address(this), 0);
        }

        emit Deposit(currentCollateral, totalBorrowed);
    }


    function _enter(uint256 amount) internal returns (uint256) {
        require(amount > 0, "Amount must be greater than 0");
        
        // Get expected output for validation
        uint256 expectedXSauce = ISaucerSwapMothership(stakingPool).sauceForxSauce(amount);
        uint256 minXSauce = expectedXSauce * (10000 - slippageTolerance) / 10000;
        
        uint256 balanceBefore = IERC20(want).balanceOf(address(this));
        
        try ISaucerSwapMothership(stakingPool).enter(amount) {
            uint256 balanceAfter = IERC20(want).balanceOf(address(this));
            uint256 received = balanceAfter - balanceBefore;
            
            // Validate received amount meets minimum expectations
            if (received < minXSauce) {
                emit Staked(received);
                return received; // Return actual amount even if below expectations
            }
            
            require(received > 0, "No tokens received from staking");
            emit Staked(received);
            return received;
        } catch {
            // If enter fails, revert with descriptive error
            revert("SAUCE staking failed");
        }
    }

    function _leave(uint256 amount) internal returns (uint256) {
        if(amount == 0) {
            return 0;
        }
        
        // Validation checks
        uint256 sauceBalance = ISaucerSwapMothership(stakingPool).sauceBalance(address(this));
        uint256 currWantBal = balanceOfWant();
        if(currWantBal == 0 || sauceBalance == 0) {
            return 0;
        }
        
        // Ensure we don't try to leave more than we have
        if(amount > currWantBal) {
            amount = currWantBal;
        }
        
        // Get expected output for validation
        uint256 expectedSauce = ISaucerSwapMothership(stakingPool).xSauceForSauce(amount);
        uint256 minSauce = expectedSauce * (10000 - slippageTolerance) / 10000;
        
        uint256 balanceBefore = IERC20(borrowToken).balanceOf(address(this));
        
        try ISaucerSwapMothership(stakingPool).leave(amount) {
            uint256 balanceAfter = IERC20(borrowToken).balanceOf(address(this));
            uint256 received = balanceAfter - balanceBefore;
            
            // Validate received amount meets minimum expectations
            if (received < minSauce) {
                emit Unstaked(received);
                return received; // Return actual amount even if below expectations
            }
            
            require(received > 0, "No tokens received from unstaking");
            emit Unstaked(received);
            return received;
        } catch {
            // If leave fails, return 0 to indicate failure
            return 0;
        }
    }

    function _unwindYieldLoops(uint256 _targetAmount) internal {
        require(_targetAmount > 0, "Amount must be greater than 0");
        uint256 totalAssets = balanceOf();
        require(_targetAmount <= totalAssets, "Amount exceeds total position");

        if (totalAssets == 0) return;

        // Calculate withdrawal percentage in basis points (10000 = 100%)
        uint256 withdrawBps = (_targetAmount * 10000) / totalAssets;
        if (withdrawBps > 10000) withdrawBps = 10000; // Cap at 100%

        // Convert to ratio for calculations (1e18 = 100%)
        uint256 withdrawRatio = (_targetAmount * 1e18) / totalAssets;

        // Calculate total supply and debt from lending pool
        uint256 totalSupply = IERC20(aToken).balanceOf(address(this));
        uint256 totalDebt = IERC20(debtToken).balanceOf(address(this));

        // Calculate proportional amounts for each layer
        uint256 debtToRepay = (totalDebt * withdrawRatio) / 1e18;
        uint256 supplyToWithdraw = (totalSupply * withdrawRatio) / 1e18;
        
        // Use more accurate conversion with buffer for debt
        uint256 requiredXSauceForDebt = _getSauceQuoteForXSauceAmount(debtToRepay);
        // Add buffer to account for slippage and conversion inaccuracies
        requiredXSauceForDebt = requiredXSauceForDebt + (requiredXSauceForDebt * 200) / 10000; // 2% buffer
        supplyToWithdraw = supplyToWithdraw + requiredXSauceForDebt;
        // Distribute across layers
        uint256 layerSupply = supplyToWithdraw / (maxLoops + 1);
        uint256 layerDebt = debtToRepay / (maxLoops + 1);
        uint256 debtPaid = 0;

        IERC20(borrowToken).approve(lendingPool, debtToRepay*2);
        IERC20(want).approve(stakingPool, _targetAmount*2);
        for (uint256 i = 0; i < maxLoops + 1; i++) {
            if (layerSupply > 0) {
                uint256 currentSupply = IERC20(aToken).balanceOf(address(this));
                if(currentSupply > 0 && currentSupply <= layerSupply) {
                    layerSupply = currentSupply;
                }
                try ILendingPool(lendingPool).withdraw(want, layerSupply, address(this)) {
                } catch  {
                   try ILendingPool(lendingPool).withdraw(want, layerSupply*90/100, address(this)) {
                   } catch  {
                      revert("LendingPool withdraw failed");
                   }
                }
            }
            // Handle debt repayment for this layer
            if (layerDebt > 0) {
                uint256 currentDebt = IERC20(debtToken).balanceOf(address(this));
                if (currentDebt == 0) break;

                uint256 debtForThisLayer = (i == maxLoops - 1) ? 
                    (debtToRepay - debtPaid) : // Last layer gets remaining debt
                    layerDebt; // Other layers get equal share

                if (debtForThisLayer > 0 && debtForThisLayer <= currentDebt) {
                    // Use improved conversion with buffer for more accuracy
                    uint256 requiredXSauce = _getSauceQuoteForXSauceAmount(debtForThisLayer);
                    
                    // Ensure we have enough xSAUCE to leave
                    uint256 xSauceBal = IERC20(want).balanceOf(address(this));
                    if (requiredXSauce > xSauceBal) {
                        requiredXSauce = xSauceBal;
                    }
                    
                    // Leave xSAUCE to get SAUCE for debt repayment
                    if (requiredXSauce > 0) {
                        uint256 sauceAmount = _leave(requiredXSauce);
                        
                        // Final check: ensure we don't try to repay more than we have
                        uint256 finalSauceBal = IERC20(borrowToken).balanceOf(address(this));
                        if (sauceAmount > finalSauceBal) {
                            sauceAmount = finalSauceBal;
                        }
                        
                        if (sauceAmount > 0) {
                            try ILendingPool(lendingPool).repay(borrowToken, sauceAmount, 2, address(this)) {
                                debtPaid += debtForThisLayer;
                            } catch {
                                // If repayment fails, continue to next layer
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    function _completePositionExit() internal {
        uint256 totalDebt = IERC20(debtToken).balanceOf(address(this));
        uint256 totalRepaid;

        // Approve tokens for all operations
        IERC20(borrowToken).approve(lendingPool, totalDebt * 2);
        IERC20(want).approve(stakingPool, balanceOfWant() * 2);

        // Withdraw all positions and repay all debt
        while (totalDebt > 0) {
            // Withdraw enough to cover all debt with buffer
            uint256 toWithdraw = totalDebt + (totalDebt * 100) / 10000; // Add 1% buffer
            uint256 maxWithdraw = IERC20(aToken).balanceOf(address(this));

            if (toWithdraw > maxWithdraw) {
                toWithdraw = maxWithdraw;
            }

            if (toWithdraw > 0) {
                try ILendingPool(lendingPool).withdraw(want, toWithdraw, address(this)) {
                } catch {
                    // If exact withdrawal fails, try smaller amount
                    try ILendingPool(lendingPool).withdraw(want, toWithdraw * 90 / 100, address(this)) {
                    } catch {
                        break; // Exit if we can't withdraw
                    }
                }
            }

            // Convert xSAUCE to SAUCE if needed for debt repayment
            uint256 currentSauceBal = IERC20(borrowToken).balanceOf(address(this));
            if (currentSauceBal < totalDebt) {
                uint256 sauceShortfall = totalDebt - currentSauceBal;
                uint256 xSauceBal = IERC20(want).balanceOf(address(this));
                
                if (xSauceBal > 0) {
                    // Use improved conversion with buffer for more accuracy
                    uint256 xSauceToLeave = _getSauceQuoteForXSauceAmount(sauceShortfall);
                    if (xSauceToLeave > xSauceBal) {
                        xSauceToLeave = xSauceBal;
                    }
                    if (xSauceToLeave > 0) {
                        _leave(xSauceToLeave);
                    }
                }
            }

            // Repay as much debt as possible
            uint256 sauceBalance = IERC20(borrowToken).balanceOf(address(this));
            uint256 toRepay = sauceBalance > totalDebt ? totalDebt : sauceBalance;

            if (toRepay > 0) {
                try ILendingPool(lendingPool).repay(borrowToken, toRepay, 2, address(this)) {
                    totalRepaid += toRepay;
                } catch {
                    break; // Exit if repayment fails
                }
            }

            // Update debt amount and prevent infinite loop
            uint256 newDebt = IERC20(debtToken).balanceOf(address(this));
            if (newDebt >= totalDebt) break;
            totalDebt = newDebt;
        }

        // Withdraw any remaining supply
        uint256 remainingSupply = IERC20(aToken).balanceOf(address(this));
        if (remainingSupply > 0) {
            try ILendingPool(lendingPool).withdraw(want, type(uint256).max, address(this)) {
            } catch {
                // Try partial withdrawal if max fails
                try ILendingPool(lendingPool).withdraw(want, remainingSupply, address(this)) {
                } catch {
                    // Ignore if withdrawal fails
                }
            }
        }
    }

    function _getSauceQuoteForXSauceAmount(uint256 sauceAmount) internal view returns (uint256) {
        if (sauceAmount == 0) return 0;
        
        // Use staking pool's conversion rate with buffer for safety
        uint256 xSauceAmount = ISaucerSwapMothership(stakingPool).sauceForxSauce(sauceAmount);
        // Add slippage buffer for safety
        return xSauceAmount + (xSauceAmount * slippageTolerance) / 10000;
    }

    function harvest() external whenNotPaused {

        if (isRewardsAvailable) {
            // Claim rewards from lending pool
            address[] memory assets = new address[](1);
            assets[0] = aToken;
            IRewardsController(rewardsController).claimRewards(assets, type(uint256).max, address(this), want);
        }

        uint256 wantHarvested = balanceOfWant();
        if (wantHarvested > 0) {
            chargeFees();
            deposit();
        }

        lastHarvest = block.timestamp;
        emit StratHarvest(msg.sender, wantHarvested, balanceOf());
    }

    function chargeFees() internal {
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > 0) {
            IFeeConfig.FeeCategory memory fees = getFees();
            uint256 callFeeAmount = (wantBal * fees.call) / 1e18;
            uint256 beefyFeeAmount = (wantBal * fees.beefy) / 1e18;
            uint256 strategistFeeAmount = isBonzoDeployer ? 0 : (wantBal * fees.strategist) / 1e18;
            if (callFeeAmount > 0) {
                _safeTransfer(want, address(this), msg.sender, callFeeAmount);
            }
            if (beefyFeeAmount > 0) {
                _safeTransfer(want, address(this), beefyFeeRecipient, beefyFeeAmount);
            }
            if (strategistFeeAmount > 0) {
                _safeTransfer(want, address(this), strategist, strategistFeeAmount);
            }

            emit ChargedFees(callFeeAmount, beefyFeeAmount, strategistFeeAmount);
        }
    }

    function balanceOf() public view returns (uint256) {
        return balanceOfWant() + balanceOfPool();
    }

    function balanceOfWant() public view returns (uint256) {
        return IERC20(want).balanceOf(address(this));
    }

    function balanceOfPool() public view returns (uint256) {
        return IERC20(aToken).balanceOf(address(this));
    }

    function _getStakedBalance() internal view returns (uint256) {
        return ISaucerSwapMothership(stakingPool).sauceBalance(address(this));
    }

    function setHarvestOnDeposit(bool _harvestOnDeposit) external onlyManager {
        harvestOnDeposit = _harvestOnDeposit;
        emit HarvestOnDepositUpdated(harvestOnDeposit, _harvestOnDeposit);
    }

    function setRewardsAvailable(bool _isRewardsAvailable) external onlyManager {
        isRewardsAvailable = _isRewardsAvailable;
        emit RewardsAvailabilityUpdated(isRewardsAvailable, _isRewardsAvailable);
    }

    function panic() external onlyManager {
        _pause();
        emit StratPanicCalled();
    }

    function pause() external onlyManager {
        _pause();
    }

    function unpause() external onlyManager {
        _unpause();
    }

    function retireStrat() external {
        require(msg.sender == vault, "!vault");

        uint256 totalPosition = balanceOf();
        if (totalPosition > 0) {
            _unwindYieldLoops(totalPosition);
        }

        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > 0) {
            _safeTransfer(want, address(this), vault, wantBal);
        }
        emit StrategyRetired();
    }

    function inCaseTokensGetStuck(address _token) external onlyManager {
        require(_token != want, "!want");
        require(_token != borrowToken, "!borrowToken");
        require(_token != aToken, "!aToken");
        require(_token != debtToken, "!debtToken");

        uint256 amount = IERC20(_token).balanceOf(address(this));
        if (amount > 0) {
            _safeTransfer(_token, address(this), msg.sender, amount);
        }
    }

    // Strategy metadata
    function name() external pure returns (string memory) {
        return "Strategy Bonzo SAUCE Leveraged Liquidity Staking";
    }

    function symbol() external pure returns (string memory) {
        return "strategy-bonzo-sauce-leveraged";
    }

    function version() external pure returns (string memory) {
        return "1.0";
    }

    function description() external pure returns (string memory) {
        return "Strategy for Bonzo SAUCE Leveraged Liquidity Staking";
    }

    function category() external pure returns (string memory) {
        return "Leveraged Staking";
    }

    function riskLevel() external pure returns (uint8) {
        return 3; // Medium risk due to leverage
    }

    // Strategy-specific getters
    function getMaxLoops() external view returns (uint256) {
        return maxLoops;
    }

    function setMaxLoops(uint256 _maxLoops) external onlyManager {
        require(_maxLoops > 0 && _maxLoops <= 10, "!range"); // Reasonable range: 1-10x
        maxLoops = _maxLoops;
        emit MaxLoopsUpdated(maxLoops, _maxLoops);
    }

    function getMaxBorrowable() external view returns (uint256) {
        return maxBorrowable;
    }

    function setMaxBorrowable(uint256 _maxBorrowable) external onlyManager {
        require(_maxBorrowable <= 10000, "!cap"); // Cannot be more than 100%
        maxBorrowable = _maxBorrowable;
        emit MaxBorrowableUpdated(maxBorrowable, _maxBorrowable);
    }

    function getLendingPool() external view returns (address) {
        return lendingPool;
    }

    function getRewardsController() external view returns (address) {
        return rewardsController;
    }

    function setSlippageTolerance(uint256 _slippageTolerance) external onlyManager {
        require(_slippageTolerance <= 500, "Slippage too high"); // Max 5%
        emit SlippageToleranceUpdated(slippageTolerance, _slippageTolerance);
        slippageTolerance = _slippageTolerance;
    }

    function withdraw(uint256 _amount) external nonReentrant whenNotPaused {
        require(msg.sender == vault, "!vault");
        require(_amount > 0, "Amount must be greater than 0");

        uint256 totalPosition = balanceOf();
        require(_amount <= totalPosition, "Withdraw amount too large");

        if (totalPosition == 0) return;

        // Calculate withdrawal percentage in basis points (10000 = 100%)
        uint256 withdrawBps = (_amount * 10000) / totalPosition;
        if (withdrawBps > 10000) withdrawBps = 10000; // Cap at 100%

        // For near-complete withdrawal (>99.5%), exit all positions to avoid rounding issues
        if (withdrawBps >= 9950) {
            _completePositionExit();
        } else {
            // Unwind yield loops for partial withdrawals
            _unwindYieldLoops(_amount);
        }

        // Get the actual amount of want tokens we have
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > _amount) {
            wantBal = _amount;
        }

        // Apply withdrawal fee if not owner and not paused
        // using tx.origin since withdraw is called by vault and validation check is done for original trx sender - EOA
        if (tx.origin != owner() && !paused()) {
            uint256 withdrawalFeeAmount = (wantBal * withdrawalFee) / WITHDRAWAL_MAX;
            wantBal = wantBal - withdrawalFeeAmount;
        }

        // Transfer want tokens to vault
        _safeTransfer(want, address(this), vault, wantBal);

        emit Withdraw(wantBal);
    }
}
