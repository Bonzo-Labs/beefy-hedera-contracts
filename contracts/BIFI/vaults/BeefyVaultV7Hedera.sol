// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import "../interfaces/beefy/IStrategyV7.sol";
import "../Hedera/IHederaTokenService.sol";


/**
 * @dev Implementation of a vault to deposit funds for yield optimizing.
 * This is the contract that receives funds and that users interface with.
 * The yield optimizing strategy itself is implemented in a separate 'Strategy.sol' contract.
 * This version supports both standard ERC20 tokens and Hedera Token Service (HTS) tokens.
 */
contract BeefyVaultV7Hedera is ERC20Upgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    struct StratCandidate {
        address implementation;
        uint proposedTime;
    }

    // The last proposed strategy to switch to.
    StratCandidate public stratCandidate;
    // The strategy currently in use by the vault.
    IStrategyV7 public strategy;
    // The minimum time it has to pass before a strat candidate can be approved.
    uint256 public approvalDelay;
    // Flag to identify if the want token is a Hedera Token Service token
    bool public isHederaToken;
    // Address of the Hedera Token Service precompile
    address constant private HTS_PRECOMPILE = address(0x167);
    // HTS success response code
    int64 constant private HTS_SUCCESS = 22;
    // Error code when binding to the HTS precompile fails.
    int64 constant private PRECOMPILE_BIND_ERROR = -1;
    // Flag to track if the strategy has been associated with the token
    bool private strategyTokenAssociated;

    event NewStratCandidate(address implementation);
    event UpgradeStrat(address implementation);
    event HTSAssociationFailed(address token, address account, int64 responseCode);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);

    /**
     * @dev Initializes the vault with the appropriate strategy, name, symbol, approval delay, and
     * identifies if the want token is a Hedera Token Service token.
     * @param _strategy the address of the strategy.
     * @param _name the name of the vault token.
     * @param _symbol the symbol of the vault token.
     * @param _approvalDelay the delay before a new strat can be approved.
     * @param _isHederaToken flag indicating if the want token is a Hedera Token Service token.
     */
    function initialize(
        IStrategyV7 _strategy,
        string memory _name,
        string memory _symbol,
        uint256 _approvalDelay,
        bool _isHederaToken
    ) public initializer {
        __ERC20_init(_name, _symbol);
        __Ownable_init();
        __ReentrancyGuard_init();
        strategy = _strategy;
        approvalDelay = _approvalDelay;
        isHederaToken = _isHederaToken;
        strategyTokenAssociated = false;

        // If using HTS token, check and associate token with this contract
        if (isHederaToken) {
            address token = address(strategy.want());
            associateToken(token);
        }
    }

    function want() public view returns (IERC20Upgradeable) {
        return IERC20Upgradeable(strategy.want());
    }

    /**
     * @dev It calculates the total underlying value of {token} held by the system.
     * It takes into account the vault contract balance, the strategy contract balance
     *  and the balance deployed in other contracts as part of the strategy.
     */
    function balance() public view returns (uint) {
        return want().balanceOf(address(this)) + IStrategyV7(strategy).balanceOf();
    }

    /**
     * @dev Custom logic in here for how much the vault allows to be borrowed.
     * We return 100% of tokens for now. Under certain conditions we might
     * want to keep some of the system funds at hand in the vault, instead
     * of putting them to work.
     */
    function available() public view returns (uint256) {
        return want().balanceOf(address(this));
    }

    /**
     * @dev Function for various UIs to display the current value of one of our yield tokens.
     * Returns an uint256 with 18 decimals of how much underlying asset one vault share represents.
     */
    function getPricePerFullShare() public view returns (uint256) {
        return totalSupply() == 0 ? 1e18 : balance() * 1e18 / totalSupply();
    }

    /**
     * @dev A helper function to call deposit() with all the sender's funds.
     */
    function depositAll() external {
        deposit(want().balanceOf(msg.sender));
    }


    /**
     * @dev The entrypoint of funds into the system. People deposit with this function
     * into the vault. The vault is then in charge of sending funds into the strategy.
     */
    function deposit(uint _amount) public nonReentrant {
        strategy.beforeDeposit();

        uint256 _pool = balance();
        
        if (isHederaToken) {
            // For HTS tokens, check association and transfer
            address token = address(want());
            _transferHTS(token, msg.sender, address(this), int64(uint64(_amount)));
        } else {
            // For ERC20 tokens, use standard SafeERC20 transfer
            want().safeTransferFrom(msg.sender, address(this), _amount);
        }
        
        earn();
        uint256 _after = balance();
        _amount = _after - _pool; // Additional check for deflationary tokens
        uint256 shares = 0;
        if (totalSupply() == 0) {
            shares = _amount;
        } else {
            shares = (_amount * totalSupply()) / _pool;
        }
        _mint(msg.sender, shares);
    }

    /**
     * @dev Function to send funds into the strategy and put them to work. It's primarily called
     * by the vault's deposit() function.
     */
    function earn() public {
        uint _bal = available();
        
        if (isHederaToken) {            
            // Transfer tokens to strategy
            address token = address(want());
            _transferHTS(token, address(this), address(strategy), int64(uint64(_bal)));
        } else {
            // For ERC20 tokens, use standard SafeERC20 transfer
            want().safeTransfer(address(strategy), _bal);
        }
        
        strategy.deposit();
    }

    /**
     * @dev A helper function to call withdraw() with all the sender's funds.
     */
    function withdrawAll() external {
        withdraw(balanceOf(msg.sender));
    }

    /**
     * @dev Function to exit the system. The vault will withdraw the required tokens
     * from the strategy and pay up the token holder. A proportional number of IOU
     * tokens are burned in the process.
     */
    function withdraw(uint256 _shares) public {
        uint256 r = (balance() * _shares) / totalSupply();
        _burn(msg.sender, _shares);

        uint b = want().balanceOf(address(this));
        if (b < r) {
            uint _withdraw = r - b;
            strategy.withdraw(_withdraw);
            uint _after = want().balanceOf(address(this));
            uint _diff = _after - b;
            if (_diff < _withdraw) {
                r = b + _diff;
            }
        }

        if (isHederaToken) {
            // For HTS tokens, transfer to user
            address token = address(want());
            _transferHTS(token, address(this), msg.sender, int64(uint64(r)));
        } else {
            // For ERC20 tokens, use standard SafeERC20 transfer
            want().safeTransfer(msg.sender, r);
        }
    }

    /** 
     * @dev Sets the candidate for the new strat to use with this vault.
     * @param _implementation The address of the candidate strategy.  
     */
    function proposeStrat(address _implementation) public onlyOwner {
        require(address(this) == IStrategyV7(_implementation).vault(), "Proposal not valid for this Vault");
        require(want() == IStrategyV7(_implementation).want(), "Different want");
        stratCandidate = StratCandidate({
            implementation: _implementation,
            proposedTime: block.timestamp
         });

        emit NewStratCandidate(_implementation);
    }

    /** 
     * @dev It switches the active strat for the strat candidate. After upgrading, the 
     * candidate implementation is set to the 0x00 address, and proposedTime to a time 
     * happening in +100 years for safety. 
     */
    function upgradeStrat() public onlyOwner {
        require(stratCandidate.implementation != address(0), "There is no candidate");
        require(stratCandidate.proposedTime + approvalDelay < block.timestamp, "Delay has not passed");

        emit UpgradeStrat(stratCandidate.implementation);

        strategy.retireStrat();
        strategy = IStrategyV7(stratCandidate.implementation);
        stratCandidate.implementation = address(0);
        stratCandidate.proposedTime = 5000000000;
        // Associate the new strategy with the token if it's a Hedera token
        if (isHederaToken && !strategyTokenAssociated) {
            address token = address(want());
            (bool success, bytes memory result) = HTS_PRECOMPILE.call(
                abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(strategy), token)
            );
            int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
            if (responseCode != HTS_SUCCESS) {
                emit HTSAssociationFailed(token, address(strategy), responseCode);
            } else {
                strategyTokenAssociated = true;
            }
        } else {
            strategyTokenAssociated = false;
        }

        earn();
    }

    /**
     * @dev Helper function to transfer HTS tokens between accounts
     * @param token The HTS token address
     * @param from The sender address
     * @param to The recipient address
     * @param amount The amount to transfer as int64
     */
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

    /**
     * @dev Allow the owner to manually associate this contract with an HTS token
     * This can be useful if the contract needs to handle a new token or if token association failed
     * @param token The HTS token address to associate with this contract
     */
    function associateToken(address token) private onlyOwner {
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        require(responseCode == HTS_SUCCESS, "HTS token association failed");
    }

    /**
     * @dev Rescues random funds stuck that the strat can't handle.
     * @param _token address of the token to rescue.
     */
    function inCaseTokensGetStuck(address _token) external onlyOwner {
        require(_token != address(want()), "!token");

        if (isHederaToken && _token != address(0)) {
            // For rescuing HTS tokens
            uint256 amount = IERC20Upgradeable(_token).balanceOf(address(this));
            _transferHTS(_token, address(this), msg.sender, int64(uint64(amount)));
        } else {
            // For rescuing ERC20 tokens
            uint256 amount = IERC20Upgradeable(_token).balanceOf(address(this));
            IERC20Upgradeable(_token).safeTransfer(msg.sender, amount);
        }
    }

    /**
     * @dev Update the isHederaToken flag if needed
     * This would only be used in very specific migration scenarios
     * @param _isHederaToken The new value for isHederaToken
     */
    function setIsHederaToken(bool _isHederaToken) external onlyOwner {
        isHederaToken = _isHederaToken;
    }
}
