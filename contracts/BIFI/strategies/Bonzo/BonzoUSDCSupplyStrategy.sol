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

contract BonzoUSDCSupplyStrategy is StratFeeManagerInitializable {
    using SafeERC20 for IERC20;
    // Tokens used
    address public want; // Hedera USDC token
    address public aToken; // aUSDC token
    address public output; // Reward token: USDC

    // Third party contracts
    address public lendingPool;
    address public rewardsController;

    // Hedera specific
    address constant private HTS_PRECOMPILE = address(0x167);
    int64 constant private HTS_SUCCESS = 22;
    int64 constant private PRECOMPILE_BIND_ERROR = -2;

    bool public harvestOnDeposit;
    uint256 public lastHarvest;
    

    // Events
    event StratHarvest(address indexed harvester, uint256 wantHarvested, uint256 tvl);
    event Deposit(uint256 tvl);
    event Withdraw(uint256 tvl);
    event ChargedFees(uint256 callFees, uint256 beefyFees, uint256 strategistFees);
    event HTSTokenAssociated(address token, int64 responseCode);
    event HTSTokenDissociated(address token, int64 responseCode);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);

    function initialize(
        address _want,
        address _aToken,
        address _lendingPool,
        address _rewardsController,
        address _output,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        __StratFeeManager_init(_commonAddresses);
        want = _want;
        aToken = _aToken;
        lendingPool = _lendingPool;
        rewardsController = _rewardsController;
        output = _output;

        // Associate HTS tokens
        _associateToken(_want);
        _associateToken(_output);
        _associateToken(_aToken);

        _giveAllowances();
    }

    /**
     * @dev Allow the owner to manually associate this contract with an HTS token
     * This can be useful if the contract needs to handle a new token or if token association failed
     * @param token The HTS token address to associate with this contract
     */
    function _associateToken(address token) internal {
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        require(responseCode == HTS_SUCCESS, "HTS token association failed");
        emit HTSTokenAssociated(token, responseCode);
    }

    // puts the funds to work
    function deposit() public whenNotPaused {
        uint256 wantBal = IERC20(want).balanceOf(address(this));

        if (wantBal > 0) {
            // Transfer Hedera USDC to lending pool using HTS
            _transferHTS(want, address(this), lendingPool, int64(uint64(wantBal)));
            
            // Deposit into lending pool
            ILendingPool(lendingPool).deposit(want, wantBal, address(this), 0);
            emit Deposit(balanceOf());
        }
    }

    function withdraw(uint256 _amount) external {
        require(msg.sender == vault, "!vault");

        uint256 wantBal = IERC20(want).balanceOf(address(this));

        if (wantBal < _amount) {
            // Withdraw Hedera USDC from lending pool
            ILendingPool(lendingPool).withdraw(want, _amount - wantBal, address(this));
            wantBal = IERC20(want).balanceOf(address(this));
        }

        if (wantBal > _amount) {
            wantBal = _amount;
        }

        if (tx.origin != owner() && !paused()) {
            uint256 withdrawalFeeAmount = wantBal * withdrawalFee / WITHDRAWAL_MAX;
            wantBal = wantBal - withdrawalFeeAmount;
        }

        // Transfer Hedera USDC to vault using HTS
        _transferHTS(want, address(this), vault, int64(uint64(wantBal)));

        emit Withdraw(balanceOf());
    }

    function beforeDeposit() external virtual override {
        if (harvestOnDeposit) {
            require(msg.sender == vault, "!vault");
            _harvest(tx.origin);
        }
    }

    function harvest() external  virtual {
        _harvest(tx.origin);
    }

    function harvest(address callFeeRecipient) external  virtual {
        _harvest(callFeeRecipient);
    }

    // compounds earnings and charges performance fee
    function _harvest(address callFeeRecipient) internal whenNotPaused {
        // Create array with aToken address for rewards claiming
        address[] memory assets = new address[](1);
        assets[0] = aToken; // For supply rewards
        uint256 amount = rewardsAvailable();
        // Claim rewards in Hedera USDC
        IRewardsController(rewardsController).claimRewards(
            assets,
            amount, // Claim all rewards
            address(this), // Send rewards to this contract
            output // Reward token address (Hedera USDC)
        );

        uint256 outputBal = IERC20(output).balanceOf(address(this));
        if (outputBal > 0) {
            chargeFees(callFeeRecipient);
            uint256 wantHarvested = balanceOfWant();
            deposit();

            lastHarvest = block.timestamp;
            emit StratHarvest(msg.sender, wantHarvested, balanceOf());
        }
    }

    // performance fees
    function chargeFees(address callFeeRecipient) internal {
        IFeeConfig.FeeCategory memory fees = getFees();
        uint256 outputBal = IERC20(output).balanceOf(address(this));
        uint256 toNative = outputBal * fees.total / DIVISOR;

        uint256 callFeeAmount = toNative * fees.call / DIVISOR;
        _transferHTS(output, address(this), callFeeRecipient, int64(uint64(callFeeAmount)));

        uint256 beefyFeeAmount = toNative * fees.beefy / DIVISOR;
        _transferHTS(output, address(this), beefyFeeRecipient, int64(uint64(beefyFeeAmount)));

        uint256 strategistFeeAmount = toNative * fees.strategist / DIVISOR;
        _transferHTS(output, address(this), strategist, int64(uint64(strategistFeeAmount)));

        emit ChargedFees(callFeeAmount, beefyFeeAmount, strategistFeeAmount);
    }

    // Helper function to transfer HTS tokens
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

    // calculate the total underlaying 'want' held by the strat.
    function balanceOf() public view returns (uint256) {
        return balanceOfWant() + balanceOfPool();
    }

    // it calculates how much 'want' this contract holds.
    function balanceOfWant() public view returns (uint256) {
        return IERC20(want).balanceOf(address(this));
    }

    // it calculates how much 'want' the strategy has working in the farm.
    function balanceOfPool() public view returns (uint256) {
        return IERC20(aToken).balanceOf(address(this));
    }

    // returns rewards unharvested
    function rewardsAvailable() public view returns (uint256) {
        (uint256 supplyRewards,,, ) = IRewardsController(rewardsController).getRewardsData(aToken, output);
        return supplyRewards;
    }

    // native reward amount for calling harvest
    function callReward() public view returns (uint256) {
        IFeeConfig.FeeCategory memory fees = getFees();
        uint256 outputBal = rewardsAvailable();
        return outputBal * fees.total / DIVISOR * fees.call / DIVISOR;
    }

    function setHarvestOnDeposit(bool _harvestOnDeposit) external onlyManager {
        harvestOnDeposit = _harvestOnDeposit;

        if (harvestOnDeposit) {
            setWithdrawalFee(0);
        } else {
            setWithdrawalFee(10);
        }
    }


    // called as part of strat migration. Sends all the available funds back to the vault.
    function retireStrat() external {
        require(msg.sender == vault, "!vault");

        ILendingPool(lendingPool).withdraw(want, balanceOfPool(), address(this));

        uint256 wantBal = IERC20(want).balanceOf(address(this));
        _transferHTS(want, address(this), vault, int64(uint64(wantBal)));
    }

    // pauses deposits and withdraws all funds from third party systems.
    function panic() public onlyManager {
        pause();
        ILendingPool(lendingPool).withdraw(want, balanceOfPool(), address(this));
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
        // For HTS tokens, we don't need to approve as we use direct transfers
        // But we keep this for compatibility with the interface
        IERC20(want).approve(lendingPool, type(uint).max);
        IERC20(output).approve(unirouter, type(uint).max);
    }

    function _removeAllowances() internal {
        IERC20(want).approve(lendingPool, 0);
        IERC20(output).approve(unirouter, 0);
    }
}
