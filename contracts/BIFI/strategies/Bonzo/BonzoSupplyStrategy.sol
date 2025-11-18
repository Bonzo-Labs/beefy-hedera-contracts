// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "@openzeppelin-4/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../interfaces/bonzo/ILendingPool.sol";
import "../../interfaces/bonzo/IRewardsController.sol";
import "../Common/StratFeeManagerInitializable.sol";
import "../../utils/GasFeeThrottler.sol";
import "../../Hedera/IHederaTokenService.sol";
import "../../interfaces/beefy/IStrategyV7.sol";

contract BonzoSupplyStrategy is StratFeeManagerInitializable {
    using SafeERC20 for IERC20;

    //update while deploying new strategy
    string public constant NAME = "Strategy Bonzo Supply";
    string public constant SYMBOL = "strategy-bonzo-supply";

    // Tokens used
    address public want; // Deposit token
    address public aToken; // Receipt token
    address public output; // Reward token

    // Third party contracts
    address public lendingPool;
    address public rewardsController;

    // Hedera specific
    address constant private HTS_PRECOMPILE = address(0x167);
    int64 constant private HTS_SUCCESS = 22;
    int64 constant private PRECOMPILE_BIND_ERROR = -2;

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
    event HarvestOnDepositUpdated(bool oldValue, bool newValue);
    event RewardsClaimed(uint256 amount, address token);
    event StratPanicCalled();
    event StrategyRetired();

    function initialize(
        address _want,
        address _aToken,
        address _lendingPool,
        address _rewardsController,
        address _output,
        bool _isHederaToken,
        CommonAddresses calldata _commonAddresses
    ) public initializer {
        require(_want != address(0), "Invalid want address");
        require(_aToken != address(0), "Invalid aToken address");
        require(_lendingPool != address(0), "Invalid lending pool address");
        require(_rewardsController != address(0), "Invalid rewards controller address");
        require(_output != address(0), "Invalid output address");
       
        __StratFeeManager_init(_commonAddresses);
        __Ownable_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        want = _want;
        aToken = _aToken;
        lendingPool = _lendingPool;
        rewardsController = _rewardsController;
        output = _output;
        isHederaToken = _isHederaToken;

        if (isHederaToken) {
            // Associate HTS tokens
            _associateToken(_want);
            if(_want != _output) {
                _associateToken(_output);
            }
        }

        _giveAllowances();
    }

    function _associateToken(address token) internal {
        require(token != address(0), "Invalid token address");
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        require(responseCode == HTS_SUCCESS, "HTS token association failed");
        emit HTSTokenAssociated(token, responseCode);
    }

    function _safeTransfer(address token, address from, address to, uint256 amount) internal {
        require(token != address(0), "Invalid token address");
        require(from != address(0), "Invalid from address");
        require(to != address(0), "Invalid to address");
        require(amount > 0, "Amount must be greater than 0");

        if (isHederaToken) {
            require(amount <= uint256(uint64(type(int64).max)), "Amount too large for int64");
            _transferHTS(token, from, to, int64(uint64(amount)));
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function deposit() public whenNotPaused nonReentrant {
        require(msg.sender == vault, "!vault");
        _deposit();
        emit Deposit(balanceOf());
    }

    function _deposit() internal {
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        require(wantBal > 0, "No funds to deposit");

        IERC20(want).safeApprove(lendingPool, wantBal);
        ILendingPool(lendingPool).deposit(want, wantBal, address(this), 0);   
    }

    function withdraw(uint256 _amount) external nonReentrant {
        require(msg.sender == vault, "!vault");
        require(_amount > 0, "Amount must be greater than 0");

        uint256 wantBal = IERC20(want).balanceOf(address(this));

        if (wantBal < _amount) {
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

        _safeTransfer(want, address(this), vault, wantBal);

        emit Withdraw(balanceOf());
    }

    function beforeDeposit() external virtual override nonReentrant {
        if (harvestOnDeposit) {
            require(msg.sender == vault, "!vault");
            _harvest(tx.origin);
        }
    }

    function harvest() external virtual  {
        _harvest(tx.origin);
    }

    function harvest(address callFeeRecipient) external virtual  {
        require(callFeeRecipient != address(0), "Invalid fee recipient");
        _harvest(callFeeRecipient);
    }

    function _harvest(address callFeeRecipient) internal whenNotPaused {
        require(callFeeRecipient != address(0), "Invalid fee recipient");
        
        address[] memory assets = new address[](1);
        assets[0] = aToken;
        uint256 amount = rewardsAvailable();
        uint256 claimedAmount = 0;
        if (amount > 0) {
            claimedAmount = IRewardsController(rewardsController).claimRewards(
                assets,
                amount,
                address(this),
                output
            );
            emit RewardsClaimed(claimedAmount, output);
        }

        if (claimedAmount > 0) {
            chargeFees(callFeeRecipient, claimedAmount);
            uint256 wantHarvested = balanceOfWant();
            if(wantHarvested > 0) {
                _deposit();
            }
        }
        
        lastHarvest = block.timestamp;
        emit StratHarvest(tx.origin, claimedAmount, balanceOf());
    }

    function chargeFees(address callFeeRecipient, uint256 claimedAmount) internal {
        require(callFeeRecipient != address(0), "Invalid fee recipient");
        
        IFeeConfig.FeeCategory memory fees = getFees();
        uint256 totalFees = claimedAmount * fees.total / DIVISOR;

        uint256 callFeeAmount = totalFees * fees.call / DIVISOR;
        if(callFeeAmount > 0) {
            _safeTransfer(output, address(this), callFeeRecipient, callFeeAmount);
        }

        uint256 beefyFeeAmount = totalFees * fees.beefy / DIVISOR;
        if(beefyFeeAmount > 0) {
            _safeTransfer(output, address(this), beefyFeeRecipient, beefyFeeAmount);
        }

        uint256 strategistFeeAmount = totalFees * fees.strategist / DIVISOR;
        if(strategistFeeAmount > 0) {
            _safeTransfer(output, address(this), strategist, strategistFeeAmount);
        }

        emit ChargedFees(callFeeAmount, beefyFeeAmount, strategistFeeAmount);
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

    function balanceOf() public view returns (uint256) {
        return balanceOfWant() + balanceOfPool();
    }

    function balanceOfWant() public view returns (uint256) {
        return IERC20(want).balanceOf(address(this));
    }

    function balanceOfPool() public view returns (uint256) {
        return IERC20(aToken).balanceOf(address(this));
    }

    function rewardsAvailable() public view returns (uint256) {
        (uint256 supplyRewards,,, ) = IRewardsController(rewardsController).getRewardsData(aToken, output);
        return supplyRewards;
    }

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
        emit HarvestOnDepositUpdated(harvestOnDeposit, _harvestOnDeposit);
    }

    function retireStrat() external nonReentrant {
        require(msg.sender == owner() || msg.sender == keeper || msg.sender == vault, "!invalid caller");
        panic();
        uint256 wantBal = IERC20(want).balanceOf(address(this));
        _safeTransfer(want, address(this), vault, wantBal);
        _transferOwnership(address(0));
        emit StrategyRetired();
    }

    function panic() public {
        require(msg.sender == owner() || msg.sender == keeper || msg.sender == vault, "!invalid caller");
        address[] memory assets = new address[](1);
        assets[0] = aToken;
        uint256 amount = rewardsAvailable();
        if (amount > 0) {
            try IRewardsController(rewardsController).claimRewards(
                    assets,
                    amount,
                    address(this),
                    output
                ){
               emit RewardsClaimed(amount, output);
            } catch {}
        }

        ILendingPool(lendingPool).withdraw(want, balanceOfPool(), address(this));
        pause();
        emit StratPanicCalled();
    }

    function reversePanic() public onlyManager {
        _unpause();
        _deposit();
    }

    function pause() public onlyManager {
        _pause();
    }

    function unpause() external onlyManager {
        _unpause();
    }

    function _giveAllowances() internal {
        if (!isHederaToken) {
            IERC20(want).safeApprove(lendingPool, type(uint).max);
            IERC20(output).safeApprove(unirouter, type(uint).max);
        }
    }

    function inCaseNativeTokensGetStuck() external onlyManager {
        uint256 amount = address(this).balance;
        if (amount > 0) {
            payable(msg.sender).transfer(amount);
        }
    }

    function inCaseTokensGetStuck(address _token) external onlyManager {
        require(_token != want, "!want");
        require(_token != aToken, "!aToken");
        require(_token != output, "!output");
        uint256 amount = IERC20(_token).balanceOf(address(this));
        if (amount > 0) {
            _safeTransfer(_token, address(this), msg.sender, amount);
        }
    }

}
