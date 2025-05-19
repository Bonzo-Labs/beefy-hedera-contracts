// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

import "../interfaces/beefy/IStrategyV7.sol";
import "../interfaces/saucerswap/IUniswapV3Pool.sol";
import "../Hedera/IHederaTokenService.sol";
import "../interfaces/oracle/IBeefyOracle.sol";

/**
 * @dev Implementation of a vault to deposit funds for yield optimizing with multiple tokens.
 * This is the contract that receives funds and that users interface with.
 * The yield optimizing strategy itself is implemented in a separate 'Strategy.sol' contract.
 * This version supports both standard ERC20 tokens and Hedera Token Service (HTS) tokens.
 * It handles both tokens (token0 and token1) from a Uniswap V3 style pool.
 */
contract BeefyVaultV7HederaMultiToken is ERC20Upgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
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
    // Flag to identify if token0 is a Hedera Token Service token
    bool public isHederaToken0;
    // Flag to identify if token1 is a Hedera Token Service token
    bool public isHederaToken1;
    // The pool contract that contains token0 and token1
    IUniswapV3Pool public pool;
    // Address of the Hedera Token Service precompile
    address constant private HTS_PRECOMPILE = address(0x167);
    // HTS success response code
    int64 constant private HTS_SUCCESS = 22;
    // Error code when binding to the HTS precompile fails.
    int64 constant private PRECOMPILE_BIND_ERROR = -1;
    // Flag to track if the strategy has been associated with token0
    bool private token0Associated;
    // Flag to track if the strategy has been associated with token1
    bool private token1Associated;
    address public beefyOracle;

    event NewStratCandidate(address implementation);
    event UpgradeStrat(address implementation);
    event HTSAssociationFailed(address token, address account, int64 responseCode);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);

    /**
     * @dev Initializes the vault with the appropriate strategy, name, symbol, approval delay, and
     * identifies if the tokens are Hedera Token Service tokens.
     * @param _strategy the address of the strategy.
     * @param _pool the address of the pool containing token0 and token1.
     * @param _name the name of the vault token.
     * @param _symbol the symbol of the vault token.
     * @param _approvalDelay the delay before a new strat can be approved.
     * @param _isHederaToken0 flag indicating if token0 is a Hedera Token Service token.
     * @param _isHederaToken1 flag indicating if token1 is a Hedera Token Service token.
     * @param _beefyOracle the address of the Beefy Oracle contract.
     */
    function initialize(
        IStrategyV7 _strategy,
        address _pool,
        string memory _name,
        string memory _symbol,
        uint256 _approvalDelay,
        bool _isHederaToken0,
        bool _isHederaToken1,
        address _beefyOracle
    ) public initializer {
        __ERC20_init(_name, _symbol);
        __Ownable_init();
        __ReentrancyGuard_init();
        strategy = _strategy;
        pool = IUniswapV3Pool(_pool);
        approvalDelay = _approvalDelay;
        isHederaToken0 = _isHederaToken0;
        isHederaToken1 = _isHederaToken1;
        token0Associated = false;
        token1Associated = false;
        beefyOracle = _beefyOracle;

        // If using HTS tokens, check and associate tokens with this contract
        if (isHederaToken0) {
            associateToken(address(pool.token0()));
        }
        
        if (isHederaToken1) {
            associateToken(address(pool.token1()));
        }
    }

    function token0() public view returns (IERC20Upgradeable) {
        return IERC20Upgradeable(pool.token0());
    }

    function token1() public view returns (IERC20Upgradeable) {
        return IERC20Upgradeable(pool.token1());
    }

    /**
     * @dev It calculates the total underlying value of {token0} held by the system.
     * It takes into account the vault contract balance, the strategy contract balance
     * and the balance deployed in other contracts as part of the strategy.
     */
    function balance0() public view returns (uint) {
        return token0().balanceOf(address(this)) + IStrategyV7(strategy).balanceOf();
    }

    /**
     * @dev It calculates the total underlying value of {token1} held by the system.
     * It takes into account the vault contract balance, the strategy contract balance
     * and the balance deployed in other contracts as part of the strategy.
     */
    function balance1() public view returns (uint) {
        return token1().balanceOf(address(this)) + IStrategyV7(strategy).balanceOf();
    }

    /**
     * @dev Function for various UIs to display the current value of one of our yield tokens.
     * Returns an uint256 with 18 decimals of how much underlying asset one vault share represents.
     * Uses token0 as the reference token.
     */
    function getPricePerFullShare() public view returns (uint256) {
        return totalSupply() == 0 ? 1e18 : balance0() * 1e18 / totalSupply();
    }

    /**
     * @dev A helper function to call deposit() with all the sender's funds.
     */
    function depositAll() external {
        deposit(token0().balanceOf(msg.sender), token1().balanceOf(msg.sender));
    }

    /**
     * @dev The entrypoint of funds into the system. People deposit with this function
     * into the vault. The vault is then in charge of sending funds into the strategy.
     */
    function deposit(uint _amount0, uint _amount1) public nonReentrant {
        strategy.beforeDeposit();

        uint256 _pool0 = balance0();
        uint256 _pool1 = balance1();
        
        // Get current token prices
        (uint256 price0, uint256 price1) = getTokenPrices();
        
        if (_amount0 > 0) {
            if (isHederaToken0) {
                // For HTS tokens, check association and transfer
                address token = address(token0());
                _transferHTS(token, msg.sender, address(this), int64(uint64(_amount0)));
            } else {
                // For ERC20 tokens, use standard SafeERC20 transfer
                token0().safeTransferFrom(msg.sender, address(this), _amount0);
            }
        }
        
        if (_amount1 > 0) {
            if (isHederaToken1) {
                // For HTS tokens, check association and transfer
                address token = address(token1());
                _transferHTS(token, msg.sender, address(this), int64(uint64(_amount1)));
            } else {
                // For ERC20 tokens, use standard SafeERC20 transfer
                token1().safeTransferFrom(msg.sender, address(this), _amount1);
            }
        }
        
        earn();
        uint256 _after0 = balance0();
        uint256 _after1 = balance1();
        _amount0 = _after0 - _pool0;
        _amount1 = _after1 - _pool1;
        
        // Calculate shares based on token values using prices
        uint256 shares = 0;
        if (totalSupply() == 0) {
            // For first deposit, calculate total value in USD
            uint256 value0 = _amount0 * price0;
            uint256 value1 = _amount1 * price1;
            shares = (value0 + value1) / 2;
        } else {
            // Calculate value of deposited tokens
            uint256 value0 = _amount0 * price0;
            uint256 value1 = _amount1 * price1;
            
            // Calculate value of existing pool
            uint256 poolValue0 = _pool0 * price0;
            uint256 poolValue1 = _pool1 * price1;
            
            // Calculate shares based on value proportion
            uint256 shares0 = value0 > 0 ? (value0 * totalSupply()) / poolValue0 : 0;
            uint256 shares1 = value1 > 0 ? (value1 * totalSupply()) / poolValue1 : 0;
            
            // Take average of share calculations
            shares = (shares0 + shares1) / 2;
        }
        
        _mint(msg.sender, shares);
    }

    /**
     * @dev Function to send funds into the strategy and put them to work. It's primarily called
     * by the vault's deposit() function.
     */
    function earn() public {
        uint _bal0 = token0().balanceOf(address(this));
        uint _bal1 = token1().balanceOf(address(this));
        
        if (_bal0 > 0) {
            if (isHederaToken0) {            
                // Transfer tokens to strategy
                address token = address(token0());
                _transferHTS(token, address(this), address(strategy), int64(uint64(_bal0)));
            } else {
                // For ERC20 tokens, use standard SafeERC20 transfer
                token0().safeTransfer(address(strategy), _bal0);
            }
        }
        
        if (_bal1 > 0) {
            if (isHederaToken1) {            
                // Transfer tokens to strategy
                address token = address(token1());
                _transferHTS(token, address(this), address(strategy), int64(uint64(_bal1)));
            } else {
                // For ERC20 tokens, use standard SafeERC20 transfer
                token1().safeTransfer(address(strategy), _bal1);
            }
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
        uint256 r0 = (balance0() * _shares) / totalSupply();
        uint256 r1 = (balance1() * _shares) / totalSupply();
        _burn(msg.sender, _shares);

        // Handle token0
        uint b0 = token0().balanceOf(address(this));
        if (b0 < r0) {
            uint _withdraw0 = r0 - b0;
            strategy.withdraw(_withdraw0);
            uint _after0 = token0().balanceOf(address(this));
            uint _diff0 = _after0 - b0;
            if (_diff0 < _withdraw0) {
                r0 = b0 + _diff0;
            }
        }

        // Handle token1
        uint b1 = token1().balanceOf(address(this));
        if (b1 < r1) {
            uint _withdraw1 = r1 - b1;
            strategy.withdraw(_withdraw1);
            uint _after1 = token1().balanceOf(address(this));
            uint _diff1 = _after1 - b1;
            if (_diff1 < _withdraw1) {
                r1 = b1 + _diff1;
            }
        }

        // Transfer token0 to user
        if (r0 > 0) {
            if (isHederaToken0) {
                address token = address(token0());
                _transferHTS(token, address(this), msg.sender, int64(uint64(r0)));
            } else {
                token0().safeTransfer(msg.sender, r0);
            }
        }

        // Transfer token1 to user
        if (r1 > 0) {
            if (isHederaToken1) {
                address token = address(token1());
                _transferHTS(token, address(this), msg.sender, int64(uint64(r1)));
            } else {
                token1().safeTransfer(msg.sender, r1);
            }
        }
    }

    /** 
     * @dev Sets the candidate for the new strat to use with this vault.
     * @param _implementation The address of the candidate strategy.  
     */
    function proposeStrat(address _implementation) public onlyOwner {
        require(address(this) == IStrategyV7(_implementation).vault(), "Proposal not valid for this Vault");
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
        
        // Associate the new strategy with the tokens if they're Hedera tokens
        if (isHederaToken0 && !token0Associated) {
            address token = address(token0());
            (bool success, bytes memory result) = HTS_PRECOMPILE.call(
                abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(strategy), token)
            );
            int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
            if (responseCode != HTS_SUCCESS) {
                emit HTSAssociationFailed(token, address(strategy), responseCode);
            } else {
                token0Associated = true;
            }
        } else {
            token0Associated = false;
        }
        
        if (isHederaToken1 && !token1Associated) {
            address token = address(token1());
            (bool success, bytes memory result) = HTS_PRECOMPILE.call(
                abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(strategy), token)
            );
            int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
            if (responseCode != HTS_SUCCESS) {
                emit HTSAssociationFailed(token, address(strategy), responseCode);
            } else {
                token1Associated = true;
            }
        } else {
            token1Associated = false;
        }
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
    function associateToken(address token) public onlyOwner {
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
        require(_token != address(token0()) && _token != address(token1()), "!token");

        bool isHederaToken = isHederaToken0 || isHederaToken1;
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
     * @dev Update the isHederaToken0 flag if needed
     * This would only be used in very specific migration scenarios
     * @param _isHederaToken0 The new value for isHederaToken0
     */
    function setIsHederaToken0(bool _isHederaToken0) external onlyOwner {
        isHederaToken0 = _isHederaToken0;
    }

    /**
     * @dev Update the isHederaToken1 flag if needed
     * This would only be used in very specific migration scenarios
     * @param _isHederaToken1 The new value for isHederaToken1
     */
    function setIsHederaToken1(bool _isHederaToken1) external onlyOwner {
        isHederaToken1 = _isHederaToken1;
    }

    function getTokenPrices() internal view returns (uint256 price0, uint256 price1) {
        // Get token0 price
        try IBeefyOracle(beefyOracle).getPrice(address(token0())) returns (uint256 p0) {
            price0 = p0;
        } catch {
            revert("Failed to get token0 price");
        }

        // Get token1 price
        try IBeefyOracle(beefyOracle).getPrice(address(token1())) returns (uint256 p1) {
            price1 = p1;
        } catch {
            revert("Failed to get token1 price");
        }
    }
}
