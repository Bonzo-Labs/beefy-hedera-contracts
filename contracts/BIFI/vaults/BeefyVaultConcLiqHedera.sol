// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20Metadata} from "@openzeppelin-4/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {SafeERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {AddressUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import {IStrategyConcLiq} from "../interfaces/beefy/IStrategyConcLiq.sol";
import {IHederaTokenService} from "../Hedera/IHederaTokenService.sol";
import {IBeefyOracle} from "../interfaces/oracle/IBeefyOracle.sol";
import {IWHBAR} from "../Hedera/IWHBAR.sol";

/**
 * @dev CLM vault for Hedera with HTS token support and HBAR/WHBAR integration.
 */
contract BeefyVaultConcLiqHedera is ERC20PermitUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using AddressUpgradeable for address payable;

    /// @notice The strategy currently in use by the vault.
    IStrategyConcLiq public strategy;

    /// @notice The initial shares that are burned as part of the first vault deposit.
    uint256 private constant MINIMUM_SHARES = 10 ** 3;

    /// @notice The precision used to calculate the shares.
    uint256 private constant PRECISION = 1e36;

    /// @notice The address we are sending the burned shares to.
    address private constant BURN_ADDRESS = 0x0000000000000000000000000000000000000000;

    /// @notice Address of the Hedera Token Service precompile
    address private constant HTS_PRECOMPILE = address(0x167);

    /// @notice HTS success response code
    int64 private constant HTS_SUCCESS = 22;

    /// @notice Error code when binding to the HTS precompile fails.
    int64 private constant PRECOMPILE_BIND_ERROR = -1;

    //testnet
    address private constant WHBAR_CONTRACT = 0x0000000000000000000000000000000000003aD1;
    address private constant WHBAR_TOKEN = 0x0000000000000000000000000000000000003aD2;

    // //mainnet
    // address private constant WHBAR_CONTRACT = 0x0000000000000000000000000000000000163B59;
    // address private constant WHBAR_TOKEN = 0x0000000000000000000000000000000000163B5a;

    /// @notice Beefy Oracle for token pricing
    address public beefyOracle;

    // Errors
    error NoShares();
    error TooMuchSlippage();
    error NotEnoughTokens();
    error InvalidTokenAddress();
    error HTSTransferFailed();
    error HTSAssociationFailed();
    error PriceOracleFailed();
    error WHBARWrapFailed();
    error WHBARUnwrapFailed();
    error InvalidNativeAmount();
    error OnlyHBARWHBARPools();

    // Events
    event Deposit(address indexed user, uint256 shares, uint256 amount0, uint256 amount1, uint256 fee0, uint256 fee1);
    event Withdraw(address indexed user, uint256 shares, uint256 amount0, uint256 amount1);
    event HTSTokenAssociated(address token, int64 responseCode);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);
    event HBARWrapped(address user, uint256 hbarAmount, uint256 whbarAmount);
    event WHBARUnwrapped(address user, uint256 whbarAmount, uint256 hbarAmount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the vault, sets the strategy name and creates a new token.
     */
    function initialize(
        address _strategy,
        string calldata _name,
        string calldata _symbol,
        address _beefyOracle
    ) external initializer {
        __ERC20_init(_name, _symbol);
        __ERC20Permit_init(_name);
        __Ownable_init();
        __ReentrancyGuard_init();

        strategy = IStrategyConcLiq(_strategy);
        beefyOracle = _beefyOracle;

        // Associate both tokens with this contract
        address token0 = strategy.lpToken0();
        address token1 = strategy.lpToken1();

        _associateToken(token0);
        _associateToken(token1);
    }

    /**
     * @notice returns whether the pool is calm for deposits
     * @return boolean true if the pool is calm
     */
    function isCalm() external view returns (bool) {
        return strategy.isCalm();
    }

    /**
     * @notice The fee for swaps in the underlying pool in 18 decimals
     * @return uint256 swap fee for the underlying pool
     */
    function swapFee() public view returns (uint256) {
        return strategy.swapFee();
    }

    /**
     * @notice returns the concentrated liquidity pool address
     * @return _want the address of the concentrated liquidity pool
     */
    function want() external view returns (address _want) {
        return strategy.pool();
    }

    /**
     * @notice Check if a token is WHBAR HTS token
     */
    function isWHBAR(address token) public pure returns (bool) {
        return token == WHBAR_TOKEN;
    }

    /**
     * @notice Check if we can accept native HBAR for a token
     * @param token The token address to check
     * @return true if the token is WHBAR and we can wrap native HBAR
     */
    function canWrapHBAR(address token) public pure returns (bool) {
        return isWHBAR(token);
    }

    /** @notice returns the tokens that the strategy wants
     * @return token0 the address of the first token
     * @return token1 the address of the second token
     */
    function wants() public view returns (address token0, address token1) {
        token0 = strategy.lpToken0();
        token1 = strategy.lpToken1();
    }

    /**
     * @notice Returns total underlying token balances.
     */
    function balances() public view returns (uint amount0, uint amount1) {
        (amount0, amount1) = IStrategyConcLiq(strategy).balances();
    }

    /**
     * @notice Preview withdrawal amounts for given shares.
     */
    function previewWithdraw(uint256 _shares) external view returns (uint256 amount0, uint256 amount1) {
        (uint bal0, uint bal1) = balances();

        uint256 _totalSupply = totalSupply();
        amount0 = (bal0 * _shares) / _totalSupply;
        amount1 = (bal1 * _shares) / _totalSupply;
    }

    /**
     * @notice Preview deposit shares and fees.
     */
    function previewDeposit(
        uint256 _amount0,
        uint256 _amount1
    ) external view returns (uint256 shares, uint256 amount0, uint256 amount1, uint256 fee0, uint256 fee1) {
        uint256 price = strategy.price();

        (uint bal0, uint bal1) = balances();

        (amount0, amount1, fee0, fee1) = _getTokensRequired(price, _amount0, _amount1, bal0, bal1, swapFee());

        uint256 _totalSupply = totalSupply();

        if (_totalSupply == 0) {
            bal0 = _amount0;
            bal1 = _amount1;
        }

        shares = (amount1 - fee1) + (((amount0 - fee0) * price) / PRECISION);

        if (_totalSupply > 0) {
            // How much of wants() do we have in token 1 equivalents;
            uint256 token1EquivalentBalance = ((((bal0 + fee0) * price) + PRECISION - 1) / PRECISION) + (bal1 + fee1);
            shares = (shares * _totalSupply) / token1EquivalentBalance;
        } else {
            // First user donates MINIMUM_SHARES for security of the vault.
            shares = shares - MINIMUM_SHARES;
        }
    }

    /// @notice Calculate optimal deposit amounts and fees.
    function _getTokensRequired(
        uint256 _price,
        uint256 _amount0,
        uint256 _amount1,
        uint256 _bal0,
        uint256 _bal1,
        uint256 _swapFee
    ) private pure returns (uint256 depositAmount0, uint256 depositAmount1, uint256 feeAmount0, uint256 feeAmount1) {
        // get the amount of bal0 that is equivalent to bal1
        if (_bal0 == 0 && _bal1 == 0) return (_amount0, _amount1, 0, 0);

        uint256 bal0InBal1 = (_bal0 * _price) / PRECISION;

        // check which side is lower and supply as much as possible
        if (_bal1 < bal0InBal1) {
            uint256 owedAmount0 = _bal1 + _amount1 > bal0InBal1
                ? ((_bal1 + _amount1 - bal0InBal1) * PRECISION) / _price
                : 0;

            if (owedAmount0 > _amount0) {
                depositAmount0 = _amount0;
                depositAmount1 = _amount1 - (((owedAmount0 - _amount0) * _price) / PRECISION);
            } else {
                depositAmount0 = owedAmount0;
                depositAmount1 = _amount1;
            }

            uint256 fill = _amount1 < (bal0InBal1 - _bal1) ? _amount1 : (bal0InBal1 - _bal1);
            uint256 slidingFee = (bal0InBal1 * PRECISION + (owedAmount0 * _price)) /
                (bal0InBal1 + _bal1 + fill + ((2 * owedAmount0 * _price) / PRECISION));

            feeAmount1 = (fill * ((_swapFee * slidingFee) / PRECISION)) / 1e18;
        } else {
            uint256 owedAmount1 = bal0InBal1 + ((_amount0 * _price) / PRECISION) > _bal1
                ? bal0InBal1 + ((_amount0 * _price) / PRECISION) - _bal1
                : 0;

            if (owedAmount1 > _amount1) {
                depositAmount0 = _amount0 - (((owedAmount1 - _amount1) * PRECISION) / _price);
                depositAmount1 = _amount1;
            } else {
                depositAmount0 = _amount0;
                depositAmount1 = owedAmount1;
            }

            uint256 fill = _amount0 < ((_bal1 - bal0InBal1) * PRECISION) / _price
                ? _amount0
                : ((_bal1 - bal0InBal1) * PRECISION) / _price;
            uint256 slidingFee = ((_bal1 + owedAmount1) * PRECISION) /
                (bal0InBal1 + _bal1 + ((fill * _price) / PRECISION) + (2 * owedAmount1));

            feeAmount0 = (fill * ((_swapFee * slidingFee) / PRECISION)) / 1e18;
        }
    }

    /**
     * @notice Deposit tokens into vault. Supports native HBAR for WHBAR deposits.
     */
    function deposit(uint256 _amount0, uint256 _amount1, uint256 _minShares) public payable nonReentrant {
        (address token0, address token1) = wants();

        // Have the strategy remove all liquidity from the pool.
        strategy.beforeAction();

        // Transfer funds from user to strategy.
        (uint256 _bal0, uint256 _bal1) = balances();
        uint256 price = strategy.price();
        (uint256 amount0, uint256 amount1, uint256 fee0, uint256 fee1) = _getTokensRequired(
            price,
            _amount0,
            _amount1,
            _bal0,
            _bal1,
            swapFee()
        );
        if (amount0 > _amount0 || amount1 > _amount1) revert NotEnoughTokens();

        if (amount0 > 0) {
            _transferTokens(token0, msg.sender, address(strategy), amount0, false);
        }
        if (amount1 > 0) {
            _transferTokens(token1, msg.sender, address(strategy), amount1, false);
        }

        {
            // scope to avoid stack too deep errors
            (uint256 _after0, uint256 _after1) = balances();
            amount0 = _after0 - _bal0;
            amount1 = _after1 - _bal1;
        }

        strategy.deposit();
        uint256 shares = (amount1 - fee1) + (((amount0 - fee0) * price) / PRECISION);

        uint256 _totalSupply = totalSupply();
        if (_totalSupply > 0) {
            // How much of wants() do we have in token 1 equivalents;
            shares =
                (shares * _totalSupply) /
                (((((_bal0 + fee0) * price) + PRECISION - 1) / PRECISION) + (_bal1 + fee1));
        } else {
            // First user donates MINIMUM_SHARES for security of the vault.
            shares = shares - MINIMUM_SHARES;
            _mint(BURN_ADDRESS, MINIMUM_SHARES); // permanently lock the first MINIMUM_SHARES
        }

        if (shares < _minShares) revert TooMuchSlippage();
        if (shares == 0) revert NoShares();

        _mint(msg.sender, shares);
        emit Deposit(msg.sender, shares, amount0, amount1, fee0, fee1);
    }

    /**
     * @dev A helper function to call withdraw() with all the sender's funds.
     * @param _minAmount0 the minimum amount of token0 that the user wants to recieve with slippage.
     * @param _minAmount1 the minimum amount of token1 that the user wants to recieve with slippage.
     */
    function withdrawAll(uint256 _minAmount0, uint256 _minAmount1) external {
        withdraw(balanceOf(msg.sender), _minAmount0, _minAmount1);
    }

    /**
     * @dev Helper function to withdraw all funds and receive native HBAR for WHBAR tokens
     */
    function withdrawAllAsHBAR(uint256 _minAmount0, uint256 _minAmount1) external {
        withdrawAsHBAR(balanceOf(msg.sender), _minAmount0, _minAmount1);
    }

    /**
     * @notice Withdraw tokens from vault as WHBAR tokens.
     */
    function withdraw(uint256 _shares, uint256 _minAmount0, uint256 _minAmount1) public {
        if (_shares == 0) revert NoShares();

        // Withdraw All Liquidity to Strat for Accounting.
        strategy.beforeAction();

        uint256 _totalSupply = totalSupply();
        _burn(msg.sender, _shares);

        (uint256 _bal0, uint256 _bal1) = balances();

        uint256 _amount0 = (_bal0 * _shares) / _totalSupply;
        uint256 _amount1 = (_bal1 * _shares) / _totalSupply;

        strategy.withdraw(_amount0, _amount1);

        if (_amount0 < _minAmount0 || _amount1 < _minAmount1 || (_amount0 == 0 && _amount1 == 0))
            revert TooMuchSlippage();

        (address token0, address token1) = wants();
        if (_amount0 > 0) {
            _transferTokens(token0, address(this), msg.sender, _amount0, true);
        }
        if (_amount1 > 0) {
            _transferTokens(token1, address(this), msg.sender, _amount1, true);
        }

        emit Withdraw(msg.sender, _shares, _amount0, _amount1);
    }

    /**
     * @notice Withdraw tokens from vault as native HBAR (unwraps WHBAR).
     * @dev Only works with HBAR/WHBAR pools. At least one token must be WHBAR for this function to work.
     *      For other HTS tokens, use the regular withdraw() function.
     * @param _shares The number of vault shares to withdraw
     * @param _minAmount0 Minimum amount of token0 to receive (slippage protection)
     * @param _minAmount1 Minimum amount of token1 to receive (slippage protection)
     */
    function withdrawAsHBAR(uint256 _shares, uint256 _minAmount0, uint256 _minAmount1) public {
        if (_shares == 0) revert NoShares();

        // Validate this function is only used with HBAR/WHBAR pools
        (address token0, address token1) = wants();
        if (!isWHBAR(token0) && !isWHBAR(token1)) {
            revert OnlyHBARWHBARPools();
        }

        // Withdraw All Liquidity to Strat for Accounting.
        strategy.beforeAction();

        uint256 _totalSupply = totalSupply();
        _burn(msg.sender, _shares);

        (uint256 _bal0, uint256 _bal1) = balances();

        uint256 _amount0 = (_bal0 * _shares) / _totalSupply;
        uint256 _amount1 = (_bal1 * _shares) / _totalSupply;

        strategy.withdraw(_amount0, _amount1);

        if (_amount0 < _minAmount0 || _amount1 < _minAmount1 || (_amount0 == 0 && _amount1 == 0))
            revert TooMuchSlippage();

        // Handle token0 - unwrap WHBAR to HBAR if applicable
        if (_amount0 > 0) {
            if (isWHBAR(token0)) {
                _unwrapWHBAR(_amount0);
                AddressUpgradeable.sendValue(payable(msg.sender), _amount0);
            } else {
                _transferTokens(token0, address(this), msg.sender, _amount0, true);
            }
        }

        // Handle token1 - unwrap WHBAR to HBAR if applicable
        if (_amount1 > 0) {
            if (isWHBAR(token1)) {
                _unwrapWHBAR(_amount1);
                AddressUpgradeable.sendValue(payable(msg.sender), _amount1);
            } else {
                _transferTokens(token1, address(this), msg.sender, _amount1, true);
            }
        }

        emit Withdraw(msg.sender, _shares, _amount0, _amount1);
    }

    /**
     * @notice Wrap HBAR to WHBAR using the WHBAR contract
     * @param amount The amount of HBAR to wrap
     * @return The amount of WHBAR received
     */
    function _wrapHBAR(uint256 amount) internal returns (uint256) {
        if (amount == 0) return 0;

        address _whbarContract = WHBAR_CONTRACT;
        address _whbarToken = WHBAR_TOKEN;

        if (_whbarContract == address(0)) revert WHBARWrapFailed();

        uint256 whbarBefore = IERC20Upgradeable(_whbarToken).balanceOf(address(this));

        try IWHBAR(_whbarContract).deposit{value: amount}() {
            uint256 whbarAfter = IERC20Upgradeable(_whbarToken).balanceOf(address(this));
            uint256 whbarReceived = whbarAfter - whbarBefore;

            emit HBARWrapped(msg.sender, amount, whbarReceived);
            return whbarReceived;
        } catch {
            revert WHBARWrapFailed();
        }
    }

    /**
     * @notice Unwrap WHBAR to HBAR using the WHBAR contract
     * @param amount The amount of WHBAR to unwrap
     * @return The amount of HBAR received
     */
    function _unwrapWHBAR(uint256 amount) internal returns (uint256) {
        if (amount == 0) return 0;

        address _whbarContract = WHBAR_CONTRACT;
        if (_whbarContract == address(0)) revert WHBARUnwrapFailed();

        uint256 hbarBefore = address(this).balance;

        try IWHBAR(_whbarContract).withdraw(amount) {
            uint256 hbarAfter = address(this).balance;
            uint256 hbarReceived = hbarAfter - hbarBefore;

            emit WHBARUnwrapped(msg.sender, amount, hbarReceived);
            return hbarReceived;
        } catch {
            revert WHBARUnwrapFailed();
        }
    }

    /**
     * @notice Helper function to transfer tokens - handles native HBAR, WHBAR wrapping, and HTS tokens
     * @param token The token address
     * @param from The sender address
     * @param to The recipient address
     * @param amount The amount to transfer
     * @param isFromContract Whether the transfer is from this contract
     */
    function _transferTokens(address token, address from, address to, uint256 amount, bool isFromContract) internal {
        if (token == address(0)) revert InvalidTokenAddress();
        if (amount == 0) return;

        // Check if this is a WHBAR transfer that might need HBAR wrapping/unwrapping
        if (isWHBAR(token)) {
            if (!isFromContract && msg.value > 0) {
                // User sent native HBAR for WHBAR deposit - wrap it
                if (msg.value < amount) revert InvalidNativeAmount();

                // Wrap HBAR to WHBAR
                uint256 wrappedAmount = _wrapHBAR(amount);

                // Transfer WHBAR to destination
                if (to != address(this)) {
                    IERC20Upgradeable(token).safeTransfer(to, wrappedAmount);
                }

                // Return excess HBAR if any
                if (msg.value > amount) {
                    AddressUpgradeable.sendValue(payable(msg.sender), msg.value - amount);
                }
                return;
            } else if (isFromContract) {
                // Normal WHBAR transfer from contract
                IERC20Upgradeable(token).safeTransfer(to, amount);
                return;
            } else {
                // Normal WHBAR transfer from user
                IERC20Upgradeable(token).safeTransferFrom(from, to, amount);
                return;
            }
        }

        bool isNative = (token == strategy.native());

        if (isNative) {
            // For native tokens (HBAR), use native transfer
            if (isFromContract) {
                AddressUpgradeable.sendValue(payable(to), amount);
            } else {
                // When receiving native tokens, they should come with msg.value
                require(msg.value >= amount, "Insufficient native token sent");
            }
        } else {
            // All other tokens on Hedera are HTS tokens, use HTS precompile
            _transferHTS(token, from, to, amount);
        }
    }

    /**
     * @notice Transfer HTS tokens using standard ERC20 transferFrom
     * @param token The HTS token address
     * @param from The sender address
     * @param to The recipient address
     * @param amount The amount to transfer
     */
    function _transferHTS(address token, address from, address to, uint256 amount) internal {
        // Use standard ERC20 transferFrom for HTS tokens
        IERC20Upgradeable(token).safeTransferFrom(from, to, amount);
    }

    /**
     * @notice Associate this contract with an HTS token
     * @param token The HTS token address to associate with this contract
     */
    function _associateToken(address token) internal {
        if (token == address(0)) revert InvalidTokenAddress();

        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;

        if (responseCode != HTS_SUCCESS) {
            revert HTSAssociationFailed();
        }

        emit HTSTokenAssociated(token, responseCode);
    }

    /**
     * @dev Allow the owner to manually associate this contract with an HTS token
     * This can be useful if the contract needs to handle a new token or if token association failed
     * @param token The HTS token address to associate with this contract
     */
    function associateToken(address token) external onlyOwner {
        _associateToken(token);
    }

    /**
     * @dev Rescues random funds stuck that the strat can't handle.
     * @param _token address of the token to rescue.
     */
    function inCaseTokensGetStuck(address _token) external onlyOwner {
        (address token0, address token1) = wants();
        require(_token != token0 && _token != token1, "Cannot rescue want tokens");

        if (_token == address(0)) {
            // For rescuing native tokens
            uint256 amount = address(this).balance;
            if (amount > 0) {
                AddressUpgradeable.sendValue(payable(msg.sender), amount);
            }
        } else {
            // For rescuing ERC20/HTS tokens
            uint256 amount = IERC20Upgradeable(_token).balanceOf(address(this));
            if (amount > 0) {
                IERC20Upgradeable(_token).safeTransfer(msg.sender, amount);
            }
        }
    }

    /**
     * @notice Update the Beefy Oracle address
     * @param _beefyOracle The new Beefy Oracle address
     */
    function setBeefyOracle(address _beefyOracle) external onlyOwner {
        require(_beefyOracle != address(0), "Invalid oracle address");
        beefyOracle = _beefyOracle;
    }

    /**
     * @notice Receive function to accept native token deposits
     */
    receive() external payable {}
}
