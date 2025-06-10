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

contract YieldLoop2x is StratFeeManagerInitializable {
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
            // Step 1: Supply want token to lending pool
            if (isHederaToken) {
                _transferHTS(want, address(this), lendingPool, int64(uint64(wantBal)));
            }
            ILendingPool(lendingPool).deposit(want, wantBal, address(this), 0);

            // Step 2: Borrow 40% of supplied value
            uint256 borrowAmount = (wantBal * borrowFactor) / BORROW_FACTOR_MAX;
            if (borrowAmount > 0) {
                ILendingPool(lendingPool).borrow(want, borrowAmount, 2, 0, address(this));

                // Step 3: Supply the borrowed tokens back again
                uint256 newWantBal = IERC20(want).balanceOf(address(this));
                if (newWantBal > 0) {
                    if (isHederaToken) {
                        _transferHTS(want, address(this), lendingPool, int64(uint64(newWantBal)));
                    }
                    ILendingPool(lendingPool).deposit(want, newWantBal, address(this), 0);
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

            // Step 1: Calculate and withdraw portion of supplied borrowed tokens
            uint256 borrowedSupply = IERC20(aToken).balanceOf(address(this)) -
                IERC20(debtToken).balanceOf(address(this));
            uint256 borrowedToWithdraw = (borrowedSupply * withdrawRatio) / 1e18;

            if (borrowedToWithdraw > 0) {
                ILendingPool(lendingPool).withdraw(want, borrowedToWithdraw, address(this));
            }

            // Step 2: Calculate and repay portion of borrowed amount
            uint256 debtToPay = (IERC20(debtToken).balanceOf(address(this)) * withdrawRatio) / 1e18;

            if (debtToPay > 0) {
                ILendingPool(lendingPool).repay(want, debtToPay, 2, address(this));
            }

            // Step 3: Withdraw initial deposit portion
            uint256 initialDeposit = ((totalAssets * withdrawRatio) / 1e18) - borrowedToWithdraw;

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

        // Unwind leveraged position first
        uint256 debtAmount = balanceOfBorrow();
        if (debtAmount > 0) {
            // Withdraw enough to cover debt
            ILendingPool(lendingPool).withdraw(want, debtAmount, address(this));
            // Repay all debt
            ILendingPool(lendingPool).repay(want, type(uint256).max, 2, address(this));
        }

        // Now withdraw remaining supply
        ILendingPool(lendingPool).withdraw(want, type(uint256).max, address(this));

        uint256 wantBal = IERC20(want).balanceOf(address(this));
        _safeTransfer(want, address(this), vault, wantBal);
    }

    function panic() public onlyManager {
        pause();

        // Unwind leveraged position first
        uint256 debtAmount = balanceOfBorrow();
        if (debtAmount > 0) {
            // Withdraw enough to cover debt
            ILendingPool(lendingPool).withdraw(want, debtAmount, address(this));
            // Repay all debt
            ILendingPool(lendingPool).repay(want, type(uint256).max, 2, address(this));
        }

        // Now withdraw remaining supply
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
