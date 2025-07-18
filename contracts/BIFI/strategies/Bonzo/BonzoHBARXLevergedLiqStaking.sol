// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin-4/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin-4/contracts/security/Pausable.sol";
import "../../interfaces/bonzo/ILendingPool.sol";
import "../../interfaces/bonzo/IRewardsController.sol";
import "../Common/StratFeeManagerInitializable.sol";
import "../../utils/GasFeeThrottler.sol";
import "../../Hedera/IHederaTokenService.sol";
import "../../interfaces/beefy/IStrategyV7.sol";
import "../../interfaces/common/IFeeConfig.sol";
import "./Stader/IStaking.sol";
import "../../Hedera/IWHBAR.sol";
import "../../interfaces/common/IUniswapRouterV3WithDeadline.sol";
import "../../interfaces/uniswap/IQuoter.sol";
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
    uint8 public wantTokenDecimals = 8; // Token decimals
    uint8 public borrowTokenDecimals = 8; // Token decimals
    // address public whbarContract = 0x0000000000000000000000000000000000163B59; //mainnet
    address public whbarContract;

    // Third party contracts
    address public lendingPool;
    address public rewardsController;
    address public saucerSwapRouter; // SaucerSwap router for HBARX to HBAR swaps
    uint24 public poolFee; // Default pool fee (0.3% mainnet) (0.30% testnet)

    // Yield loop parameters
    uint256 public maxLoops = 1; // Maximum number of yield loops (e.g., 3 for 3x)
    uint256 public maxBorrowable; // Maximum borrowable amount (e.g., 8000 for 80%)
    uint256 public slippageTolerance; // Slippage tolerance in basis points (e.g., 50 for 0.5%)
    address public quoterAddress; // SaucerSwap quoter for price quotes

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
    event MaxLoopsUpdated(uint256 oldValue, uint256 newValue);
    event MaxBorrowableUpdated(uint256 oldValue, uint256 newValue);
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

        whbarContract = block.chainid == 295
            ? 0x0000000000000000000000000000000000163B59
            : 0x0000000000000000000000000000000000003aD1;
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
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        require(wantBal > 0, "No funds to deposit");
        //stakin needs at least 1 HBARX
        // require(wantBal >= 3*10**8, "min 3 HBARX");
        _createYieldLoops(wantBal);
    }

    function _createYieldLoops(uint256 amount) internal {
        require(amount > 0, "Amount must be > 0");

        // Approve once for everything we'll need
        uint256 approvalAmount = amount * (maxLoops * 2);

        IERC20(want).approve(lendingPool, approvalAmount);
        IERC20(borrowToken).approve(lendingPool, approvalAmount);

        // Initial deposit
        ILendingPool(lendingPool).deposit(want, amount, address(this), 0);
        uint256 currentCollateral = amount;
        uint256 totalBorrowed = 0;
        // getExchangeRate() returns HBAR/1 HBARX in 8 decimals, so hbarx/hbar = 1e8 / rate (8 decimals)
        uint256 exchangeRate = IStaking(stakingContract).getExchangeRate(); // 8 decimals

        for (uint256 i = 0; i < maxLoops; i++) {
            uint256 inputCollateralValueInHBAR = (currentCollateral * exchangeRate) / 1e8;
            uint256 borrowAmt = (inputCollateralValueInHBAR * maxBorrowable) / 10_000;
            if(totalBorrowed > 0 && borrowAmt > totalBorrowed) {
                borrowAmt = borrowAmt - totalBorrowed;
            }
            if (borrowAmt == 0) break;

            // [4] borrow & stake → HBARX
            IERC20(borrowToken).approve(whbarContract, borrowAmt);
            ILendingPool(lendingPool).borrow(borrowToken, borrowAmt, 2, 0, address(this));
            uint256 hbarBalance = address(this).balance;
            //min staking amount is 10**8 on staking contract
            if(hbarBalance > 10**8) {
                uint256 xAmt = _stakeHBAR(hbarBalance);
                require(xAmt > 0, "No HBARX received from staking");
                 currentCollateral += xAmt;
                 totalBorrowed += borrowAmt;
                 ILendingPool(lendingPool).deposit(want, xAmt, address(this), 0);
                 currentCollateral += xAmt;
                 totalBorrowed += borrowAmt;
            } 
            else {
                break;
            }
        }

        emit Deposit(currentCollateral, totalBorrowed);
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
        uint256 supplyToWithdraw = (totalSupply * withdrawRatio) / 1e18;
        uint256 debtToRepay = (totalDebt * withdrawRatio) / 1e18;
        
        // Use more accurate DEX quote for debt conversion
        uint256 hbarxForDebt = _getDexQuoteForHbarAmount(debtToRepay);
        // Add buffer to account for slippage and conversion inaccuracies
        hbarxForDebt = hbarxForDebt + (hbarxForDebt * 200) / 10000; // 2% buffer
        supplyToWithdraw = supplyToWithdraw + hbarxForDebt;
        
        // Distribute across layers
        uint256 layerSupply = supplyToWithdraw / (maxLoops + 1);
        uint256 layerDebt = debtToRepay / (maxLoops + 1);
        uint256 debtPaid = 0;

        for (uint256 i = 0; i < maxLoops + 1; i++) {
            // Withdraw from lending pool for this layer
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
                    // Check if we have enough HBAR to repay debt
                    uint256 currentHbarBal = address(this).balance;
                    
                    if (currentHbarBal < debtForThisLayer) {
                        // Need to swap HBARX to HBAR to cover the shortfall
                        uint256 hbarShortfall = debtForThisLayer - currentHbarBal;
                        
                        // Use more accurate DEX quote for conversion
                        uint256 hbarXToSwap = _getDexQuoteForHbarAmount(hbarShortfall);
                        
                        // Ensure we have enough HBARX to swap
                        uint256 hbarXBal = IERC20(want).balanceOf(address(this));
                        if (hbarXToSwap > hbarXBal) {
                            hbarXToSwap = hbarXBal;
                        }
                        
                        if (hbarXToSwap > 0) {
                            _swapHBARXToHBAR(hbarXToSwap);
                        }
                    }
                    
                    // Final check: ensure we don't try to repay more than we have
                    uint256 finalHbarBal = address(this).balance;
                    if(finalHbarBal < debtForThisLayer) {
                        debtForThisLayer = finalHbarBal;
                    }
                    
                    // Repay debt with HBAR if we have enough
                    if (debtForThisLayer > 0) {
                        try ILendingPool(lendingPool).repay{value: debtForThisLayer}(borrowToken, debtForThisLayer, 2, address(this)) {
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
    function _convertHbarToHbarX(uint256 hbarAmount) internal view returns (uint256) {
        // Convert HBAR amount to equivalent HBARX amount using exchange rate
        // exchangeRate is HBAR/1 HBARX in 8 decimals
        uint256 exchangeRate = IStaking(stakingContract).getExchangeRate();
        return (hbarAmount * 1e8) / exchangeRate;
    }

    function _completePositionExit() internal {
        uint256 totalDebt = IERC20(debtToken).balanceOf(address(this));
        uint256 totalRepaid;

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

            // Get current HBAR balance and convert HBARX to HBAR if needed
            uint256 currentHbarBal = address(this).balance;
            if (currentHbarBal < totalDebt) {
                uint256 hbarShortfall = totalDebt - currentHbarBal;
                uint256 hbarXBal = IERC20(want).balanceOf(address(this));
                
                if (hbarXBal > 0) {
                    // Use DEX quote for more accurate conversion
                    uint256 hbarXToSwap = _getDexQuoteForHbarAmount(hbarShortfall);
                    if (hbarXToSwap > hbarXBal) {
                        hbarXToSwap = hbarXBal;
                    }
                    if (hbarXToSwap > 0) {
                        _swapHBARXToHBAR(hbarXToSwap);
                    }
                }
            }

            // Repay as much debt as possible
            uint256 hbarBalance = address(this).balance;
            uint256 toRepay = hbarBalance > totalDebt ? totalDebt : hbarBalance;

            if (toRepay > 0) {
                try ILendingPool(lendingPool).repay{value: toRepay}(borrowToken, toRepay, 2, address(this)) {
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

    function _getDexQuoteForHbarAmount(uint256 hbarAmount) internal view returns (uint256) {
        if (hbarAmount == 0) return 0;
        
        // Use staking contract exchange rate with buffer for safety
        uint256 hbarXAmount = _convertHbarToHbarX(hbarAmount);
        // Add slippage buffer for safety
        return hbarXAmount + (hbarXAmount * slippageTolerance) / 10000;
    }

    function _swapHBARXToHBAR(uint256 amount) internal returns (uint256) {
        require(amount > 0, "Amount must be greater than 0");
        uint256 balanceBefore = address(this).balance;
        
        // Get expected output using staking contract exchange rate for validation
        uint256 exchangeRate = IStaking(stakingContract).getExchangeRate();
        uint256 expectedOut = (amount * exchangeRate) / 1e8;
        
        // Calculate minimum output with slippage tolerance
        uint256 minAmountOut = expectedOut * (10000 - slippageTolerance) / 10000;
        
        // Create swap path for HBARX to HBAR (via WHBAR if needed)
        address[] memory swapRoute = new address[](2);
        swapRoute[0] = want; // HBARX
        swapRoute[1] = borrowToken; // HBAR (WHBAR)
        
        uint24[] memory swapFees = new uint24[](1);
        swapFees[0] = poolFee;
        
        bytes memory path = UniswapV3Utils.routeToPath(swapRoute, swapFees);
        
        // Approve router to spend HBARX
        IERC20(want).approve(saucerSwapRouter, amount);
        
        IUniswapRouterV3WithDeadline.ExactInputParams memory params = IUniswapRouterV3WithDeadline.ExactInputParams({
            path: path,
            recipient: address(this),
            deadline: block.timestamp + 300, // 5 minute deadline
            amountIn: amount,
            amountOutMinimum: minAmountOut
        });
        
        uint256 amountOut;
        try IUniswapRouterV3WithDeadline(saucerSwapRouter).exactInput(params) returns (uint256 _amountOut) {
            amountOut = _amountOut;
        } catch {
            // If swap fails, revert with descriptive error
            revert("HBARX to WHBAR swap failed");
        }
        
        // Unwrap WHBAR to HBAR
        if (amountOut > 0) {
            IERC20(borrowToken).approve(whbarContract, amountOut);
            try IWHBAR(whbarContract).withdraw(address(this), address(this), amountOut) {
            } catch {
                // If unwrap fails, still return the WHBAR amount
                emit SwappedHBARXToHBAR(amount, 0);
                return amountOut;
            }
        }
        
        uint256 balanceAfter = address(this).balance;
        uint256 received = balanceAfter - balanceBefore;
        
        emit SwappedHBARXToHBAR(amount, received);
        require(received > 0 || amountOut > 0, "No HBAR received from swap");
        
        return received > 0 ? received : amountOut;
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
            address[] memory assets = new address[](1);
            assets[0] = aToken;
            IRewardsController(rewardsController).claimRewards(assets, type(uint256).max, address(this), want);
        }

        uint256 wantHarvested = balanceOfWant();
        if (wantHarvested > 0 && wantHarvested >= 3*10**8) {
            chargeFees(callFeeRecipient);
            deposit();
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
        return balanceOfWant() + balanceOfPool();
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
        if (tx.origin != owner() && !paused()) {
            uint256 withdrawalFeeAmount = (wantBal * withdrawalFee) / WITHDRAWAL_MAX;
            wantBal = wantBal - withdrawalFeeAmount;
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
    function getMaxLoops() external view returns (uint256) {
        return maxLoops;
    }

    function setMaxLoops(uint256 _maxLoops) external onlyManager {
        require(_maxLoops > 0 && _maxLoops <= 10, "!range"); // Reasonable range: 1-10x
        maxLoops = _maxLoops;
        emit MaxLoopsUpdated(maxLoops, _maxLoops);
    }

    function setWhbarContract(address _whbarContract) external onlyManager {
        whbarContract = _whbarContract;
    }

    function setSaucerSwapRouter(address _saucerSwapRouter) external onlyManager {
        require(_saucerSwapRouter != address(0), "Router cannot be zero address");
        saucerSwapRouter = _saucerSwapRouter;
    }

    function setQuoterAddress(address _quoterAddress) external onlyManager {
        quoterAddress = _quoterAddress;
    }

    function getSaucerSwapRouter() external view returns (address) {
        return saucerSwapRouter;
    }

    function getSwapQuote(uint256 amountIn) external view returns (uint256 amountOut) {
        require(amountIn > 0, "Amount must be greater than 0");
        
        // Use staking contract exchange rate for quote
        uint256 exchangeRate = IStaking(stakingContract).getExchangeRate();
        return (amountIn * exchangeRate) / 1e8;
    }

    function getMaxBorrowable() external view returns (uint256) {
        return maxBorrowable;
    }

    function setMaxBorrowable(uint256 _maxBorrowable) external onlyManager {
        require(_maxBorrowable <= 10000, "!cap"); // Cannot be more than 100%
        maxBorrowable = _maxBorrowable;
        emit MaxBorrowableUpdated(maxBorrowable, _maxBorrowable);
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

    function inCaseNativeTokensGetStuck() external onlyManager {
        uint256 amount = address(this).balance;
        if (amount > 0) {
            payable(msg.sender).transfer(amount);
        }
    }

    receive() external payable {}
}

