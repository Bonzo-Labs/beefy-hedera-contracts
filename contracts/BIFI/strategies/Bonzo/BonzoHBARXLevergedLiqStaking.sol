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
    address public whbarContract = 0x0000000000000000000000000000000000163B59;
    // address public whbarContract = 0x0000000000000000000000000000000000003aD1;

    // Third party contracts
    address public lendingPool;
    address public rewardsController;
    address public saucerSwapRouter; // SaucerSwap router for HBARX to HBAR swaps
    uint24 public poolFee = 1500; // Default pool fee (0.15%)

    // Yield loop parameters
    uint256 public maxLoops = 2; // Maximum number of yield loops (e.g., 3 for 3x)
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

        // Initial deposit
        ILendingPool(lendingPool).deposit(want, amount, address(this), 0);
        uint256 currentCollateral = amount;
        uint256 totalBorrowed = 0;

        for (uint256 i = 0; i < maxLoops; i++) {
            // [1] get user data (all in 18-dec base units)
            (uint256 baseCollateral, uint256 baseDebt, , , uint256 currentLtv, ) = ILendingPool(lendingPool)
                .getUserAccountData(address(this));

            // [2] compute max borrow in token-decimals
            uint256 maxBorrowToken = ((baseCollateral * currentLtv) / 10_000) - baseDebt;
            if (maxBorrowToken == 0)
                revert MaxBorrowTokenIsZero(baseCollateral, baseDebt, currentLtv);

            // [3] limit by your own desired factor
            uint256 desired = (currentCollateral * maxBorrowable) / 10_000;
            emit DebugValues(baseCollateral, baseDebt, currentLtv, maxBorrowToken, desired);


            uint256 borrowAmt = desired < maxBorrowToken ? desired : maxBorrowToken;
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

    function _unwindYieldLoops(uint256 amount) internal {
        require(amount > 0, "Amount must be greater than 0");
        uint256 totalPosition = balanceOf();
        require(amount <= totalPosition, "Amount exceeds total position");

        // Calculate proportional amounts for each layer
        uint256 layerAmount = amount / maxLoops;
        uint256 totalDebt = IERC20(debtToken).balanceOf(address(this));
        // IERC20(borrowToken).approve(lendingPool, totalDebt);
        // IERC20(want).approve(stakingContract, amount);

        // Calculate debt amount proportional to withdrawal amount
        uint256 layerDebt = (totalDebt * amount) / totalPosition / maxLoops;
        uint256 debtPaid = 0;

        for (uint256 i = 0; i < maxLoops; i++) {
            // Withdraw from lending pool
            ILendingPool(lendingPool).withdraw(want, layerAmount, address(this));
            uint256 debtBalance = IERC20(debtToken).balanceOf(address(this));
            if(debtBalance == 0) {
                break;
            }
            // For all layers except the last one, repay proportional debt
            uint256 requiredHbar = 0;
            if (i < maxLoops - 1) {
                // Convert HBARX to HBAR amount needed
                requiredHbar = _swapHBARXToHBAR(layerDebt);
                debtPaid += layerDebt;
            } else {
                // For the last layer, repay remaining debt
                uint256 remainingDebt = totalDebt - debtPaid;
                if (remainingDebt > 0) {
                    requiredHbar = _swapHBARXToHBAR(remainingDebt);
                }
            }
            if (requiredHbar > 0) {
                //get current debt amount if requiredhbar is greater than debt balance
                uint256 currentDebt = IERC20(debtToken).balanceOf(address(this));
                if(requiredHbar > currentDebt) {
                    requiredHbar = currentDebt;
                }
                ILendingPool(lendingPool).repay{value: requiredHbar}(borrowToken, requiredHbar, 2, address(this));
            }   
        }
    }

    function _swapHBARXToHBAR(uint256 amount) internal returns (uint256) {
        require(amount > 0, "Amount must be greater than 0");
        uint256 balanceBefore = address(this).balance;
        
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
            amountOutMinimum: 0
        });
        
        uint256 amountOut = IUniswapRouterV3WithDeadline(saucerSwapRouter).exactInput(params);
        //unwrap whbar to hbar
        IERC20(borrowToken).approve(whbarContract, amountOut);
        IWHBAR(whbarContract).withdraw(address(this), address(this), amountOut);
        uint256 balanceAfter = address(this).balance;
        uint256 received = balanceAfter - balanceBefore;
        
        emit SwappedHBARXToHBAR(amount, received);
        require(received > 0, "No HBAR received from swap");
        
        return amountOut;
    }

    function harvest(address callFeeRecipient) external whenNotPaused nonReentrant {
        require(callFeeRecipient != address(0), "Invalid fee recipient");
        if (isRewardsAvailable) {
            address[] memory assets = new address[](1);
            assets[0] = aToken;
            IRewardsController(rewardsController).claimRewards(assets, type(uint256).max, address(this), want);
        }

        uint256 wantHarvested = balanceOfWant();
        if (wantHarvested > 0) {
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

    function getSaucerSwapRouter() external view returns (address) {
        return saucerSwapRouter;
    }

    function getSwapQuote(uint256 amountIn) external view returns (uint256 amountOut) {
        require(amountIn > 0, "Amount must be greater than 0");
        
        // Create swap path for HBARX to HBAR
        address[] memory route = new address[](2);
        route[0] = want; // HBARX
        route[1] = borrowToken; // HBAR (WHBAR)
        
        uint24[] memory fees = new uint24[](1);
        fees[0] = poolFee;
        
        bytes memory path = UniswapV3Utils.routeToPath(route, fees);
        
        // Get quote from router
        uint256[] memory amounts = IUniswapRouterV3WithDeadline(saucerSwapRouter).getAmountsOut(amountIn, path);
        return amounts[amounts.length - 1];
    }

    function getMaxBorrowable() external view returns (uint256) {
        return maxBorrowable;
    }

    function setMaxBorrowable(uint256 _maxBorrowable) external onlyManager {
        require(_maxBorrowable <= 10000, "!cap"); // Cannot be more than 100%
        maxBorrowable = _maxBorrowable;
        emit MaxBorrowableUpdated(maxBorrowable, _maxBorrowable);
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

