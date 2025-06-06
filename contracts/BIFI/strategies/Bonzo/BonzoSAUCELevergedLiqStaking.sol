// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin-4/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin-4/contracts/security/Pausable.sol";
import "@openzeppelin-4/contracts/security/ReentrancyGuard.sol";
import "../../interfaces/bonzo/ILendingPool.sol";
import "../../interfaces/bonzo/IRewardsController.sol";
import "../Common/StratFeeManagerInitializable.sol";
import "../../utils/GasFeeThrottler.sol";
import "../../interfaces/beefy/IStrategyV7.sol";
import "../../interfaces/common/IFeeConfig.sol";
import "./SaucerSwap/ISaucerSwapMothership.sol";

contract BonzoSAUCELevergedLiqStaking is StratFeeManagerInitializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Tokens used
    address public want; // xSAUCE token
    address public borrowToken; // SAUCE token
    address public aToken; // axSAUCE token
    address public debtToken; // debtSAUCE token
    address public stakingPool; // Staking pool for xSAUCE

    // Third party contracts
    address public lendingPool;
    address public rewardsController;

    // Leverage parameters
    uint256 public maxLeverage; // Maximum leverage ratio example 3 for 3x 
    uint256 public currentLeverage; // Current leverage ratio
    uint256 public maxBorrowable; // Maximum borrowable amount (e.g., 8000 for 80%)
    uint256 public slippageTolerance; // Slippage tolerance in basis points (e.g., 50 for 0.5%)

    bool public harvestOnDeposit;
    uint256 public lastHarvest;
    bool public isRewardsAvailable;

    // Events
    event StratHarvest(address indexed harvester, uint256 wantHarvested, uint256 tvl);
    event Deposit(uint256 tvl);
    event Withdraw(uint256 tvl);
    event ChargedFees(uint256 callFees, uint256 beefyFees, uint256 strategistFees);
    event Staked(uint256 amount);
    event Unstaked(uint256 amount);
    event SlippageToleranceUpdated(uint256 oldValue, uint256 newValue);

    function initialize(
        address _want,
        address _borrowToken,
        address _aToken,
        address _debtToken,
        address _lendingPool,
        address _rewardsController,
        address _stakingPool,
        uint256 _maxBorrowable,
        uint256 _maxLeverage,
        uint256 _slippageTolerance,
        bool _isRewardsAvailable,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        __StratFeeManager_init(_commonAddresses);
        __Ownable_init();
        __Pausable_init();
        
        want = _want; // xSAUCE
        borrowToken = _borrowToken; // SAUCE
        aToken = _aToken; // axSAUCE
        debtToken = _debtToken; // debtSAUCE
        lendingPool = _lendingPool;
        rewardsController = _rewardsController;
        stakingPool = _stakingPool;
        maxBorrowable = _maxBorrowable;
        maxLeverage = _maxLeverage;
        slippageTolerance = _slippageTolerance;
        isRewardsAvailable = _isRewardsAvailable;
        currentLeverage = maxLeverage;

        _giveAllowances();
    }

    function _giveAllowances() internal {
        IERC20(want).safeApprove(lendingPool, type(uint256).max);
        IERC20(borrowToken).safeApprove(lendingPool, type(uint256).max);
        IERC20(borrowToken).safeApprove(stakingPool, type(uint256).max);
    }

    function _removeAllowances() internal {
        IERC20(want).safeApprove(lendingPool, 0);
        IERC20(borrowToken).safeApprove(lendingPool, 0);
        IERC20(borrowToken).safeApprove(stakingPool, 0);
    }

    function deposit() public whenNotPaused nonReentrant {
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > 0) {
            _leveragePosition(wantBal);
        }
    }

    function _leveragePosition(uint256 amount) internal {
        // Initial deposit of xSAUCE
        ILendingPool(lendingPool).deposit(want, amount, address(this), 0);
        
        uint256 currentCollateral = amount;
        
        // Loop for maxLeverage times
        for (uint256 i = 0; i < maxLeverage; i++) {
            // Calculate how much we can borrow with current collateral
            uint256 borrowableAmount = (currentCollateral * maxBorrowable) / 10000;
            
            // Borrow SAUCE
            ILendingPool(lendingPool).borrow(borrowToken, borrowableAmount, 2, 0, address(this));
            
            // Calculate expected xSAUCE amount before entering
            uint256 expectedXSauce = ISaucerSwapMothership(stakingPool).sauceForxSauce(borrowableAmount);
            uint256 minXSauce = expectedXSauce * (10000 - slippageTolerance) / 10000;
            
            // Convert borrowed SAUCE to xSAUCE through staking
            uint256 xSauceAmount = _enter(borrowableAmount);
            require(xSauceAmount >= minXSauce, "Slippage too high");
            
            // Deposit xSAUCE
            ILendingPool(lendingPool).deposit(want, xSauceAmount, address(this), 0);
            
            // Update our position
            currentCollateral += xSauceAmount;
        }

        emit Deposit(balanceOf());
    }

    function _enter(uint256 amount) internal returns (uint256) {
        // Enter the bar by sending SAUCE to get xSAUCE
        ISaucerSwapMothership(stakingPool).enter(amount);
        emit Staked(amount);
        return amount;
    }

    function _leave(uint256 amount) internal returns (uint256) {
        // Calculate expected SAUCE amount before leaving
        uint256 expectedSauce = ISaucerSwapMothership(stakingPool).xSauceForSauce(amount);
        uint256 minSauce = expectedSauce * (10000 - slippageTolerance) / 10000;
        
        // Leave the bar by sending xSAUCE to get SAUCE
        ISaucerSwapMothership(stakingPool).leave(amount);
        emit Unstaked(amount);
        
        // Verify we received at least the expected amount minus slippage
        uint256 receivedSauce = IERC20(borrowToken).balanceOf(address(this));
        require(receivedSauce >= minSauce, "Slippage too high");
        
        return receivedSauce;
    }

    function _unwindLeverage(uint256 amount) internal {
        uint256 layerAmount = amount / maxLeverage;
        
        for (uint256 i = 0; i < maxLeverage; i++) {
            // Withdraw from lending pool
            ILendingPool(lendingPool).withdraw(want, layerAmount, address(this));
            
            // If not the last layer, repay debt
            if (i < maxLeverage - 1) {
                uint256 debtAmount = IERC20(debtToken).balanceOf(address(this));
                // Calculate expected SAUCE amount before leaving
                uint256 expectedSauce = ISaucerSwapMothership(stakingPool).xSauceForSauce(debtAmount);
                uint256 minSauce = expectedSauce * (10000 - slippageTolerance) / 10000;
                require(minSauce >= debtAmount, "Insufficient SAUCE for debt repayment");
                
                // Convert xSAUCE to SAUCE for repayment
                uint256 sauceAmount = _leave(debtAmount);
                ILendingPool(lendingPool).repay(borrowToken, sauceAmount, 2, address(this));
            }
        }
    }

    function harvest() external whenNotPaused nonReentrant {
        require(msg.sender == vault || msg.sender == owner() || msg.sender == keeper, "!authorized");
        
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
            uint256 callFeeAmount = wantBal * fees.call / 1e18;
            uint256 beefyFeeAmount = wantBal * fees.beefy / 1e18;
            uint256 strategistFeeAmount = wantBal * fees.strategist / 1e18;

            IERC20(want).safeTransfer(msg.sender, callFeeAmount);
            IERC20(want).safeTransfer(beefyFeeRecipient, beefyFeeAmount);
            IERC20(want).safeTransfer(strategist, strategistFeeAmount);

            emit ChargedFees(callFeeAmount, beefyFeeAmount, strategistFeeAmount);
        }
    }

    function balanceOf() public view returns (uint256) {
        return balanceOfWant() + balanceOfPool() + _getStakedBalance();
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
    }

    function setRewardsAvailable(bool _isRewardsAvailable) external onlyManager {
        isRewardsAvailable = _isRewardsAvailable;
    }

    function panic() external onlyManager {
        _pause();
        _removeAllowances();
    }

    function pause() external onlyManager {
        _pause();
        _removeAllowances();
    }

    function unpause() external onlyManager {
        _unpause();
        _giveAllowances();
    }

    function retireStrat() external {
        require(msg.sender == vault, "!vault");
        
        uint256 totalPosition = balanceOf();
        if (totalPosition > 0) {
            _unwindLeverage(totalPosition);
        }

        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > 0) {
            IERC20(want).safeTransfer(vault, wantBal);
        }

        _removeAllowances();
    }

    function inCaseTokensGetStuck(address _token) external onlyManager {
        require(_token != want, "!want");
        require(_token != borrowToken, "!borrowToken");
        require(_token != aToken, "!aToken");
        require(_token != debtToken, "!debtToken");

        uint256 amount = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(msg.sender, amount);
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
    function getCurrentLeverage() external view returns (uint256) {
        return currentLeverage;
    }

    function getMaxLeverage() external view returns (uint256) {
        return maxLeverage;
    }

    function getMaxBorrowable() external view returns (uint256) {
        return maxBorrowable;
    }

    function setMaxBorrowable(uint256 _maxBorrowable) external onlyManager {
        require(_maxBorrowable <= 10000, "!cap"); // Cannot be more than 100%
        maxBorrowable = _maxBorrowable;
    }

    function setMaxLeverage(uint256 _maxLeverage) external onlyManager {
        require(_maxLeverage > 0 && _maxLeverage <= 10, "!range"); // Reasonable range: 1-10x
        maxLeverage = _maxLeverage;
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

        uint256 totalPosition = balanceOf();
        require(_amount <= totalPosition, "Withdraw amount too large");

        // Calculate how much to withdraw from each layer
        uint256 layerAmount = _amount / maxLeverage;
        
        // Unwind leverage position
        _unwindLeverage(_amount);

        // Get the actual amount of want tokens we have
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > _amount) {
            wantBal = _amount;
        }

        // Apply withdrawal fee if not owner and not paused
        if (tx.origin != owner() && !paused()) {
            uint256 withdrawalFeeAmount = wantBal * withdrawalFee / WITHDRAWAL_MAX;
            wantBal = wantBal - withdrawalFeeAmount;
        }

        // Transfer want tokens to vault
        IERC20(want).safeTransfer(vault, wantBal);
        
        emit Withdraw(balanceOf());
    }



}

