// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

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
    uint8 public wantTokenDecimals; // Token decimals (xSAUCE)
    uint8 public borrowTokenDecimals; // Token decimals (SAUCE)

    // Third party contracts
    address public lendingPool;
    address public rewardsController;

    // Yield loop parameters
    uint8 public minDeposit; // Minimum deposit in want decimals
    uint256 public maxLoops; // Maximum number of yield loops (e.g., 3 for 3x)
    uint256 public maxBorrowable; // Maximum borrowable amount (e.g., 8000 for 80%)
    uint256 public slippageTolerance; // Conversion buffer in basis points (e.g., 50 for 0.5%)

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
    event MaxBorrowableUpdated(uint256 oldValue, uint256 newValue);
    event MaxLoopsUpdated(uint256 oldValue, uint256 newValue);
    event RewardsAvailabilityUpdated(bool oldValue, bool newValue);
    event HarvestOnDepositUpdated(bool oldValue, bool newValue);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);
    event StratPanicCalled();
    event StrategyRetired();
    event DebugValues(
        uint256 collateralBase,
        uint256 debtBase,
        uint256 ltv,
        uint256 saucePrice,
        uint256 maxBorrowBase,
        uint256 desired
    );
    event RewardsControllerUpated(address oldValue, address newValue);

    error MaxBorrowTokenIsZero(
        uint256 baseCollateral,
        uint256 baseDebt,
        uint256 currentLtv,
        uint256 decimalDiff,
        uint256 saucePrice
    );

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : ((a - 1) / b) + 1;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

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

        // Defaults
        wantTokenDecimals = 6;
        borrowTokenDecimals = 6;
        minDeposit = 3;
        maxLoops = 1;

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
        require(amount > 0, "sf:Amount must be greater than 0");
        require(amount <= uint256(uint64(type(int64).max)), "Amount too large for int64");
        _transferHTS(token, from, to, int64(uint64(amount)));
    }

    function _transferHTS(address token, address from, address to, int64 amount) internal {
        require(token != address(0), "Invalid token address");
        require(from != address(0), "Invalid from address");
        require(to != address(0), "Invalid to address");
        require(amount > 0, "th:Amount must be greater than 0");

        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.transferToken.selector, token, from, to, amount)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        if (responseCode != HTS_SUCCESS) {
            emit HTSTokenTransferFailed(token, from, to, responseCode);
            revert("HTS token transfer failed");
        }
    }

    function beforeDeposit() external virtual override nonReentrant {
        if (harvestOnDeposit) {
            require(msg.sender == vault, "!vault");
            _harvest(tx.origin);
        }
    }

    function deposit() public whenNotPaused nonReentrant {
        require(msg.sender == vault, "!vault");
        _deposit();
    }

    function _deposit() internal {
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        require(wantBal > 0, "!funds");
        require(wantBal >= uint256(minDeposit) * (10 ** wantTokenDecimals), "!min xSAUCE");
        _createYieldLoops(wantBal);
    }

    function _createYieldLoops(uint256 amount) internal {
        require(amount > 0, "!amount");

        // Approve for deposits/repays/staking
        uint256 approvalAmount = amount * (maxLoops * 2);
        IERC20(want).approve(lendingPool, approvalAmount);
        IERC20(borrowToken).approve(lendingPool, approvalAmount);
        IERC20(borrowToken).approve(stakingPool, approvalAmount);

        // Initial deposit
        ILendingPool(lendingPool).deposit(want, amount, address(this), 0);

        // Track new collateral added each iteration (starts with initial deposit)
        uint256 newCollateralThisLoop = amount;
        uint256 totalBorrowed = 0;

        for (uint256 i = 0; i < maxLoops; i++) {
            // Health factor check (1e18; 1.5e18 = 150% buffer)
            (, , , , , uint256 healthFactor) = ILendingPool(lendingPool).getUserAccountData(address(this));
            if (i > 0 && healthFactor < 1.5e18) break;

            // Calculate borrow amount based ONLY on new collateral from this iteration.
            // Convert xSAUCE → SAUCE value via the mothership.
            uint256 newCollateralValueInSauce = ISaucerSwapMothership(stakingPool).xSauceForSauce(newCollateralThisLoop);
            uint256 borrowAmt = (newCollateralValueInSauce * maxBorrowable) / 10_000;

            if (borrowAmt == 0) break;

            // Borrow & stake → xSAUCE
            ILendingPool(lendingPool).borrow(borrowToken, borrowAmt, 2, 0, address(this));
            uint256 xAmt = _enter(borrowAmt);
            require(xAmt > 0, "No xSAUCE received from staking");

            totalBorrowed += borrowAmt;
            ILendingPool(lendingPool).deposit(want, xAmt, address(this), 0);

            // Update newCollateralThisLoop with ACTUAL amount received for next iteration
            newCollateralThisLoop = xAmt;
        }

        emit Deposit(newCollateralThisLoop, totalBorrowed);
    }

    function _enter(uint256 amount) internal returns (uint256) {
        require(amount > 0, "en:Amount must be greater than 0");
        uint256 balanceBefore = IERC20(want).balanceOf(address(this));
        ISaucerSwapMothership(stakingPool).enter(amount);
        uint256 balanceAfter = IERC20(want).balanceOf(address(this));
        uint256 received = balanceAfter - balanceBefore;
        require(received > 0, "No tokens received from staking");
        emit Staked(received);
        return received;
    }

    function _leave(uint256 amount) internal returns (uint256) {
        if (amount == 0) return 0;

        uint256 balanceBefore = IERC20(borrowToken).balanceOf(address(this));
        uint256 currWantBal = IERC20(want).balanceOf(address(this));
        if (currWantBal == 0) return 0;
        if (amount > currWantBal) amount = currWantBal;
        if (amount == 0) return 0;

        ISaucerSwapMothership(stakingPool).leave(amount);
        uint256 balanceAfter = IERC20(borrowToken).balanceOf(address(this));
        uint256 received = balanceAfter - balanceBefore;
        require(received > 0, "No tokens received from unstaking");

        emit Unstaked(received);
        return received;
    }

    function _unwindYieldLoops(uint256 _targetAmount) internal {
        require(_targetAmount > 0, "uy:Amount must be greater than 0");
        uint256 totalAssets = balanceOf();
        require(_targetAmount <= totalAssets, "Amount exceeds total position");

        if (totalAssets == 0) return;

        // Convert to ratio for calculations (1e18 = 100%)
        uint256 withdrawRatio = (_targetAmount * 1e18) / totalAssets;

        // Targets: after unwinding we want to keep (1-withdrawRatio) of collateral + debt in the lending position.
        uint256 aTokenStart = IERC20(aToken).balanceOf(address(this));
        uint256 debtStart = IERC20(debtToken).balanceOf(address(this));

        uint256 aTokenToRemove = (aTokenStart * withdrawRatio) / 1e18;
        uint256 debtToRemove = (debtStart * withdrawRatio) / 1e18;

        uint256 targetATokenRemaining = aTokenStart > aTokenToRemove ? aTokenStart - aTokenToRemove : 0;
        uint256 targetDebtRemaining = debtStart > debtToRemove ? debtStart - debtToRemove : 0;

        // Approvals for unstake/repay during unwind
        IERC20(want).approve(stakingPool, _targetAmount * 3);
        IERC20(borrowToken).approve(lendingPool, type(uint256).max);

        // Iterate: repay using loose xSAUCE (unstake to SAUCE), then withdraw only the HF-safe amount of collateral, then repeat.
        uint256 maxIterations = (maxLoops + 2); // bounded, but enough for full exits
        for (uint256 i = 0; i < maxIterations; i++) {
            uint256 debtBal = IERC20(debtToken).balanceOf(address(this));
            if (debtBal <= targetDebtRemaining) break;

            // 1) Repay as much as possible using loose xSAUCE balance (not counted as collateral by the lending pool)
            uint256 availableXSauce = IERC20(want).balanceOf(address(this));
            if (availableXSauce > 0) {
                uint256 debtToRepay = debtBal - targetDebtRemaining;

                // Convert SAUCE debt to xSAUCE amount needed, with a small buffer for rounding/exchange drift.
                uint256 xSauceNeeded = ISaucerSwapMothership(stakingPool).sauceForxSauce(debtToRepay);
                uint256 bufferBps = slippageTolerance > 200 ? slippageTolerance : 200; // at least 2%
                xSauceNeeded = (xSauceNeeded * (10_000 + bufferBps)) / 10_000;

                uint256 xSauceToLeave = _min(availableXSauce, xSauceNeeded);
                if (xSauceToLeave > 0) {
                    uint256 sauceReceived = _leave(xSauceToLeave);
                    if (sauceReceived > 0) {
                        uint256 repayAmount = _min(sauceReceived, debtToRepay);
                        repayAmount = _min(repayAmount, debtBal);

                        if (repayAmount > 0) {
                            ILendingPool(lendingPool).repay(borrowToken, repayAmount, 2, address(this));
                        }

                        // Stake excess SAUCE back to xSAUCE (keeps the strategy in the desired asset)
                        uint256 excessSauce = sauceReceived > repayAmount ? sauceReceived - repayAmount : 0;
                        if (excessSauce > 0) {
                            _enter(excessSauce);
                        }
                    }
                }
            }

            // Re-check debt after repayment attempt
            debtBal = IERC20(debtToken).balanceOf(address(this));
            if (debtBal <= targetDebtRemaining) break;

            // If we already removed enough collateral, but still have debt, we cannot proceed safely.
            uint256 currentSupply = IERC20(aToken).balanceOf(address(this));
            if (currentSupply <= targetATokenRemaining) break;

            // 2) Compute HF-safe withdrawable fraction using account data (single-collateral assumption).
            (
                uint256 totalCollateralETH,
                uint256 totalDebtETH,
                ,
                uint256 currentLiquidationThreshold,
                ,
                uint256 healthFactor
            ) = ILendingPool(lendingPool).getUserAccountData(address(this));

            // healthFactor is 1e18, so 1.05e18 = 5% buffer.
            if (healthFactor <= 1.05e18) break;
            if (totalCollateralETH == 0 || currentLiquidationThreshold == 0) break;

            // collateralETH * liqThreshold / 10000 >= debtETH  => collateralETH >= debtETH * 10000 / liqThreshold
            uint256 requiredCollateralETH = _ceilDiv(totalDebtETH * 10_000, currentLiquidationThreshold);
            if (totalCollateralETH <= requiredCollateralETH) break;

            uint256 withdrawableETH = totalCollateralETH - requiredCollateralETH;
            uint256 withdrawableFactor = (withdrawableETH * 1e18) / totalCollateralETH; // 0..1e18

            // Safety margin to avoid rounding/oracle drift between calculations and withdraw()
            withdrawableFactor = (withdrawableFactor * 9500) / 10_000; // keep 5% buffer
            if (withdrawableFactor == 0) break;

            uint256 maxWithdrawTokens = (currentSupply * withdrawableFactor) / 1e18;
            uint256 neededWithdrawTokens = currentSupply - targetATokenRemaining;
            uint256 withdrawAmount = _min(maxWithdrawTokens, neededWithdrawTokens);
            if (withdrawAmount == 0) break;

            ILendingPool(lendingPool).withdraw(want, withdrawAmount, address(this));
        }

        // If we've fully cleared debt for the removed share, withdraw any remaining collateral for the removed share.
        uint256 finalDebtBal = IERC20(debtToken).balanceOf(address(this));
        if (finalDebtBal <= targetDebtRemaining) {
            uint256 remainingSupply = IERC20(aToken).balanceOf(address(this));
            if (remainingSupply > targetATokenRemaining) {
                ILendingPool(lendingPool).withdraw(want, remainingSupply - targetATokenRemaining, address(this));
            }
        }
    }

    function harvest() external whenNotPaused {
        _harvest(msg.sender);
    }

    function harvest(address callFeeRecipient) external whenNotPaused {
        _harvest(callFeeRecipient);
    }

    function _harvest(address callFeeRecipient) internal {
        require(callFeeRecipient != address(0), "Invalid fee recipient");

        if (isRewardsAvailable) {
            // Claim rewards for both aToken and debtToken
            address[] memory assets = new address[](2);
            assets[0] = aToken;
            assets[1] = debtToken;
            IRewardsController(rewardsController).claimRewards(assets, type(uint256).max, address(this), want);
        }

        uint256 wantHarvested = balanceOfWant();
        if (wantHarvested > 0 && wantHarvested >= uint256(minDeposit) * (10 ** wantTokenDecimals)) {
            chargeFees(callFeeRecipient);
            _deposit();
        }

        lastHarvest = block.timestamp;
        emit StratHarvest(msg.sender, wantHarvested, balanceOf());
    }

    function chargeFees(address callFeeRecipient) internal {
        require(callFeeRecipient != address(0), "Invalid fee recipient");
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > 0) {
            IFeeConfig.FeeCategory memory fees = getFees();
            uint256 totalFees = (wantBal * fees.total) / DIVISOR;
            uint256 callFeeAmount = (totalFees * fees.call) / DIVISOR;
            uint256 beefyFeeAmount = (totalFees * fees.beefy) / DIVISOR;
            uint256 strategistFeeAmount = isBonzoDeployer ? 0 : (totalFees * fees.strategist) / DIVISOR;
            if (callFeeAmount > 0) {
                _safeTransfer(want, address(this), callFeeRecipient, callFeeAmount);
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
        uint256 borrowBal = IERC20(debtToken).balanceOf(address(this));
        // Convert SAUCE debt → xSAUCE needed to cover it
        uint256 debtInXSauce = ISaucerSwapMothership(stakingPool).sauceForxSauce(borrowBal);
        uint256 totalAssets = balanceOfWant() + balanceOfPool();
        return totalAssets > debtInXSauce ? totalAssets - debtInXSauce : 0;
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
        bool oldValue = harvestOnDeposit;
        harvestOnDeposit = _harvestOnDeposit;
        if (harvestOnDeposit) {
            setWithdrawalFee(0);
        } else {
            setWithdrawalFee(10);
        }
        emit HarvestOnDepositUpdated(oldValue, _harvestOnDeposit);
    }

    function setRewardsAvailable(bool _isRewardsAvailable) external onlyManager {
        bool oldValue = isRewardsAvailable;
        isRewardsAvailable = _isRewardsAvailable;
        emit RewardsAvailabilityUpdated(oldValue, _isRewardsAvailable);
    }

    function panic() public {
        require(msg.sender == owner() || msg.sender == keeper || msg.sender == vault, "!invalid caller");
        if (isRewardsAvailable) {
            // Claim rewards from lending pool
            address[] memory assets = new address[](2);
            assets[0] = aToken;
            assets[1] = debtToken;
            IRewardsController(rewardsController).claimRewards(assets, type(uint256).max, address(this), want);
        }
        uint256 totalPosition = balanceOf();
        if (totalPosition > 0) {
            _unwindYieldLoops(totalPosition);
        }
        _pause();
        emit StratPanicCalled();
    }

    function reversePanic() public onlyManager {
        _unpause();
        _createYieldLoops(balanceOfWant());
    }

    function pause() external onlyManager {
        _pause();
    }

    function unpause() external onlyManager {
        _unpause();
    }

    function retireStrat() external {
        require(msg.sender == owner() || msg.sender == keeper || msg.sender == vault, "!invalid caller");
        panic();

        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > 0) {
            _safeTransfer(want, address(this), vault, wantBal);
        }
        _transferOwnership(address(0));
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

    function inCaseNativeTokensGetStuck() external onlyManager {
        uint256 amount = address(this).balance;
        if (amount > 0) {
            payable(msg.sender).transfer(amount);
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

    function getLendingPool() external view returns (address) {
        return lendingPool;
    }

    function setRewardsController(address _rewardsController) external onlyManager {
        require(_rewardsController != address(0), "!zero address");
        address oldValue = rewardsController;
        rewardsController = _rewardsController;
        emit RewardsControllerUpated(oldValue, _rewardsController);
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
        require(_amount > 0, "wd:Amount must be greater than 0");

        uint256 totalPosition = balanceOf();
        require(_amount <= totalPosition, "Withdraw amount too large");

        // Unwind yield loops
        _unwindYieldLoops(_amount);

        // Get the actual amount of want tokens we have
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > _amount) {
            wantBal = _amount;
        }

        // Apply withdrawal fee if not owner and not paused
        // using tx.origin since withdraw is called by vault and validation check is done for original trx sender - EOA
        if (tx.origin != owner() && !paused()) {
            uint256 withdrawalFeeAmount = (wantBal * withdrawalFee) / WITHDRAWAL_MAX;
            wantBal = wantBal > withdrawalFeeAmount ? wantBal - withdrawalFeeAmount : 0;
        }

        // Transfer want tokens to vault
        _safeTransfer(want, address(this), vault, wantBal);

        emit Withdraw(wantBal);
    }

    // ===== Management setters =====

    function setMaxBorrowable(uint256 _maxBorrowable) external onlyManager {
        require(_maxBorrowable > 0 && _maxBorrowable <= 10000, "maxBorrowable must be between 0 and 10000");
        emit MaxBorrowableUpdated(maxBorrowable, _maxBorrowable);
        maxBorrowable = _maxBorrowable;
    }

    function setMaxLoops(uint256 _maxLoops) external onlyManager {
        require(_maxLoops <= 10, "maxLoops too high");
        emit MaxLoopsUpdated(maxLoops, _maxLoops);
        maxLoops = _maxLoops;
    }

    function setStakingPool(address _stakingPool) external onlyManager {
        require(_stakingPool != address(0), "!zero address");
        stakingPool = _stakingPool;
    }

    receive() external payable {}
}
