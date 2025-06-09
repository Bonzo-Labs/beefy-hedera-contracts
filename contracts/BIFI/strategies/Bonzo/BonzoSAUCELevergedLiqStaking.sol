// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin-4/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin-4/contracts/security/Pausable.sol";
import "@openzeppelin-4/contracts/security/ReentrancyGuard.sol";
import "../../interfaces/bonzo/ILendingPool.sol";
import "../../interfaces/bonzo/IRewardsController.sol";
import "../Common/StratFeeManagerInitializable.sol";
import "../../interfaces/common/IFeeConfig.sol";
import "./SaucerSwap/ISaucerSwapMothership.sol";
import "../../Hedera/IHederaTokenService.sol";

contract BonzoSAUCELevergedLiqStaking is StratFeeManagerInitializable, ReentrancyGuard {
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

    // Third party contracts
    address public lendingPool;
    address public rewardsController;

    // Yield loop parameters
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
        uint256 _slippageTolerance,
        bool _isRewardsAvailable,
        bool _isBonzoDeployer,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        __StratFeeManager_init(_commonAddresses);
        __Ownable_init();
        __Pausable_init();
        
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
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        require(responseCode == HTS_SUCCESS, "HTS token association failed");
    }

    function _safeTransfer(address token, address from, address to, uint256 amount) internal {
        _transferHTS(token, from, to, int64(uint64(amount)));
    }

    function _transferHTS(address token, address from, address to, int64 amount) internal {
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.transferToken.selector, token, from, to, amount)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        require(responseCode == HTS_SUCCESS, "HTS token transfer failed");
    }

    function _removeAllowances() internal {
        IERC20(want).approve(lendingPool, 0);
        IERC20(borrowToken).approve(lendingPool, 0);
        IERC20(borrowToken).approve(stakingPool, 0);
    }

    function deposit() public whenNotPaused nonReentrant {
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > 0) {
            _createYieldLoops(wantBal);
        }
    }

    function _createYieldLoops(uint256 amount) internal {
        // Initial deposit of xSAUCE
        ILendingPool(lendingPool).deposit(want, amount, address(this), 0);
        
        uint256 currentCollateral = amount;
        uint256 totalBorrowed = 0;
        
        
        // Loop for maxLoops times
        for (uint256 i = 0; i < maxLoops; i++) {
            // Calculate initial borrow amount based on maxBorrowable
            uint256 borrowableAmount = (currentCollateral * maxBorrowable) / 10000;
            
            // Get current position data before borrow
            (uint256 currentCollateralBase, uint256 currentDebtBase,,,uint256 currentLtv,) = ILendingPool(lendingPool).getUserAccountData(address(this));
            
            // Calculate maximum borrow amount in base currency that keeps us under LTV
            uint256 maxBorrowBase = (currentCollateralBase * currentLtv / 10000) - currentDebtBase;
            
            // Convert maxBorrowBase to borrow token amount
            uint256 maxBorrowToken = maxBorrowBase;
            
            // Use the smaller of the two amounts
            if (borrowableAmount > maxBorrowToken) {
                borrowableAmount = maxBorrowToken;
            }
            
            // If we can't borrow more, stop
            if (borrowableAmount == 0) break;
            
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
            totalBorrowed += borrowableAmount;
        }

        emit Deposit(currentCollateral, totalBorrowed);
    }

    function _enter(uint256 amount) internal returns (uint256) {
        uint256 balanceBefore = IERC20(want).balanceOf(address(this));
        ISaucerSwapMothership(stakingPool).enter(amount);
        uint256 balanceAfter = IERC20(want).balanceOf(address(this));
        uint256 received = balanceAfter - balanceBefore;
        emit Staked(received);
        return received;
    }

    function _leave(uint256 amount) internal returns (uint256) {
        // Calculate expected SAUCE amount before leaving
        uint256 expectedSauce = ISaucerSwapMothership(stakingPool).xSauceForSauce(amount);
        uint256 minSauce = expectedSauce * (10000 - slippageTolerance) / 10000;
        
        // Leave the bar by sending xSAUCE to get SAUCE
        uint256 balanceBefore = IERC20(borrowToken).balanceOf(address(this));
        ISaucerSwapMothership(stakingPool).leave(amount);
        uint256 balanceAft = IERC20(borrowToken).balanceOf(address(this));
        
        // Verify we received at least the expected amount minus slippage
        uint256 receivedSauce = balanceAft - balanceBefore;
        require(receivedSauce >= minSauce, "Slippage too high");

        emit Unstaked(receivedSauce);
        return receivedSauce;
    }

    function _unwindYieldLoops(uint256 amount) internal {
        uint256 layerAmount = amount / maxLoops;
        
        for (uint256 i = 0; i < maxLoops; i++) {
            // Withdraw from lending pool
            ILendingPool(lendingPool).withdraw(want, layerAmount, address(this));
            
            // If not the last layer, repay debt
            if (i < maxLoops - 1) {
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
            uint256 strategistFeeAmount = isBonzoDeployer ? 0 : wantBal * fees.strategist / 1e18;

            _safeTransfer(want, address(this), msg.sender, callFeeAmount);
            _safeTransfer(want, address(this), beefyFeeRecipient, beefyFeeAmount);
            if (strategistFeeAmount > 0) {
                _safeTransfer(want, address(this), strategist, strategistFeeAmount);
            }

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

        _removeAllowances();
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
    }

    function getMaxBorrowable() external view returns (uint256) {
        return maxBorrowable;
    }

    function setMaxBorrowable(uint256 _maxBorrowable) external onlyManager {
        require(_maxBorrowable <= 10000, "!cap"); // Cannot be more than 100%
        maxBorrowable = _maxBorrowable;
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

        // Unwind yield loops
        _unwindYieldLoops(_amount);

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
        _safeTransfer(want, address(this), vault, wantBal);
        
        emit Withdraw(wantBal);
    }
}

