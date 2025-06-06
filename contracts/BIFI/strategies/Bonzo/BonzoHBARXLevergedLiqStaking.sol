// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin-4/contracts/token/ERC20/IERC20.sol";
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

contract BonzoHBARXLevergedLiqStaking is StratFeeManagerInitializable {
    using SafeERC20 for IERC20;

    // Hedera Token Service constants
    address constant HTS_PRECOMPILE = address(0x167);
    int64 constant HTS_SUCCESS = 22;
    int64 constant PRECOMPILE_BIND_ERROR = -1;

    // Tokens used
    address public want; // HBARX token
    address public borrowToken; // HBAR token
    address public aToken; // aHBARX token
    address public debtToken; // debtHBAR token

    // Third party contracts
    address public lendingPool;
    address public rewardsController;
    address public stakingContract; // HBAR staking contract

    // Exchange rate tracking
    uint256 public hbarToHbarxRate; // Rate of HBAR to HBARX (e.g., 1000 means 1 HBAR = 1.000 HBARX)
    uint256 public constant RATE_PRECISION = 1e6; // 6 decimal precision for rates

    // Leverage parameters
    uint256 public maxLeverage; // Maximum leverage ratio (e.g., 300 for 3x)
    uint256 public currentLeverage; // Current leverage ratio
    uint256 public borrowAPY; // Current borrow APY
    uint256 public stakingAPY; // Current staking APY
    uint256 public supplyAPY; // Current supply APY from lending pool
    uint256 public minAPYSpread; // Minimum spread between staking and borrow APY
    uint256 public maxLTV; // Maximum Loan-to-Value ratio (e.g., 8000 for 80%)

    bool public harvestOnDeposit;
    uint256 public lastHarvest;
    bool public isRewardsAvailable;

    // Events
    event StratHarvest(address indexed harvester, uint256 wantHarvested, uint256 tvl);
    event Deposit(uint256 tvl);
    event Withdraw(uint256 tvl);
    event ChargedFees(uint256 callFees, uint256 beefyFees, uint256 strategistFees);
    event LeverageUpdated(uint256 oldLeverage, uint256 newLeverage);
    event APYUpdated(uint256 borrowAPY, uint256 stakingAPY, uint256 supplyAPY);

    function updateExchangeRate() public {
        // Get current exchange rate from Stader
        uint256 hbarAmount = 1e18; // 1 HBAR
        uint256 hbarxBefore = IERC20(want).balanceOf(address(this));
        IStaking(stakingContract).stake{value: hbarAmount}();
        uint256 hbarxAfter = IERC20(want).balanceOf(address(this));
        uint256 hbarxReceived = hbarxAfter - hbarxBefore;
        hbarToHbarxRate = (hbarxReceived * RATE_PRECISION) / hbarAmount;
        
        // Unstake immediately to get HBAR back
        IStaking(stakingContract).unStake(hbarxReceived);
    }

    function initialize(
        address _want,
        address _borrowToken,
        address _aToken,
        address _debtToken,
        address _lendingPool,
        address _rewardsController,
        address _stakingContract,
        uint256 _maxLeverage,
        uint256 _minAPYSpread,
        uint256 _maxLTV,
        bool _isRewardsAvailable,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        __StratFeeManager_init(_commonAddresses);
        __Ownable_init();
        __Pausable_init();
        
        want = _want;
        borrowToken = _borrowToken;
        aToken = _aToken;
        debtToken = _debtToken;
        lendingPool = _lendingPool;
        rewardsController = _rewardsController;
        stakingContract = _stakingContract;
        maxLeverage = _maxLeverage;
        minAPYSpread = _minAPYSpread;
        maxLTV = _maxLTV;
        isRewardsAvailable = _isRewardsAvailable;

        // Initialize exchange rate
        updateExchangeRate();

        _associateToken(_want);
        _associateToken(_borrowToken);

        _giveAllowances();
    }

    function _associateToken(address token) internal {
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        require(responseCode == HTS_SUCCESS, "HTS token association failed");
    }

    function deposit() public whenNotPaused {
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > 0) {
            _leveragePosition(wantBal);
        }
    }

    function _leveragePosition(uint256 amount) internal {
        // Calculate optimal leverage based on APY spread
        uint256 optimalLeverage = _calculateOptimalLeverage();
        currentLeverage = optimalLeverage > maxLeverage ? maxLeverage : optimalLeverage;

        // Initial deposit
        ILendingPool(lendingPool).deposit(want, amount, address(this), 0);
        
        // Calculate target total borrowed amount
        uint256 targetBorrowed = (amount * currentLeverage * RATE_PRECISION) / (100 * hbarToHbarxRate);
        uint256 currentBorrowed = 0;
        uint256 currentCollateral = amount;
        
        // Keep borrowing until we reach target or can't borrow more
        while (currentBorrowed < targetBorrowed) {
            // Calculate how much we can borrow with current collateral
            uint256 collateralInHbar = (currentCollateral * RATE_PRECISION) / hbarToHbarxRate;
            uint256 borrowableAmount = (collateralInHbar * maxLTV) / 10000;
            
            // Calculate how much more we need to borrow
            uint256 remainingBorrow = targetBorrowed - currentBorrowed;
            
            // Borrow the smaller of the two amounts
            uint256 borrowAmount = borrowableAmount < remainingBorrow ? borrowableAmount : remainingBorrow;
            
            if (borrowAmount == 0) break; // Can't borrow more
            
            ILendingPool(lendingPool).borrow(borrowToken, borrowAmount, 2, 0, address(this));
            
            // Stake HBAR for HBARX
            _stakeHBAR(borrowAmount);
            
            // Deposit HBARX
            uint256 hbarxAmount = IERC20(want).balanceOf(address(this));
            ILendingPool(lendingPool).deposit(want, hbarxAmount, address(this), 0);
            
            // Update our position
            currentBorrowed += borrowAmount;
            currentCollateral += hbarxAmount;
        }

        emit Deposit(balanceOf());
    }

    function _calculateOptimalLeverage() internal view returns (uint256) {
        // Calculate optimal leverage based on total APY spread
        uint256 totalAPY = stakingAPY + supplyAPY;
        if (totalAPY <= borrowAPY) return 1;
        
        uint256 spread = totalAPY - borrowAPY;
        if (spread < minAPYSpread) return 1;
        
        // Calculate leverage based on APY spread
        uint256 apyBasedLeverage = (spread * 100) / borrowAPY;
        
        // Calculate maximum leverage based on LTV
        // If maxLTV is 8000 (80%), we can borrow up to 4x our collateral
        // because 80% LTV means we can borrow 0.8x per iteration
        uint256 ltvBasedLeverage = (maxLTV * 100) / (10000 - maxLTV);
        
        // Return the lower of the two leverages
        return apyBasedLeverage < ltvBasedLeverage ? apyBasedLeverage : ltvBasedLeverage;
    }

    function _stakeHBAR(uint256 amount) internal {
        // Call Stader's Staking contract to stake HBAR
        IStaking(stakingContract).stake{value: amount}();
        
        // Verify HBARX tokens were received
        uint256 hbarxReceived = IERC20(want).balanceOf(address(this));
        require(hbarxReceived > 0, "No HBARX received from staking");
        
        // Update exchange rate
        hbarToHbarxRate = (hbarxReceived * RATE_PRECISION) / amount;
    }

    function withdraw(uint256 _amount) external {
        require(msg.sender == vault, "!vault");

        // Calculate total position value
        uint256 totalPosition = balanceOf();
        require(_amount <= totalPosition, "Withdraw amount too large");

        // Unwind leverage
        _unwindLeverage(_amount);

        // Transfer to vault
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > _amount) {
            wantBal = _amount;
        }

        if (tx.origin != owner() && !paused()) {
            uint256 withdrawalFeeAmount = wantBal * withdrawalFee / WITHDRAWAL_MAX;
            wantBal = wantBal - withdrawalFeeAmount;
        }

        _safeTransfer(want, address(this), vault, wantBal);
        emit Withdraw(balanceOf());
    }

    function _unwindLeverage(uint256 amount) internal {
        // Calculate how much to withdraw from each layer
        uint256 layerAmount = amount / currentLeverage;
        
        for (uint256 i = 0; i < currentLeverage; i++) {
            // Withdraw from lending pool
            ILendingPool(lendingPool).withdraw(want, layerAmount, address(this));
            
            // Unstake HBARX to get HBAR back
            if (layerAmount > 0) {
                uint256 hbarReceived = IStaking(stakingContract).unStake(layerAmount);
                require(hbarReceived > 0, "No HBAR received from unstaking");
            }
            
            // If not the last layer, repay debt
            if (i < currentLeverage - 1) {
                uint256 debtAmount = IERC20(debtToken).balanceOf(address(this));
                ILendingPool(lendingPool).repay(borrowToken, debtAmount, 2, address(this));
            }
        }
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

    function balanceOf() public view returns (uint256) {
        return balanceOfWant() + balanceOfPool();
    }

    function balanceOfWant() public view returns (uint256) {
        return IERC20(want).balanceOf(address(this));
    }

    function balanceOfPool() public view returns (uint256) {
        return IERC20(aToken).balanceOf(address(this));
    }

    function setMaxLeverage(uint256 _maxLeverage) external onlyManager {
        require(_maxLeverage > 0, "Invalid leverage");
        uint256 oldLeverage = maxLeverage;
        maxLeverage = _maxLeverage;
        emit LeverageUpdated(oldLeverage, _maxLeverage);
    }

    function setHarvestOnDeposit(bool _harvestOnDeposit) external onlyManager {
        harvestOnDeposit = _harvestOnDeposit;
    }

    function setMinAPYSpread(uint256 _minAPYSpread) external onlyManager {
        minAPYSpread = _minAPYSpread;
    }

    function setAPYs(uint256 _borrowAPY, uint256 _stakingAPY, uint256 _supplyAPY) external onlyManager {
        borrowAPY = _borrowAPY;
        stakingAPY = _stakingAPY;
        supplyAPY = _supplyAPY;
        emit APYUpdated(_borrowAPY, _stakingAPY, _supplyAPY);
    }

    function setMaxLTV(uint256 _maxLTV) external onlyManager {
        require(_maxLTV > 0 && _maxLTV < 10000, "Invalid LTV");
        maxLTV = _maxLTV;
    }

    function harvest() external whenNotPaused {
        require(msg.sender == vault || msg.sender == owner() || msg.sender == keeper, "!authorized");
        
        // Claim rewards from rewards controller if available
        if (isRewardsAvailable) {
            address[] memory assets = new address[](1);
            assets[0] = aToken;
            IRewardsController(rewardsController).claimRewards(assets, type(uint256).max, address(this), want);
        }

        uint256 wantHarvested = balanceOfWant();
        if (wantHarvested > 0) {
            chargeFees();
            deposit();
        }

        // Check if rebalancing is needed based on APY spread
        uint256 optimalLeverage = _calculateOptimalLeverage();
        if (optimalLeverage != currentLeverage) {
            // Unwind current position
            uint256 totalPosition = balanceOf();
            if (totalPosition > 0) {
                _unwindLeverage(totalPosition);
            }
            // Rebalance with new leverage
            uint256 wantBal = IERC20(want).balanceOf(address(this));
            if (wantBal > 0) {
                _leveragePosition(wantBal);
            }
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

            _safeTransfer(want, address(this), msg.sender, callFeeAmount);
            _safeTransfer(want, address(this), beefyFeeRecipient, beefyFeeAmount);
            _safeTransfer(want, address(this), strategist, strategistFeeAmount);

            emit ChargedFees(callFeeAmount, beefyFeeAmount, strategistFeeAmount);
        }
    }

    function _giveAllowances() internal {
        IERC20(want).safeApprove(lendingPool, type(uint256).max);
        IERC20(borrowToken).safeApprove(lendingPool, type(uint256).max);
    }

    function _removeAllowances() internal {
        IERC20(want).safeApprove(lendingPool, 0);
        IERC20(borrowToken).safeApprove(lendingPool, 0);
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
        
        // Unwind all positions
        uint256 totalPosition = balanceOf();
        if (totalPosition > 0) {
            _unwindLeverage(totalPosition);
        }

        // Transfer all want tokens to vault
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        if (wantBal > 0) {
            _safeTransfer(want, address(this), vault, wantBal);
        }

        _removeAllowances();
    }

    function inCaseTokensGetStuck(address _token) external onlyManager {
        require(_token != want && _token != borrowToken && _token != aToken && _token != debtToken, "!protected");
        
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

    function setRewardsAvailable(bool _isRewardsAvailable) external onlyManager {
        isRewardsAvailable = _isRewardsAvailable;
    }
}

