// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "@openzeppelin-4/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin-4/contracts/security/Pausable.sol";
import "../../interfaces/bonzo/ILendingPool.sol";
import "../../interfaces/bonzo/IWHBARGateway.sol";
import "../../interfaces/bonzo/IRewardsController.sol";
import "../../interfaces/bonzo/IDebtToken.sol";
import "../Common/StratFeeManagerInitializable.sol";
import "../../utils/GasFeeThrottler.sol";
import "../../Hedera/IHederaTokenService.sol";
import "../../interfaces/beefy/IStrategyV7.sol";
import "../../interfaces/common/IFeeConfig.sol";
import "./Stader/IStaking.sol";
import "../../Hedera/IWHBARHelper.sol";
import "../../interfaces/common/IUniswapRouterV3WithDeadline.sol";
import "../../utils/UniswapV3Utils.sol";

contract BonzoHBARXLevergedLiqStaking is StratFeeManagerInitializable {
    using SafeERC20 for IERC20;
    using UniswapV3Utils for bytes;

    // Hedera Token Service constants
    address constant HTS_PRECOMPILE = address(0x167);
    int64 constant HTS_SUCCESS = 22;
    int64 constant PRECOMPILE_BIND_ERROR = -1;

    // Tokens used
    address public want; // HBARX token
    address public borrowToken; // HBAR token
    address public aToken; // aHBARX token
    address public debtToken; // debtHBAR token
    address public stakingContract; // HBAR staking contract
    uint8 public wantTokenDecimals; // Token decimals
    uint8 public borrowTokenDecimals; // Token decimals
    address public whbarHelper;

    // Third party contracts
    address public lendingPool;
    address public rewardsController;
    address public whbarGateway; // WHBARGateway for borrow/repay operations
    address public saucerSwapRouter; // SaucerSwap router for HBARX to HBAR swaps
    uint24 public poolFee; // Default pool fee (0.3% mainnet) (0.30% testnet)

    //  loop parameters
    uint8 minDeposit;
    uint256 public maxLoops; // Maximum number of yield loops (e.g., 3 for 3x)
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
    event SwappedHBARXToHBAR(uint256 hbarxAmount, uint256 hbarReceived);
    event SlippageToleranceUpdated(uint256 oldValue, uint256 newValue);
    event RewardsAvailabilityUpdated(bool oldValue, bool newValue);
    event HarvestOnDepositUpdated(bool oldValue, bool newValue);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);
    event StratPanicCalled();
    event StrategyRetired();
    event DebugValues(
        uint256 collateralBase,
        uint256 debtBase,
        uint256 ltv,
        uint256 maxBorrowBase,
        uint256 desired
    );
    event UnstakeDebug(uint256 hbarxAmount, uint256 expectedHbarAmount, uint256 actualHbarAmount);

    error MaxBorrowTokenIsZero(
        uint256 baseCollateral,
        uint256 baseDebt,
        uint256 currentLtv
    );
    error NotEnoughHBAR(uint256 availableHBAR, uint256 requiredHBAR);
    error InsufficientHBARForDebtRepayment(uint256 layerDebt, uint256 expectedHBAR, uint256 minHBAR);

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        // (a + b - 1) / b with protection for a=0
        return a == 0 ? 0 : ((a - 1) / b) + 1;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _convertHbarToHbarXRoundUp(uint256 hbarAmount) internal view returns (uint256) {
        // Convert HBAR amount to equivalent HBARX amount using exchange rate, rounding up
        // exchangeRate is HBAR/1 HBARX in 8 decimals
        uint256 exchangeRate = IStaking(stakingContract).getExchangeRate();
        return _ceilDiv(hbarAmount * 1e8, exchangeRate);
    }

    function initialize(
        address _want,
        address _borrowToken,
        address _aToken,
        address _debtToken,
        address _lendingPool,
        address _rewardsController,
        address _stakingContract,
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
        require(_stakingContract != address(0), "stakingContract cannot be zero address");
        require(_maxBorrowable > 0 && _maxBorrowable <= 10000, "maxBorrowable must be between 0 and 10000");

        want = _want;
        borrowToken = _borrowToken;
        aToken = _aToken;
        debtToken = _debtToken;
        lendingPool = _lendingPool;
        rewardsController = _rewardsController;
        stakingContract = _stakingContract;
        saucerSwapRouter = _commonAddresses.unirouter; // Set SaucerSwap router
        maxBorrowable = _maxBorrowable;
        slippageTolerance = _slippageTolerance;
        isRewardsAvailable = _isRewardsAvailable;
        isBonzoDeployer = _isBonzoDeployer;

        wantTokenDecimals = 8;
        borrowTokenDecimals = 8;
        minDeposit = 3;
        maxLoops = 1;
        whbarGateway = 0xa7e46f496b088A8f8ee35B74D7E58d6Ce648Ae64;

        whbarHelper =  block.chainid == 295
                ? 0x000000000000000000000000000000000058A2BA
                : 0x000000000000000000000000000000000050a8a7;

        poolFee = block.chainid == 295 ? 1500 : 3000;
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
        require(msg.sender == vault, "!vault");
        _deposit();
    }

    function _deposit() internal {
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        require(wantBal > 0, "!funds");
        require(wantBal >= minDeposit*10**8, "!min HBARX");
        _createYieldLoops(wantBal);
    }

    function _createYieldLoops(uint256 amount) internal {
        require(amount > 0, "!amount");

        // Approve once for everything we'll need
        uint256 approvalAmount = amount * (maxLoops * 2);

        IERC20(want).approve(lendingPool, approvalAmount);
        IDebtToken(debtToken).approveDelegation(whbarGateway, approvalAmount);

        // Initial deposit
        ILendingPool(lendingPool).deposit(want, amount, address(this), 0);
        
        // Track new collateral added each iteration (starts with initial deposit)
        uint256 newCollateralThisLoop = amount;
        uint256 totalBorrowed = 0;

        for (uint256 i = 0; i < maxLoops; i++) {
            // Get fresh exchange rate each iteration
            // getExchangeRate() returns HBAR/1 HBARX in 8 decimals
            uint256 exchangeRate = IStaking(stakingContract).getExchangeRate();
            
            // Calculate borrow amount based ONLY on new collateral from this iteration
            uint256 newCollateralValueInHBAR = (newCollateralThisLoop * exchangeRate) / 1e8;
            uint256 borrowAmt = (newCollateralValueInHBAR * maxBorrowable) / 10_000;
            
            if (borrowAmt == 0) break;

            // Check health factor before borrowing to prevent liquidation risk
            (, , , , , uint256 healthFactor) = ILendingPool(lendingPool).getUserAccountData(address(this));
            // If health factor is below 1.5, stop looping (150% safety margin)
            // Health factor is returned in 18 decimals (1e18 = 1.0)
            if (i > 0 && healthFactor < 1.5e18) break;

            // Borrow & stake → HBARX
            IDebtToken(debtToken).approveDelegation(whbarGateway, borrowAmt);
            IWHBARGateway(whbarGateway).borrowHBAR(lendingPool, borrowAmt, 2, 0);
            uint256 hbarBalance = address(this).balance;
            
            //min staking amount is 10**8 on staking contract
            if(hbarBalance > 10**8) {
                uint256 xAmt = _stakeHBAR(hbarBalance);
                require(xAmt > 0, "No HBARX received from staking");
                
                totalBorrowed += borrowAmt;
                ILendingPool(lendingPool).deposit(want, xAmt, address(this), 0);
                
                // Update newCollateralThisLoop with ACTUAL amount received for next iteration
                newCollateralThisLoop = xAmt;
            } 
            else {
                break;
            }
        }

        emit Deposit(newCollateralThisLoop, totalBorrowed);
    }

    function _stakeHBAR(uint256 amount) internal returns (uint256) {
        require(amount > 0, "Amount must be greater than 0");
        uint256 balanceBefore = IERC20(want).balanceOf(address(this));
        IStaking(stakingContract).stake{value: amount}();
        uint256 balanceAfter = IERC20(want).balanceOf(address(this));
        uint256 received = balanceAfter - balanceBefore;
        require(received > 0, "No HBARX received from staking");
        emit Staked(received);
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

        // Approvals for router swaps during unwind
        IERC20(want).approve(saucerSwapRouter, _targetAmount * 3);

        // Iterate: repay using loose HBARX, then withdraw only the HF-safe amount of collateral, then repeat.
        // This avoids "health factor too low" reverts when trying to withdraw too much collateral before repaying.
        uint256 maxIterations = (maxLoops + 1) * 6 + 6; // bounded, but enough for full exits
        for (uint256 i = 0; i < maxIterations; i++) {
            uint256 debtBal = IERC20(debtToken).balanceOf(address(this));
            if (debtBal <= targetDebtRemaining) break;

            // 1) Repay as much as possible using loose HBARX balance (not counted as collateral by the lending pool)
            uint256 availableHbarx = IERC20(want).balanceOf(address(this));
            if (availableHbarx > 0) {
                uint256 debtToRepay = debtBal - targetDebtRemaining;
                uint256 hbarxNeeded = _convertHbarToHbarXRoundUp(debtToRepay);
                // Add slippage buffer (2%) to ensure we can cover the debt after swap
                hbarxNeeded = (hbarxNeeded * 10200) / 10000;

                uint256 hbarxToSwap = _min(availableHbarx, hbarxNeeded);
                if (hbarxToSwap > 0) {
                    uint256 hbarAmount = _swapHBARXToHBAR(hbarxToSwap);
                    if (hbarAmount > 0) {
                        uint256 repayAmount = _min(hbarAmount, debtToRepay);
                        repayAmount = _min(repayAmount, debtBal);
                        if (repayAmount > 0) {
                            IWHBARGateway(whbarGateway).repayHBAR{value: repayAmount}(
                                lendingPool,
                                repayAmount,
                                2,
                                address(this)
                            );
                        }

                        // If we have excess HBAR after repaying, convert it back to HBARX
                        uint256 excessHbar = hbarAmount > repayAmount ? hbarAmount - repayAmount : 0;
                        if (excessHbar > 0) {
                            _swapHBARToHBARX(excessHbar);
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

            // If HF is already close to 1, be extra conservative.
            // healthFactor is 1e18, so 1.05e18 = 5% buffer.
            if (healthFactor <= 1.05e18) break;

            // No collateral (shouldn't happen if currentSupply > target)
            if (totalCollateralETH == 0 || currentLiquidationThreshold == 0) break;

            // Required collateral to keep HF >= 1:
            // collateralETH * liqThreshold / 10000 >= debtETH  => collateralETH >= debtETH * 10000 / liqThreshold
            uint256 requiredCollateralETH = _ceilDiv(totalDebtETH * 10_000, currentLiquidationThreshold);
            if (totalCollateralETH <= requiredCollateralETH) break;

            uint256 withdrawableETH = totalCollateralETH - requiredCollateralETH;
            uint256 withdrawableFactor = (withdrawableETH * 1e18) / totalCollateralETH; // 0..1e18

            // Safety margin to avoid rounding/oracle drift between calculations and withdraw()
            withdrawableFactor = (withdrawableFactor * 9500) / 10000; // keep 5% buffer
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
    
    function _convertHbarToHbarX(uint256 hbarAmount) internal view returns (uint256) {
        // Convert HBAR amount to equivalent HBARX amount using exchange rate
        // exchangeRate is HBAR/1 HBARX in 8 decimals
        uint256 exchangeRate = IStaking(stakingContract).getExchangeRate();
        return (hbarAmount * 1e8) / exchangeRate;
    }


    function _swapHBARXToHBAR(uint256 amount) internal returns (uint256) {
        require(amount > 0, "Amount must be greater than 0");
        uint256 balanceBefore = address(this).balance;
        
        // Get expected output and apply slippage protection
        uint256 expectedHBAR = getSwapQuote(amount);
        uint256 minHBAR = (expectedHBAR * (10000 - slippageTolerance)) / 10000;
        
        // Create swap path for HBARX to HBAR (via WHBAR if needed)
        address[] memory route = new address[](2);
        route[0] = want; // HBARX
        route[1] = borrowToken; // HBAR (WHBAR)
        
        uint24[] memory fees = new uint24[](1);
        fees[0] = poolFee;
        
        bytes memory path = UniswapV3Utils.routeToPath(route, fees);
        
        // Approve router to spend HBARX
        IERC20(want).approve(saucerSwapRouter, amount);
        
        IUniswapRouterV3WithDeadline.ExactInputParams memory params = IUniswapRouterV3WithDeadline.ExactInputParams({
            path: path,
            recipient: address(this),
            deadline: block.timestamp + 300, // 5 minute deadline
            amountIn: amount,
            amountOutMinimum: minHBAR
        });
        
        uint256 amountOut = IUniswapRouterV3WithDeadline(saucerSwapRouter).exactInput(params);
        //unwrap whbar to hbar
        if(amountOut == 0) {
            revert("No HBAR received from swap");
        }
        IERC20(borrowToken).approve(whbarHelper, amountOut);
        IWHBARHelper(whbarHelper).unwrapWhbar(amountOut);
        uint256 balanceAfter = address(this).balance;
        uint256 received = balanceBefore > balanceAfter ? 0 : balanceAfter - balanceBefore;        
        emit SwappedHBARXToHBAR(amount, received);
        require(received > 0, "No HBAR received from swap");
        
        return received;
    }

    function _swapHBARToHBARX(uint256 amount) internal returns (uint256) {
        require(amount > 0, "Amount must be greater than 0");
        
        // Get expected output and apply slippage protection
        uint256 expectedHBARX = getSwapQuoteReverse(amount);
        uint256 minHBARX = (expectedHBARX * (10000 - slippageTolerance)) / 10000;
        
        // Create swap path for HBAR to HBARX (via WHBAR if needed)
        address[] memory route = new address[](2);
        route[0] = borrowToken; // HBAR (WHBAR)
        route[1] = want; // HBARX
        
        uint24[] memory fees = new uint24[](1);
        fees[0] = poolFee;
        
        bytes memory path = UniswapV3Utils.routeToPath(route, fees);
        
        IUniswapRouterV3WithDeadline.ExactInputParams memory params = IUniswapRouterV3WithDeadline.ExactInputParams({
            path: path,
            recipient: address(this),
            deadline: block.timestamp + 300, // 5 minute deadline
            amountIn: amount,
            amountOutMinimum: minHBARX
        });
        
        uint256 amountOut = IUniswapRouterV3WithDeadline(saucerSwapRouter).exactInput{value: amount}(params);
        
        return amountOut;
    }

    function harvest() external whenNotPaused  {
        _harvest(msg.sender);
    }

    function harvest(address callFeeRecipient) external whenNotPaused  {
        _harvest(callFeeRecipient);
    }

    function _harvest(address callFeeRecipient) internal {
        require(callFeeRecipient != address(0), "Invalid fee recipient");
        if (isRewardsAvailable) {
            address[] memory assets = new address[](2);
            assets[0] = aToken;
            assets[1] = debtToken;
            IRewardsController(rewardsController).claimRewards(assets, type(uint256).max, address(this), want);
        }

        uint256 wantHarvested = balanceOfWant();
        if (wantHarvested > 0 && wantHarvested >= 3*10**8)  {
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
            uint256 totalFees = wantBal * fees.total / DIVISOR;
            uint256 callFeeAmount = totalFees * fees.call / DIVISOR;
            uint256 beefyFeeAmount = totalFees * fees.beefy / DIVISOR;
            uint256 strategistFeeAmount = isBonzoDeployer ? 0 : totalFees * fees.strategist / DIVISOR;
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
        uint256 debtInHbarX = _convertHbarToHbarX(borrowBal);
        uint256 totalAssets = balanceOfWant() + balanceOfPool();
        return totalAssets > debtInHbarX ? totalAssets - debtInHbarX : 0;
    }

    function balanceOfWant() public view returns (uint256) {
        return IERC20(want).balanceOf(address(this));
    }

    function balanceOfPool() public view returns (uint256) {
        return IERC20(aToken).balanceOf(address(this));
    }

    function _getStakedBalance() internal view returns (uint256) {
        uint256 exchangeRate = IStaking(stakingContract).getExchangeRate();
        uint256 hbarxBalance = IERC20(want).balanceOf(address(this));
        return (hbarxBalance * exchangeRate) / 1e8; // Convert from tinybar to HBAR
    }

    function withdraw(uint256 _amount) external nonReentrant whenNotPaused {
        require(msg.sender == vault, "!vault");
        require(_amount > 0, "Amount must be greater than 0");

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
        if (tx.origin != owner() && !paused()) {
            uint256 withdrawalFeeAmount = (wantBal * withdrawalFee) / WITHDRAWAL_MAX;
            wantBal = wantBal > withdrawalFeeAmount ? wantBal - withdrawalFeeAmount : 0;
        }

        // Transfer want tokens to vault
        _safeTransfer(want, address(this), vault, wantBal);

        emit Withdraw(wantBal);
    }

    // Strategy metadata
    function name() external pure returns (string memory) {
        return "Strategy Bonzo HBARX Leveraged Liquidity Staking";
    }

    function symbol() external pure returns (string memory) {
        return "strategy-bonzo-hbarx-leveraged";
    }

    function version() external pure returns (string memory) {
        return "1.0";
    }

    function description() external pure returns (string memory) {
        return "Strategy for Bonzo HBARX Leveraged Liquidity Staking";
    }

    function category() external pure returns (string memory) {
        return "Leveraged Staking";
    }

    function riskLevel() external pure returns (uint8) {
        return 3; // Medium risk due to leverage
    }

    // Strategy-specific getters and setters
    
    function setWhbarHelper(address _whbarHelper) external onlyManager {
        whbarHelper = _whbarHelper;
    }

    function setWhbarGateway(address _whbarGateway) external onlyManager {
        require(_whbarGateway != address(0), "Gateway cannot be zero address");
        whbarGateway = _whbarGateway;
    }

    function setSaucerSwapRouter(address _saucerSwapRouter) external onlyManager {
        require(_saucerSwapRouter != address(0), "Router cannot be zero address");
        saucerSwapRouter = _saucerSwapRouter;
    }

    function getSaucerSwapRouter() external view returns (address) {
        return saucerSwapRouter;
    }

    function getSwapQuote(uint256 amountIn) public view returns (uint256 amountOut) {
        require(amountIn > 0, "Amount must be greater than 0");
        
        // Use exchange rate from staking contract to calculate HBARX to HBAR conversion
        // exchangeRate is HBAR/1 HBARX in 8 decimals
        uint256 exchangeRate = IStaking(stakingContract).getExchangeRate();
        return (amountIn * exchangeRate) / 1e8;
    }

    function getSwapQuoteReverse(uint256 amountIn) public view returns (uint256 amountOut) {
        require(amountIn > 0, "Amount must be greater than 0");
        
        // Use exchange rate from staking contract to calculate HBAR to HBARX conversion
        // exchangeRate is HBAR/1 HBARX in 8 decimals
        uint256 exchangeRate = IStaking(stakingContract).getExchangeRate();
        return (amountIn * 1e8) / exchangeRate;
    }

    function setPoolFee(uint24 _poolFee) external onlyManager {
        poolFee = _poolFee;
    }

    function setHarvestOnDeposit(bool _harvestOnDeposit) external onlyManager {
        harvestOnDeposit = _harvestOnDeposit;
        emit HarvestOnDepositUpdated(harvestOnDeposit, _harvestOnDeposit);
    }

    function setRewardsAvailable(bool _isRewardsAvailable) external onlyManager {
        isRewardsAvailable = _isRewardsAvailable;
        emit RewardsAvailabilityUpdated(isRewardsAvailable, _isRewardsAvailable);
    }

    function setSlippageTolerance(uint256 _slippageTolerance) external onlyManager {
        require(_slippageTolerance <= 500, "Slippage too high"); // Max 5%
        emit SlippageToleranceUpdated(slippageTolerance, _slippageTolerance);
        slippageTolerance = _slippageTolerance;
    }

    function panic() public {
        require(msg.sender == owner() || msg.sender == keeper || msg.sender == vault, "!invalid caller");
        if (isRewardsAvailable) {
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

    receive() external payable {}
}

