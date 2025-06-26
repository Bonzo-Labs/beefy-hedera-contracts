// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";

import "../interfaces/beefy/IStrategyMultiToken.sol";
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
    using AddressUpgradeable for address payable;

    struct StratCandidate {
        address implementation;
        uint proposedTime;
    }

    // The last proposed strategy to switch to.
    StratCandidate public stratCandidate;
    // The strategy currently in use by the vault.
    IStrategyMultiToken public strategy;
    // The minimum time it has to pass before a strat candidate can be approved.
    uint256 public approvalDelay;
    // Flag to identify if token0 is a Hedera Token Service token
    bool private isHTStoken0;
    // Flag to identify if token1 is a Hedera Token Service token
    bool private isHTStoken1;
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
    // Flag to track if token0 is a native token
    bool private isLpToken0Native;
    // Flag to track if token1 is a native token
    bool private isLpToken1Native;

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
     * @param _isHTStoken0 flag indicating if token0 is a Hedera Token Service token.
     * @param _isHTStoken1 flag indicating if token1 is a Hedera Token Service token.
     * @param _beefyOracle the address of the Beefy Oracle contract.
     */
    function initialize(
        IStrategyMultiToken _strategy,
        address _pool,
        string memory _name,
        string memory _symbol,
        uint256 _approvalDelay,
        bool _isHTStoken0,
        bool _isHTStoken1,
        bool _isLpToken0Native,
        bool _isLpToken1Native,
        address _beefyOracle
    ) public initializer {
        __ERC20_init(_name, _symbol);
        __Ownable_init();
        __ReentrancyGuard_init();
        strategy = _strategy;
        pool = IUniswapV3Pool(_pool);
        approvalDelay = _approvalDelay;
        isHTStoken0 = _isHTStoken0;
        isHTStoken1 = _isHTStoken1;
        isLpToken0Native = _isLpToken0Native;
        isLpToken1Native = _isLpToken1Native;
        token0Associated = false;
        token1Associated = false;
        beefyOracle = _beefyOracle;

        // If using HTS tokens, check and associate tokens with this contract
        if (isHTStoken0) {
            associateToken(address(pool.token0()));
        }
        
        if (isHTStoken1) {
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
     * @dev Helper function to get token balance
     * @param token The token address
     * @param isNative Flag indicating if the token is a native token
     * @return The balance of the token held by the contract
     */
    function _getTokenBalance(address token, bool isNative) internal view returns (uint256) {
        if (isNative) {
            // For native tokens, use address(this).balance
            return address(this).balance;
        } else {
            // For ERC20 and HTS tokens, use standard balanceOf
            return IERC20Upgradeable(token).balanceOf(address(this));
        }
    }

    /**
     * @dev It calculates the total underlying value of {token0} held by the system.
     * It takes into account the vault contract balance, the strategy contract balance
     * and the balance deployed in other contracts as part of the strategy.
     */
    function balance0() public view returns (uint256) {
        return _getTokenBalance(address(token0()), isLpToken0Native) + IStrategyMultiToken(strategy).totalBalanceOfToken0();
    }

    /**
     * @dev It calculates the total underlying value of {token1} held by the system.
     * It takes into account the vault contract balance, the strategy contract balance
     * and the balance deployed in other contracts as part of the strategy.
     */
    function balance1() public view returns (uint256) {
        return _getTokenBalance(address(token1()), isLpToken1Native) + IStrategyMultiToken(strategy).totalBalanceOfToken1();
    }

    /**
     * @dev Function for various UIs to display the current value of one of our yield tokens.
     * Returns an uint256 with 18 decimals of how much underlying asset one vault share represents.
     * Uses token0 as the reference token.
     */
    function getPricePerFullShare() public view returns (uint256) {
        return totalSupply() == 0 ? 1e18 : balance0() * 1e18 / totalSupply();
    }

    // /**
    //  * @dev A helper function to call deposit() with all the sender's funds.
    //  */
    // function depositAll() external {
    //     deposit(token0().balanceOf(msg.sender), token1().balanceOf(msg.sender));
    // }

    /**
     * @dev The entrypoint of funds into the system. People deposit with this function
     * into the vault. The vault is then in charge of sending funds into the strategy.
     */
    function deposit(uint _amount0, uint _amount1) public payable nonReentrant {
        strategy.beforeDeposit();
        // Get current token prices
        (uint256 price0, uint256 price1) = getTokenPrices();
        
        if (_amount0 > 0) {
           if (isHTStoken0 && !isLpToken0Native) {
                // For HTS tokens, check association and transfer
                address token = address(token0());
                _transferTokens(token, msg.sender, address(this), _amount0, true, false);
            } else if(!isHTStoken0 && !isLpToken0Native){
                // For ERC20 tokens, use standard SafeERC20 transfer
                token0().safeTransferFrom(msg.sender, address(this), _amount0);
            }
        }
        
        if (_amount1 > 0) {
            if (isHTStoken1 && !isLpToken1Native) {
                // For HTS tokens, check association and transfer
                address token = address(token1());
                _transferTokens(token, msg.sender, address(this), _amount1, true, false);
            } else if(!isHTStoken1 && !isLpToken1Native){
                // For ERC20 tokens, use standard SafeERC20 transfer
                token1().safeTransferFrom(msg.sender, address(this), _amount1);
            }
        }
        
        (uint256 lp0Deposit, uint256 lp1Deposit) = earn();
        
        // Calculate shares based on deposited amounts since strategy immediately deploys tokens
        uint256 shares = 0;
        uint256 value0 = (lp0Deposit * price0) / 1e18;
        uint256 value1 = (lp1Deposit * price1) / 1e18;
        if (totalSupply() == 0) {
            // For first deposit, calculate total value in USD (normalized to 18 decimals)
            shares = value0 + value1;
        } else {
            // Calculate value of deposited tokens (normalized to 18 decimals)
            uint256 totalValue = value0 + value1;
            uint256 _pool0 = balance0() - lp0Deposit;
            uint256 _pool1 = balance1() - lp1Deposit;
            
            // Calculate value of existing pool (normalized to 18 decimals)
            uint256 poolValue0 = (_pool0 * price0) / 1e18;
            uint256 poolValue1 = (_pool1 * price1) / 1e18;
            uint256 totalPoolValue = poolValue0 + poolValue1;
            
            // Calculate shares based on total value proportion
            shares = totalValue > 0 ? (totalValue * totalSupply()) / totalPoolValue : 0;
        }
        
        _mint(msg.sender, shares);
    }

    /**
     * @dev Function to send funds into the strategy and put them to work. It's primarily called
     * by the vault's deposit() function.
     */
    function earn() public returns (uint256 lp0Deposit, uint256 lp1Deposit) {
        uint _bal0 = _getTokenBalance(address(token0()), isLpToken0Native);
        uint _bal1 = _getTokenBalance(address(token1()), isLpToken1Native);
        
        if (_bal0 > 0) {
            if (isHTStoken0 && !isLpToken0Native) {            
                // Transfer tokens to strategy
                address token = address(token0());
                _transferTokens(token, address(this), address(strategy), _bal0, true, false);
            } else if(!isHTStoken0) {
                // For ERC20 tokens, use standard SafeERC20 transfer
                token0().safeTransfer(address(strategy), _bal0);
            }
        }
        
        if (_bal1 > 0) {
            if (isHTStoken1 && !isLpToken1Native) {            
                // Transfer tokens to strategy
                address token = address(token1());
                _transferTokens(token, address(this), address(strategy), _bal1, true, false);
            } else if(!isHTStoken1) {
                // For ERC20 tokens, use standard SafeERC20 transfer
                token1().safeTransfer(address(strategy), _bal1);
            }
        }
        uint hbarValue = isLpToken0Native ? _bal0 : isLpToken1Native ? _bal1 : 0;
        (lp0Deposit, lp1Deposit) = strategy.deposit{value: hbarValue}();
    }

    // /**
    //  * @dev A helper function to call withdraw() with all the sender's funds.
    //  */
    // function withdrawAll() external {
    //     withdraw(balanceOf(msg.sender));
    // }

    /**
     * @dev Function to exit the system. The vault will withdraw the required tokens
     * from the strategy and pay up the token holder. A proportional number of IOU
     * tokens are burned in the process.
     */
    function withdraw(uint256 _shares) public {
        uint256 r0 = (balance0() * _shares) / totalSupply();
        uint256 r1 = (balance1() * _shares) / totalSupply();
        _burn(msg.sender, _shares);

        // Calculate how much we need to withdraw from strategy
        uint256 _withdraw0 = 0;
        uint256 _withdraw1 = 0;
        uint b0 = _getTokenBalance(address(token0()), isLpToken0Native);
        uint b1 = _getTokenBalance(address(token1()), isLpToken1Native);
        
        if (b0 < r0) {
            _withdraw0 = r0 - b0;
        }
        
        if (b1 < r1) {
            _withdraw1 = r1 - b1;
        }

        // Withdraw from strategy if needed
        if (_withdraw0 > 0 || _withdraw1 > 0) {
            strategy.withdraw(_withdraw0, _withdraw1);
            
            // Check actual amounts received and adjust if necessary
            uint _after0 = _getTokenBalance(address(token0()), isLpToken0Native);
            uint _after1 = _getTokenBalance(address(token1()), isLpToken1Native);
            
            uint _diff0 = _after0 - b0;
            uint _diff1 = _after1 - b1;
            
            // Adjust withdrawal amounts if we didn't get enough
            if (_diff0 < _withdraw0) {
                r0 = b0 + _diff0;
            }
            
            if (_diff1 < _withdraw1) {
                r1 = b1 + _diff1;
            }
        }
        // Transfer token0 to user
        if (r0 > 0) {
            if (isLpToken0Native) {
                // For native tokens, use native transfer
                _transferTokens(address(0), address(this), msg.sender, r0, false, true);
            } else if (isHTStoken0 && !isLpToken0Native) {
                address token = address(token0());
                _transferTokens(token, address(this), msg.sender, r0, true, false);
            } else {
                token0().safeTransfer(msg.sender, r0);
            }
        }

        // Transfer token1 to user
        if (r1 > 0) {
            if (isLpToken1Native) {
                // For native tokens, use native transfer
                _transferTokens(address(0), address(this), msg.sender, r1, false, true);
            } else if (isHTStoken1 && !isLpToken1Native) {
                address token = address(token1());
                _transferTokens(token, address(this), msg.sender, r1, true, false);
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
        require(address(this) == IStrategyMultiToken(_implementation).vault(), "Inv prop");
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
        require(stratCandidate.implementation != address(0), "No Cand");
        require(stratCandidate.proposedTime + approvalDelay < block.timestamp, "Delay nt pass");

        emit UpgradeStrat(stratCandidate.implementation);

        strategy.retireStrat();
        strategy = IStrategyMultiToken(stratCandidate.implementation);
        stratCandidate.implementation = address(0);
        stratCandidate.proposedTime = 5000000000;
        
        // Associate the new strategy with the tokens if they're Hedera tokens
        if (isHTStoken0 && !token0Associated) {
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
        
        if (isHTStoken1 && !token1Associated) {
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
     * @dev Helper function to transfer tokens - handles native, HTS, and ERC20 tokens
     * @param token The token address
     * @param from The sender address
     * @param to The recipient address
     * @param amount The amount to transfer
     * @param isHTS Whether the token is an HTS token
     * @param isNative Whether the token is a native token
     */
    function _transferTokens(address token, address from, address to, uint256 amount, bool isHTS, bool isNative) internal {
        if (isNative) {
            // For native tokens, use native transfer like ETH
            AddressUpgradeable.sendValue(payable(to), amount);
        } else if (isHTS) {
            // For HTS tokens, use HTS precompile
            (bool success, bytes memory result) = HTS_PRECOMPILE.call(
                abi.encodeWithSelector(IHederaTokenService.transferToken.selector, token, from, to, int64(uint64(amount)))
            );
            int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
            if (responseCode != HTS_SUCCESS) {
                emit HTSTokenTransferFailed(token, from, to, responseCode);
                revert("HTS TRF F");
            }
        } else {
            // For ERC20 tokens, use standard transfer
            if (from == address(this)) {
                IERC20Upgradeable(token).safeTransfer(to, amount);
            } else {
                IERC20Upgradeable(token).safeTransferFrom(from, to, amount);
            }
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
        require(responseCode == HTS_SUCCESS, "Assoc fail");
    }

    /**
     * @dev Rescues random funds stuck that the strat can't handle.
     * @param _token address of the token to rescue.
     */
    function inCaseTokensGetStuck(address _token) external onlyOwner {
        require(_token != address(token0()) && _token != address(token1()), "!token");

        if (_token == address(0)) {
            // For rescuing native tokens
            uint256 amount = address(this).balance;
            _transferTokens(address(0), address(this), msg.sender, amount, false, true);
        } else if (isHTStoken0 || isHTStoken1) {
            // For rescuing HTS tokens
            uint256 amount = IERC20Upgradeable(_token).balanceOf(address(this));
            _transferTokens(_token, address(this), msg.sender, amount, true, false);
        } else {
            // For rescuing ERC20 tokens
            uint256 amount = IERC20Upgradeable(_token).balanceOf(address(this));
            IERC20Upgradeable(_token).safeTransfer(msg.sender, amount);
        }
    }

    /**
     * @dev Update the isHTStoken0 flag if needed
     * This would only be used in very specific migration scenarios
     * @param _isHTStoken0 The new value for isHTStoken0
     */
    function setisHTStoken0(bool _isHTStoken0) external onlyOwner {
        isHTStoken0 = _isHTStoken0;
    }

    /**
     * @dev Update the isHTStoken1 flag if needed
     * This would only be used in very specific migration scenarios
     * @param _isHTStoken1 The new value for isHTStoken1
     */
    function setisHTStoken1(bool _isHTStoken1) external onlyOwner {
        isHTStoken1 = _isHTStoken1;
    }

    /**
     * @dev Update the isLpToken0Native flag if needed
     * @param _isLpToken0Native The new value for isLpToken0Native
     */
    function setIsLpToken0Native(bool _isLpToken0Native) external onlyOwner {
        isLpToken0Native = _isLpToken0Native;
    }

    /**
     * @dev Update the isLpToken1Native flag if needed
     * @param _isLpToken1Native The new value for isLpToken1Native
     */
    function setIsLpToken1Native(bool _isLpToken1Native) external onlyOwner {
        isLpToken1Native = _isLpToken1Native;
    }

    function getTokenPrices() internal view returns (uint256 price0, uint256 price1) {
        // Get token0 price
        try IBeefyOracle(beefyOracle).getPrice(address(token0())) returns (uint256 p0) {
            price0 = p0;
        } catch {
            revert("T0 price fail");
        }

        // Get token1 price
        try IBeefyOracle(beefyOracle).getPrice(address(token1())) returns (uint256 p1) {
            price1 = p1;
        } catch {
            revert("T1 price fail");
        }
    }

    receive() external payable {}
}
