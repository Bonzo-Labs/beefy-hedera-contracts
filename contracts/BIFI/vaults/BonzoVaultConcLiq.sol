// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IERC20Metadata} from "@openzeppelin-4/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {SafeERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import {AddressUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import {IStrategyConcLiq} from "../interfaces/beefy/IStrategyConcLiq.sol";
import {IHederaTokenService} from "../Hedera/IHederaTokenService.sol";
import {IBeefyOracle} from "../interfaces/oracle/IBeefyOracle.sol";
import {IWHBAR} from "../Hedera/IWHBAR.sol";
import "../utils/FullMath.sol";

contract BonzoVaultConcLiq is ERC20Upgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using AddressUpgradeable for address payable;

    IStrategyConcLiq public strategy;
    uint256 private constant MINIMUM_SHARES = 10 ** 3;
    uint256 private constant PRECISION = 1e18;
    address private constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    address private constant HTS_PRECOMPILE = address(0x167);
    int64 private constant HTS_SUCCESS = 22;
    int64 private constant PRECOMPILE_BIND_ERROR = -1;
    //testnet
    // address private constant WHBAR_CONTRACT = 0x0000000000000000000000000000000000003aD1;
    // address private constant WHBAR_TOKEN = 0x0000000000000000000000000000000000003aD2;
    //mainnet
    address private constant WHBAR_CONTRACT = 0x0000000000000000000000000000000000163B59;
    address private constant WHBAR_TOKEN = 0x0000000000000000000000000000000000163B5a;

    address public beefyOracle;
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
    error InsufficientHBARBalance(uint256 hbarBalance, uint256 hbarRequired);
    error SentAmt1LTFee1(uint256 sentAmount1, uint256 fee1);
    error SentAmt0LTFee0(uint256 sentAmount0, uint256 fee0);
    // Events
    event Deposit(
        address indexed user,
        uint256 shares,
        uint256 amount0,
        uint256 amount1,
        uint256 fee0,
        uint256 fee1,
        uint256 leftover0,
        uint256 leftover1
    );
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
     * @param _strategy The strategy contract address
     * @param _name The vault token name
     * @param _symbol The vault token symbol
     * @param _beefyOracle The Beefy Oracle address
     * @param _token0 The first token address to associate
     * @param _token1 The second token address to associate
     */
    function initialize(
        address _strategy,
        string calldata _name,
        string calldata _symbol,
        address _beefyOracle,
        address _token0,
        address _token1
    ) external initializer {
        __ERC20_init(_name, _symbol);
        __Ownable_init();
        __ReentrancyGuard_init();

        strategy = IStrategyConcLiq(_strategy);
        beefyOracle = _beefyOracle;

        // Associate the provided tokens with this contract
        if (_token0 != address(0)) {
            _safeAssociateToken(_token0);
        }
        if (_token1 != address(0)) {
            _safeAssociateToken(_token1);
        }
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
     * @notice Get the current mint fee required for SaucerSwap pool operations
     * @return mintFee The mint fee in tinybars (HBAR) required per mint operation
     */
    function getMintFee() public view returns (uint256 mintFee) {
        // Strategy contract has the getMintFee function
        try IStrategyConcLiq(address(strategy)).getMintFee() returns (uint256 fee) {
            return fee;
        } catch {
            return 0; // Return 0 if strategy doesn't support mint fees
        }
    }

    /**
     * @notice Estimate total HBAR required for a deposit (includes potential mint fees)
     * @return totalHBARRequired The total HBAR amount needed for this deposit
     */
    function estimateDepositHBARRequired() public view returns (uint256 totalHBARRequired) {
        uint256 mintFee = getMintFee();
        // We potentially need fees for both main and alt positions, so multiply by 2
        // TODO - revert this to 2 if needed
        return mintFee * 2;
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
        if (OwnableUpgradeable(address(strategy)).owner() == address(0)) {
            return (
                IERC20Upgradeable(strategy.lpToken0()).balanceOf(address(this)),
                IERC20Upgradeable(strategy.lpToken1()).balanceOf(address(this))
            );
        }
        (amount0, amount1) = IStrategyConcLiq(strategy).balances();
    }

    /**
     * @notice Preview withdrawal amounts for given shares.
     */
    function previewWithdraw(uint256 _shares) external view returns (uint256 amount0, uint256 amount1) {
        (uint bal0, uint bal1) = balances();

        uint256 _totalSupply = totalSupply();
        amount0 = FullMath.mulDiv(bal0, _shares, _totalSupply);
        amount1 = FullMath.mulDiv(bal1, _shares, _totalSupply);
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

        shares = (amount1 - fee1) + FullMath.mulDiv(amount0 - fee0, price, PRECISION);

        if (_totalSupply > 0) {
            // How much of wants() do we have in token 1 equivalents;
            uint256 token1EquivalentBalance = FullMath.mulDiv(bal0 + fee0, price, PRECISION) + (bal1 + fee1);
            shares = FullMath.mulDiv(shares, _totalSupply, token1EquivalentBalance);
        } else {
            // First user donates MINIMUM_SHARES for security of the vault.
            shares = shares - MINIMUM_SHARES;
        }
    }

    /**
     * @notice Preview deposit requirements including HBAR needed for mint fees.
     */
    function previewDepositWithHBAR(
        uint256 _amount0,
        uint256 _amount1
    )
        external
        view
        returns (uint256 shares, uint256 amount0, uint256 amount1, uint256 fee0, uint256 fee1, uint256 hbarRequired)
    {
        (shares, amount0, amount1, fee0, fee1) = this.previewDeposit(_amount0, _amount1);

        // Calculate HBAR requirements
        (address token0, address token1) = wants();
        uint256 whbarAmount = 0;
        if (isWHBAR(token0)) whbarAmount += _amount0;
        if (isWHBAR(token1)) whbarAmount += _amount1;

        uint256 mintFeeRequired = estimateDepositHBARRequired();
        hbarRequired = whbarAmount + mintFeeRequired;
    }

    function _getTokensRequired(
        uint256 /*_price*/,
        uint256 _amount0,
        uint256 _amount1,
        uint256 _bal0,
        uint256 _bal1,
        uint256 _swapFee
    ) private pure returns (uint256 depositAmount0, uint256 depositAmount1, uint256 feeAmount0, uint256 feeAmount1) {
        if (_bal0 == 0 && _bal1 == 0) {
            return (_amount0, _amount1, 0, 0);
        }

        depositAmount0 = _amount0;
        depositAmount1 = _amount1;

        if (_bal0 > 0 && _bal1 > 0) {
            uint256 poolRatio = FullMath.mulDiv(_bal1, PRECISION, _bal0);
            uint256 userRatio = FullMath.mulDiv(_amount1, PRECISION, _amount0);

            if (userRatio > poolRatio * 2) {
                feeAmount1 = FullMath.mulDiv(_amount1, _swapFee, 1e18);
            } else if (poolRatio > userRatio * 2) {
                feeAmount0 = FullMath.mulDiv(_amount0, _swapFee, 1e18);
            }
        }
    }

    /**
     * @notice Deposit tokens into vault. Supports native HBAR for WHBAR deposits and mint fees.
     */
    function deposit(uint256 _amount0, uint256 _amount1, uint256 _minShares) public payable nonReentrant {
        DepositVars memory vars;
        (vars.token0, vars.token1) = wants();

        // Initialize deposit variables
        _initializeDepositVars(vars, _amount0, _amount1, _minShares);

        // Validate and prepare deposit
        _prepareDeposit(vars, _amount0, _amount1);

        // Finalize deposit and calculate shares
        uint256 shares = _finalizeDeposit(vars);

        // Return excess HBAR and mint shares
        _completeDeposit(vars, shares, msg.sender);
    }

    /// @notice Struct to reduce stack depth in deposit function
    struct DepositVars {
        uint256 bal0;
        uint256 bal1;
        uint256 amount0;
        uint256 amount1;
        uint256 fee0;
        uint256 fee1;
        uint256 price;
        uint256 minShares;
        uint256 totalMintFeeRequired;
        uint256 whbarAmount;
        uint256 sentAmount0;
        uint256 sentAmount1;
        uint256 leftover0;
        uint256 leftover1;
        address token0;
        address token1;
    }

    /**
     * @notice Initialize deposit variables
     */
    function _initializeDepositVars(
        DepositVars memory vars,
        uint256 _amount0,
        uint256 _amount1,
        uint256 _minShares
    ) internal view {
        vars.totalMintFeeRequired = estimateDepositHBARRequired();
        vars.whbarAmount = 0;
        if (isWHBAR(vars.token0)) vars.whbarAmount += _amount0;
        if (isWHBAR(vars.token1)) vars.whbarAmount += _amount1;
        vars.minShares = _minShares;

        uint256 totalHBARRequired = vars.whbarAmount + vars.totalMintFeeRequired;
        if (msg.value < totalHBARRequired) revert InvalidNativeAmount();
    }

    /**
     * @notice Prepare deposit by validating amounts and transferring tokens
     */
    function _prepareDeposit(DepositVars memory vars, uint256 _amount0, uint256 _amount1) internal {
        strategy.beforeAction();

        (vars.bal0, vars.bal1) = balances();
        vars.price = strategy.price();
        (vars.amount0, vars.amount1, vars.fee0, vars.fee1) = _getTokensRequired(
            vars.price,
            _amount0,
            _amount1,
            vars.bal0,
            vars.bal1,
            swapFee()
        );
        if (vars.amount0 > _amount0 || vars.amount1 > _amount1) revert NotEnoughTokens();

        // Track sent amounts for reconciliation
        vars.sentAmount0 = vars.amount0;
        vars.sentAmount1 = vars.amount1;

        if (vars.amount0 > 0) {
            _transferTokens(vars.token0, msg.sender, address(strategy), vars.amount0, false);
        }
        if (vars.amount1 > 0) {
            _transferTokens(vars.token1, msg.sender, address(strategy), vars.amount1, false);
        }

        // Forward HBAR for mint fees to strategy if required
        if (vars.totalMintFeeRequired > 0) {
            uint256 hbarBalance = address(this).balance;
            if (hbarBalance < vars.totalMintFeeRequired) {
                revert InsufficientHBARBalance(hbarBalance, vars.totalMintFeeRequired);
            }
            AddressUpgradeable.sendValue(payable(address(strategy)), vars.totalMintFeeRequired);
        }
    }

    /**
     * @notice Complete deposit by returning excess HBAR and minting shares
     */
    function _completeDeposit(DepositVars memory vars, uint256 /* shares */, address recipient) internal {
        // Calculate shares based on sent amounts (no leftover handling)
        if (vars.sentAmount1 < vars.fee1) revert SentAmt1LTFee1(vars.sentAmount1, vars.fee1);
        if (vars.sentAmount0 < vars.fee0) revert SentAmt0LTFee0(vars.sentAmount0, vars.fee0);
        uint256 shares = (vars.sentAmount1 - vars.fee1) +
            FullMath.mulDiv(vars.sentAmount0 - vars.fee0, vars.price, PRECISION);

        uint256 _totalSupply = totalSupply();
        if (_totalSupply > 0) {
            // How much of wants() do we have in token 1 equivalents;
            shares = FullMath.mulDiv(
                shares,
                _totalSupply,
                FullMath.mulDiv(vars.bal0 + vars.fee0, vars.price, PRECISION) + (vars.bal1 + vars.fee1)
            );
        } else {
            // First user donates MINIMUM_SHARES for security of the vault.
            shares = shares - MINIMUM_SHARES;
            _mint(BURN_ADDRESS, MINIMUM_SHARES); // permanently lock the first MINIMUM_SHARES
        }

        if (shares < vars.minShares) revert TooMuchSlippage();
        if (shares == 0) revert NoShares();

        // Return leftover tokens to user if any
        if (vars.leftover0 > 0) {
            if (isWHBAR(vars.token0)) {
                _unwrapWHBAR(vars.leftover0);
                AddressUpgradeable.sendValue(payable(recipient), vars.leftover0);
            } else {
                _transferTokens(vars.token0, address(this), recipient, vars.leftover0, true);
            }
        }
        if (vars.leftover1 > 0) {
            if (isWHBAR(vars.token1)) {
                _unwrapWHBAR(vars.leftover1);
                AddressUpgradeable.sendValue(payable(recipient), vars.leftover1);
            } else {
                _transferTokens(vars.token1, address(this), recipient, vars.leftover1, true);
            }
        }

        // Return excess HBAR to user if any
        uint256 actualHBARUsed = vars.whbarAmount + vars.totalMintFeeRequired;
        if (msg.value > actualHBARUsed) {
            if (address(this).balance >= msg.value - actualHBARUsed) {
                AddressUpgradeable.sendValue(payable(recipient), msg.value - actualHBARUsed);
            }
        }

        _mint(recipient, shares);
        emit Deposit(
            recipient,
            shares,
            vars.sentAmount0,
            vars.sentAmount1,
            vars.fee0,
            vars.fee1,
            vars.leftover0,
            vars.leftover1
        );
    }

    /**
     * @notice Internal function to finalize deposit and calculate shares
     */
    function _finalizeDeposit(DepositVars memory vars) internal returns (uint256 shares) {
        {
            // scope to avoid stack too deep errors
            (uint256 _after0, uint256 _after1) = balances();
            vars.sentAmount0 = _after0 - vars.bal0; // Update sentAmount0 instead of amount0
            vars.sentAmount1 = _after1 - vars.bal1; // Update sentAmount1 instead of amount1
        }

        strategy.deposit();

        // Get leftover amounts from strategy
        (vars.leftover0, vars.leftover1) = strategy.getLeftoverAmounts();

        // Return leftovers to vault if any exist
        if (vars.leftover0 > 0 || vars.leftover1 > 0) {
            strategy.returnLeftovers(address(this));
        }

        return 0; // Placeholder, real calculation happens in _completeDeposit
    }

    function _prepareWithdraw() internal {
        if (OwnableUpgradeable(address(strategy)).owner() == address(0)) return;
        uint256 totalMintFeeRequired = estimateDepositHBARRequired();

        // Forward HBAR for mint fees to strategy if required
        if (totalMintFeeRequired > 0) {
            AddressUpgradeable.sendValue(payable(address(strategy)), totalMintFeeRequired);
        }
    }

    /**
     * @dev A helper function to call withdraw() with all the sender's funds.
     * @param _minAmount0 the minimum amount of token0 that the user wants to recieve with slippage.
     * @param _minAmount1 the minimum amount of token1 that the user wants to recieve with slippage.
     */
    function withdrawAll(uint256 _minAmount0, uint256 _minAmount1) external payable {
        withdraw(balanceOf(msg.sender), _minAmount0, _minAmount1);
    }

    /**
     * @dev Helper function to withdraw all funds and receive native HBAR for WHBAR tokens
     */
    function withdrawAllAsHBAR(uint256 _minAmount0, uint256 _minAmount1) external payable {
        _prepareWithdraw();
        withdrawAsHBAR(balanceOf(msg.sender), _minAmount0, _minAmount1);
    }

    /**
     * @notice Withdraw tokens from vault as WHBAR tokens.
     */
    function withdraw(uint256 _shares, uint256 _minAmount0, uint256 _minAmount1) public payable nonReentrant {
        _prepareWithdraw();
        if (_shares == 0) revert NoShares();

        // Withdraw All Liquidity to Strat for Accounting if strategy is not retired.
        if (OwnableUpgradeable(address(strategy)).owner() != address(0)) {
            strategy.beforeAction();
        }

        uint256 _totalSupply = totalSupply();
        _burn(msg.sender, _shares);

        (uint256 _bal0, uint256 _bal1) = balances();

        uint256 _amount0 = FullMath.mulDiv(_bal0, _shares, _totalSupply);
        uint256 _amount1 = FullMath.mulDiv(_bal1, _shares, _totalSupply);
        (address token0, address token1) = wants();

        if (
            IERC20Upgradeable(token0).balanceOf(address(this)) < _amount0 ||
            IERC20Upgradeable(token1).balanceOf(address(this)) < _amount1
        ) {
            strategy.withdraw(_amount0, _amount1);
        }

        if (_amount0 < _minAmount0 || _amount1 < _minAmount1 || (_amount0 == 0 && _amount1 == 0))
            revert TooMuchSlippage();

        if (_amount0 > 0) {
            if (token0 == strategy.native()) {
                //unwrap WHBAR to HBAR
                uint256 unwrappedAmount = _unwrapWHBAR(_amount0);
                AddressUpgradeable.sendValue(payable(msg.sender), unwrappedAmount);
            } else {
                _transferTokens(token0, address(this), msg.sender, _amount0, true);
            }
        }
        if (_amount1 > 0) {
            if (token1 == strategy.native()) {
                //unwrap WHBAR to HBAR
                uint256 unwrappedAmount = _unwrapWHBAR(_amount1);
                AddressUpgradeable.sendValue(payable(msg.sender), unwrappedAmount);
            } else {
                _transferTokens(token1, address(this), msg.sender, _amount1, true);
            }
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
    function withdrawAsHBAR(uint256 _shares, uint256 _minAmount0, uint256 _minAmount1) public nonReentrant {
        _prepareWithdraw();
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

        uint256 _amount0 = FullMath.mulDiv(_bal0, _shares, _totalSupply);
        uint256 _amount1 = FullMath.mulDiv(_bal1, _shares, _totalSupply);

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

        //approve WHBAR to be withdrawn
        IERC20Upgradeable(WHBAR_TOKEN).approve(_whbarContract, amount);

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
        if (from == address(this)) {
            IERC20Upgradeable(token).safeTransfer(to, amount);
        } else {
            IERC20Upgradeable(token).safeTransferFrom(from, to, amount);
        }
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

        // Emit event for all responses to aid debugging
        emit HTSTokenAssociated(token, responseCode);

        // Success codes: 22 (SUCCESS) or 23 (TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT)
        if (responseCode != HTS_SUCCESS && responseCode != 23) {
            revert HTSAssociationFailed();
        }
    }

    /**
     * @notice Safely associate this contract with an HTS token - doesn't revert on failure
     * @param token The HTS token address to associate with this contract
     */
    function _safeAssociateToken(address token) internal {
        if (token == address(0)) return;

        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.associateToken.selector, address(this), token)
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;

        // Emit event for all responses to aid debugging
        emit HTSTokenAssociated(token, responseCode);

        // Success codes: 22 (SUCCESS) or 23 (TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT)
        // Don't revert on failure - just log for debugging
        if (responseCode != HTS_SUCCESS && responseCode != 23) {
            // Log the failure but don't revert to prevent initialization from failing
            emit HTSTokenAssociated(token, responseCode);
        }
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
