// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin-4/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin-4/contracts/security/Pausable.sol";
import "../../interfaces/bonzo/ILendingPool.sol";
import "../../interfaces/bonzo/IRewardsController.sol";
import "../Common/StratFeeManagerInitializable.sol";
import "../../utils/GasFeeThrottler.sol";
import "../../Hedera/IHederaTokenService.sol";
import "../../interfaces/beefy/IStrategyV7.sol";

contract YieldLoop3x is StratFeeManagerInitializable {
    using SafeERC20 for IERC20;

    // Tokens used
    address public want; // Deposit token
    address public aToken; // Receipt token for supply
    address public debtToken; // Debt token for borrowing
    address public output; // Reward token

    // Third party contracts
    address public lendingPool;
    address public rewardsController;

    // Strategy settings
    uint256 public borrowFactor = 4000; // 40% in basis points (100% = 10000)
    uint256 public constant BORROW_FACTOR_MAX = 10000;

    // Hedera specific
    address private constant HTS_PRECOMPILE = address(0x167);
    int64 private constant HTS_SUCCESS = 22;
    int64 private constant PRECOMPILE_BIND_ERROR = -2;

    bool public harvestOnDeposit;
    uint256 public lastHarvest;
    bool public isHederaToken; // Flag to determine if tokens are Hedera tokens

    // Events
    event StratHarvest(address indexed harvester, uint256 wantHarvested, uint256 tvl);
    event Deposit(uint256 tvl);
    event Withdraw(uint256 tvl);
    event ChargedFees(uint256 callFees, uint256 beefyFees, uint256 strategistFees);
    event HTSTokenAssociated(address token, int64 responseCode);
    event HTSTokenDissociated(address token, int64 responseCode);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);
    event BorrowFactorUpdated(uint256 newBorrowFactor);

    function initialize(
        address _want,
        address _aToken,
        address _debtToken,
        address _lendingPool,
        address _rewardsController,
        address _output,
        bool _isHederaToken,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        __StratFeeManager_init(_commonAddresses);
        __Ownable_init();
        __Pausable_init();
        want = _want;
        aToken = _aToken;
        debtToken = _debtToken;
        lendingPool = _lendingPool;
        rewardsController = _rewardsController;
        output = _output;
        isHederaToken = _isHederaToken;

        if (isHederaToken) {
            // Associate HTS tokens
            _associateToken(_want);
            if (_want != _output) {
                _associateToken(_output);
            }
        }

        _giveAllowances();
    }

    function _associateToken(address token) internal {
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        require(responseCode == HTS_SUCCESS, "HTS token association failed");
        emit HTSTokenAssociated(token, responseCode);
    }

    function _safeTransfer(address token, address from, address to, uint256 amount) internal {
        if (isHederaToken) {
            _transferHTS(token, from, to, int64(uint64(amount)));
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function deposit() public whenNotPaused {
        uint256 wantBal = IERC20(want).balanceOf(address(this));

        if (wantBal > 0) {
            // Level 1: First supply
            if (isHederaToken) {
                _transferHTS(want, address(this), lendingPool, int64(uint64(wantBal)));
            }
            ILendingPool(lendingPool).deposit(want, wantBal, address(this), 0);

            // Level 1: First borrow (40% of initial deposit)
            uint256 firstBorrowAmount = (wantBal * borrowFactor) / BORROW_FACTOR_MAX;
            if (firstBorrowAmount > 0) {
                ILendingPool(lendingPool).borrow(want, firstBorrowAmount, 2, 0, address(this));

                // Level 2: Second supply (borrowed amount)
                uint256 secondSupplyAmount = IERC20(want).balanceOf(address(this));
                if (secondSupplyAmount > 0) {
                    if (isHederaToken) {
                        _transferHTS(want, address(this), lendingPool, int64(uint64(secondSupplyAmount)));
                    }
                    ILendingPool(lendingPool).deposit(want, secondSupplyAmount, address(this), 0);

                    // Level 2: Second borrow (40% of second supply)
                    uint256 secondBorrowAmount = (secondSupplyAmount * borrowFactor) / BORROW_FACTOR_MAX;
                    if (secondBorrowAmount > 0) {
                        ILendingPool(lendingPool).borrow(want, secondBorrowAmount, 2, 0, address(this));

                        // Level 3: Third supply (second borrowed amount)
                        uint256 thirdSupplyAmount = IERC20(want).balanceOf(address(this));
                        if (thirdSupplyAmount > 0) {
                            if (isHederaToken) {
                                _transferHTS(want, address(this), lendingPool, int64(uint64(thirdSupplyAmount)));
                            }
                            ILendingPool(lendingPool).deposit(want, thirdSupplyAmount, address(this), 0);
                        }
                    }
                }
            }

            emit Deposit(balanceOf());
        }
    }

    function withdraw(uint256 _amount) external {
        require(msg.sender == vault, "!vault");

        uint256 wantBal = IERC20(want).balanceOf(address(this));
        uint256 totalAssets = balanceOf();

        if (wantBal < _amount) {
            uint256 amountToWithdraw = _amount - wantBal;

            // Calculate what percentage of total assets we're withdrawing
            uint256 withdrawRatio = (amountToWithdraw * 1e18) / totalAssets;

            // Unwinding the 3-level leverage in reverse order

            // Step 1: Calculate and withdraw from third level supply (from second borrowing)
            uint256 thirdLevelSupply = calculateThirdLevelSupply();
            uint256 thirdLevelToWithdraw = (thirdLevelSupply * withdrawRatio) / 1e18;

            if (thirdLevelToWithdraw > 0) {
                ILendingPool(lendingPool).withdraw(want, thirdLevelToWithdraw, address(this));
            }

            // Step 2: Calculate and repay second level borrowing
            uint256 secondLevelDebt = calculateSecondLevelDebt();
            uint256 secondDebtToPay = (secondLevelDebt * withdrawRatio) / 1e18;

            if (secondDebtToPay > 0) {
                // Ensure we have enough tokens to repay
                uint256 currentWantBal = IERC20(want).balanceOf(address(this));
                if (currentWantBal < secondDebtToPay) {
                    // Need to withdraw more from first level supplies
                    ILendingPool(lendingPool).withdraw(want, secondDebtToPay - currentWantBal, address(this));
                }

                ILendingPool(lendingPool).repay(want, secondDebtToPay, 2, address(this));
            }

            // Step 3: Calculate and withdraw from second level supply (from first borrowing)
            uint256 secondLevelSupply = calculateSecondLevelSupply();
            uint256 secondLevelToWithdraw = (secondLevelSupply * withdrawRatio) / 1e18;

            if (secondLevelToWithdraw > 0) {
                ILendingPool(lendingPool).withdraw(want, secondLevelToWithdraw, address(this));
            }

            // Step 4: Calculate and repay first level borrowing
            uint256 firstLevelDebt = calculateFirstLevelDebt();
            uint256 firstDebtToPay = (firstLevelDebt * withdrawRatio) / 1e18;

            if (firstDebtToPay > 0) {
                // Ensure we have enough tokens to repay
                uint256 currentWantBal = IERC20(want).balanceOf(address(this));
                if (currentWantBal < firstDebtToPay) {
                    // Need to withdraw more from initial supplies
                    ILendingPool(lendingPool).withdraw(want, firstDebtToPay - currentWantBal, address(this));
                }

                ILendingPool(lendingPool).repay(want, firstDebtToPay, 2, address(this));
            }

            // Step 5: Withdraw from initial supply
            uint256 initialDeposit = ((totalAssets * withdrawRatio) / 1e18) -
                secondLevelToWithdraw -
                thirdLevelToWithdraw;

            if (initialDeposit > 0) {
                ILendingPool(lendingPool).withdraw(want, initialDeposit, address(this));
            }

            wantBal = IERC20(want).balanceOf(address(this));
        }

        if (wantBal > _amount) {
            wantBal = _amount;
        }

        if (tx.origin != owner() && !paused()) {
            uint256 withdrawalFeeAmount = (wantBal * withdrawalFee) / WITHDRAWAL_MAX;
            wantBal = wantBal - withdrawalFeeAmount;
        }

        _safeTransfer(want, address(this), vault, wantBal);

        emit Withdraw(balanceOf());
    }

    // Helper functions to calculate different levels of supply and debt
    function calculateFirstLevelDebt() public view returns (uint256) {
        // This is an approximation - in a real implementation, you would need to track
        // each level of debt separately or query the lending protocol for more precise data
        uint256 totalDebt = IERC20(debtToken).balanceOf(address(this));
        uint256 secondLevelDebt = calculateSecondLevelDebt();
        return totalDebt - secondLevelDebt;
    }

    function calculateSecondLevelDebt() public view returns (uint256) {
        // This is an approximation - in a real implementation, you would need to track
        // each level separately
        uint256 totalDebt = IERC20(debtToken).balanceOf(address(this));
        uint256 initialSupply = IERC20(aToken).balanceOf(address(this));
        uint256 firstLevelBorrow = (initialSupply * borrowFactor) / BORROW_FACTOR_MAX;
        uint256 secondLevelBorrow = (firstLevelBorrow * borrowFactor) / BORROW_FACTOR_MAX;
        return secondLevelBorrow;
    }

    function calculateSecondLevelSupply() public view returns (uint256) {
        // This is an approximation
        uint256 initialSupply = IERC20(aToken).balanceOf(address(this));
        uint256 firstLevelBorrow = (initialSupply * borrowFactor) / BORROW_FACTOR_MAX;
        return firstLevelBorrow;
    }

    function calculateThirdLevelSupply() public view returns (uint256) {
        // This is an approximation
        uint256 secondLevelSupply = calculateSecondLevelSupply();
        uint256 secondLevelBorrow = (secondLevelSupply * borrowFactor) / BORROW_FACTOR_MAX;
        return secondLevelBorrow;
    }

    function beforeDeposit() external virtual override {
        if (harvestOnDeposit) {
            require(msg.sender == vault, "!vault");
            _harvest(tx.origin);
        }
    }

    function harvest() external virtual {
        _harvest(tx.origin);
    }

    function harvest(address callFeeRecipient) external virtual {
        _harvest(callFeeRecipient);
    }

    function _harvest(address callFeeRecipient) internal whenNotPaused {
        // Claim rewards for both aToken and debtToken
        address[] memory assets = new address[](2);
        assets[0] = aToken;
        assets[1] = debtToken;
        uint256 amount = rewardsAvailable();

        IRewardsController(rewardsController).claimRewards(assets, amount, address(this), output);

        uint256 outputBal = IERC20(output).balanceOf(address(this));
        if (outputBal > 0) {
            chargeFees(callFeeRecipient);
            uint256 wantHarvested = balanceOfWant();
            deposit();

            lastHarvest = block.timestamp;
            emit StratHarvest(msg.sender, wantHarvested, balanceOf());
        }
    }

    function chargeFees(address callFeeRecipient) internal {
        IFeeConfig.FeeCategory memory fees = getFees();
        uint256 outputBal = IERC20(output).balanceOf(address(this));
        uint256 toNative = (outputBal * fees.total) / DIVISOR;

        uint256 callFeeAmount = (toNative * fees.call) / DIVISOR;
        _safeTransfer(output, address(this), callFeeRecipient, callFeeAmount);

        uint256 beefyFeeAmount = (toNative * fees.beefy) / DIVISOR;
        _safeTransfer(output, address(this), beefyFeeRecipient, beefyFeeAmount);

        uint256 strategistFeeAmount = (toNative * fees.strategist) / DIVISOR;
        _safeTransfer(output, address(this), strategist, strategistFeeAmount);

        emit ChargedFees(callFeeAmount, beefyFeeAmount, strategistFeeAmount);
    }

    function _transferHTS(address token, address from, address to, int64 amount) internal {
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.transferToken.selector, token, from, to, amount)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        if (responseCode != HTS_SUCCESS) {
            emit HTSTokenTransferFailed(token, from, to, responseCode);
            revert("HTS token transfer failed");
        }
    }

    function balanceOf() public view returns (uint256) {
        // Total balance is the net of all supplies minus all debts
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

    function setHarvestOnDeposit(bool _harvestOnDeposit) external onlyManager {
        harvestOnDeposit = _harvestOnDeposit;
        if (harvestOnDeposit) {
            setWithdrawalFee(0);
        } else {
            setWithdrawalFee(10);
        }
    }

    function setBorrowFactor(uint256 _borrowFactor) external onlyManager {
        require(_borrowFactor <= BORROW_FACTOR_MAX, "borrowFactor too high");
        borrowFactor = _borrowFactor;
        emit BorrowFactorUpdated(_borrowFactor);
    }

    function retireStrat() external {
        require(msg.sender == vault, "!vault");

        // Unwind 3-level leveraged position

        // Step 1: Withdraw all from third level (from second borrowing)
        uint256 thirdLevelSupply = calculateThirdLevelSupply();
        if (thirdLevelSupply > 0) {
            ILendingPool(lendingPool).withdraw(want, thirdLevelSupply, address(this));
        }

        // Step 2: Repay second level debt
        uint256 secondLevelDebt = calculateSecondLevelDebt();
        if (secondLevelDebt > 0) {
            // Ensure we have enough tokens to repay
            uint256 currentWantBal = IERC20(want).balanceOf(address(this));
            if (currentWantBal < secondLevelDebt) {
                // Need to withdraw more
                ILendingPool(lendingPool).withdraw(want, secondLevelDebt - currentWantBal, address(this));
            }

            ILendingPool(lendingPool).repay(want, secondLevelDebt, 2, address(this));
        }

        // Step 3: Withdraw from second level
        uint256 secondLevelSupply = calculateSecondLevelSupply();
        if (secondLevelSupply > secondLevelDebt) {
            ILendingPool(lendingPool).withdraw(want, secondLevelSupply - secondLevelDebt, address(this));
        }

        // Step 4: Repay first level debt
        uint256 firstLevelDebt = calculateFirstLevelDebt();
        if (firstLevelDebt > 0) {
            // Ensure we have enough tokens to repay
            uint256 currentWantBal = IERC20(want).balanceOf(address(this));
            if (currentWantBal < firstLevelDebt) {
                // Need to withdraw more
                ILendingPool(lendingPool).withdraw(want, firstLevelDebt - currentWantBal, address(this));
            }

            ILendingPool(lendingPool).repay(want, firstLevelDebt, 2, address(this));
        }

        // Step 5: Withdraw all remaining supply
        ILendingPool(lendingPool).withdraw(want, type(uint256).max, address(this));

        uint256 wantBal = IERC20(want).balanceOf(address(this));
        _safeTransfer(want, address(this), vault, wantBal);
    }

    function panic() public onlyManager {
        pause();

        // Unwind leveraged position same as retireStrat
        // Step 1: Withdraw all from third level (from second borrowing)
        uint256 thirdLevelSupply = calculateThirdLevelSupply();
        if (thirdLevelSupply > 0) {
            ILendingPool(lendingPool).withdraw(want, thirdLevelSupply, address(this));
        }

        // Step 2: Repay second level debt
        uint256 secondLevelDebt = calculateSecondLevelDebt();
        if (secondLevelDebt > 0) {
            // Ensure we have enough tokens to repay
            uint256 currentWantBal = IERC20(want).balanceOf(address(this));
            if (currentWantBal < secondLevelDebt) {
                // Need to withdraw more
                ILendingPool(lendingPool).withdraw(want, secondLevelDebt - currentWantBal, address(this));
            }

            ILendingPool(lendingPool).repay(want, secondLevelDebt, 2, address(this));
        }

        // Step 3: Withdraw from second level
        uint256 secondLevelSupply = calculateSecondLevelSupply();
        if (secondLevelSupply > secondLevelDebt) {
            ILendingPool(lendingPool).withdraw(want, secondLevelSupply - secondLevelDebt, address(this));
        }

        // Step 4: Repay first level debt
        uint256 firstLevelDebt = calculateFirstLevelDebt();
        if (firstLevelDebt > 0) {
            // Ensure we have enough tokens to repay
            uint256 currentWantBal = IERC20(want).balanceOf(address(this));
            if (currentWantBal < firstLevelDebt) {
                // Need to withdraw more
                ILendingPool(lendingPool).withdraw(want, firstLevelDebt - currentWantBal, address(this));
            }

            ILendingPool(lendingPool).repay(want, firstLevelDebt, 2, address(this));
        }

        // Step 5: Withdraw all remaining supply
        ILendingPool(lendingPool).withdraw(want, type(uint256).max, address(this));
    }

    function pause() public onlyManager {
        _pause();
        _removeAllowances();
    }

    function unpause() external onlyManager {
        _unpause();
        _giveAllowances();
        deposit();
    }

    function _giveAllowances() internal {
        if (!isHederaToken) {
            IERC20(want).approve(lendingPool, type(uint).max);
            IERC20(output).approve(unirouter, type(uint).max);
        }
    }

    function _removeAllowances() internal {
        if (!isHederaToken) {
            IERC20(want).approve(lendingPool, 0);
            IERC20(output).approve(unirouter, 0);
        }
    }
}
