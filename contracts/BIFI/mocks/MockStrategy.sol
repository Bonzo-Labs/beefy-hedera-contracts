// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "../interfaces/beefy/IStrategyV7.sol";
import "../Hedera/IHederaTokenService.sol";
/**
 * @title MockStrategy
 * @dev A mock strategy implementation for testing purposes
 */
contract MockStrategy is IStrategyV7 {
    address private _vault;
    IERC20Upgradeable private _want;
    address private _unirouter;
    bool private _paused;
    bool private _isHederaToken;

    // Constants for Hedera Token Service
    address constant private HTS_PRECOMPILE = address(0x167);
    int64 constant private HTS_SUCCESS = 22;
    int64 constant private PRECOMPILE_BIND_ERROR = -2;
    
    // Events for HTS operations
    event HTSTokenAssociated(address token, int64 responseCode);
    event HTSTokenDissociated(address token, int64 responseCode);
    event HTSTokenTransferFailed(address token, address from, address to, int64 responseCode);
    
    // Constructor is empty to allow for flexible initialization in tests
    constructor(address wantAddress, bool isHederaToken) {
        _paused = false;
        _want = IERC20Upgradeable(wantAddress);
        _isHederaToken = isHederaToken;
        if (_isHederaToken) {
            _associateToken(wantAddress);
        }
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

    // Setters for testing
    function setVault(address vaultAddress) external {
        _vault = vaultAddress;
    }
    
    function setWant(address wantAddress) external {
        _want = IERC20Upgradeable(wantAddress);
    }
    
    function setUnirouter(address routerAddress) external {
        _unirouter = routerAddress;
    }
    
    function setIsHederaToken(bool isHederaToken) external {
        _isHederaToken = isHederaToken;
    }
    
    // IStrategyV7 implementation
    function vault() external view override returns (address) {
        return _vault;
    }
    
    function want() external view override returns (IERC20Upgradeable) {
        return _want;
    }
    
    function beforeDeposit() external override {
        // Mock implementation - does nothing
    }
    
    function deposit() external override {
        // Mock implementation - does nothing
    }
    
    function withdraw(uint256 _amount) external override {
        // Mock withdraw - transfer tokens from this contract to vault
        if (address(_want) != address(0) && _amount > 0) {
            if (_isHederaToken) {
                // For HTS tokens, use HTS precompile
                _transferHTS(address(_want), address(this), _vault, int64(uint64(_amount)));
            } else {
                // For ERC20 tokens, use standard transfer
                _want.transfer(_vault, _amount);
            }
        }
    }
    
    function balanceOf() external view override returns (uint256) {
        return balanceOfWant() + balanceOfPool();
    }
    
    function balanceOfWant() public view override returns (uint256) {
        return _want.balanceOf(address(this));
    }
    
    function balanceOfPool() public view override returns (uint256) {
        // Mock implementation - just returns 0 as if nothing is deployed in external protocols
        return 0;
    }
    
    function harvest() external override {
        // Mock implementation - does nothing
    }
    
    function retireStrat() external override {
        // Mock implementation - transfer all funds to vault
        uint256 balance = _want.balanceOf(address(this));
        if (balance > 0) {
            if (_isHederaToken) {
                // For HTS tokens, use HTS precompile
                _transferHTS(address(_want), address(this), _vault, int64(uint64(balance)));
            } else {
                // For ERC20 tokens, use standard transfer
                _want.transfer(_vault, balance);
            }
        }
    }
    
    function panic() external override {
        // Mock implementation - does nothing
    }
    
    function pause() external override {
        _paused = true;
    }
    
    function unpause() external override {
        _paused = false;
    }
    
    function paused() external view override returns (bool) {
        return _paused;
    }
    
    function unirouter() external view override returns (address) {
        return _unirouter;
    }
    
    // Function to receive funds for testing
    function fund(uint256 _amount) external {
        // Transfer tokens to this contract to simulate earnings or deposits
        _want.transferFrom(msg.sender, address(this), _amount);
    }
} 