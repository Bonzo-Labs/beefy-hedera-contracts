// SPDX-License-Identifier: MIT
//ONLY FOR TESTING PURPOSES

pragma solidity ^0.8.9;

import "@openzeppelin-4/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin-4/contracts/access/Ownable.sol";
import "@openzeppelin-4/contracts/utils/Address.sol";
import "../../../Hedera/IHederaTokenService.sol";

contract MockStaking is Ownable {
    using Address for address payable;

    IERC20 public hbarxToken;
    uint256 public constant EXCHANGE_RATE = 133000000; // 1.33 HBAR = 1 HBARX (8 decimals)
    uint256 public constant RATE_PRECISION = 1e8;
    address public constant HTS_PRECOMPILE = address(0x167);
    int64 public constant HTS_SUCCESS = 22;
    int64 public constant PRECOMPILE_BIND_ERROR = -1;

    error InsufficientHBARBalance(uint256 hbarAmount, uint256 contractBalance);

    event Staked(address indexed user, uint256 hbarAmount, uint256 hbarxAmount);
    event Unstaked(address indexed user, uint256 hbarxAmount, uint256 hbarAmount);
    event HTSTokenTransferFailed(address indexed token, address indexed from, address indexed to, int64 responseCode);
    event Debug(uint256 hbarxAmount, uint256 hbarAmount, uint256 contractBalance, uint256 exchangeRate);
    constructor(address _hbarxToken) {
        hbarxToken = IERC20(_hbarxToken);
    }

    function stake() external payable {
        require(msg.value > 0, "Must send HBAR");
        uint256 hbarxAmount = (msg.value * RATE_PRECISION) / EXCHANGE_RATE;
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.transferToken.selector, address(hbarxToken), address(this), msg.sender, int64(uint64(hbarxAmount)))
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        if (responseCode != HTS_SUCCESS) {
            emit HTSTokenTransferFailed(address(hbarxToken), address(this), msg.sender, responseCode);
            revert("HTS token transfer failed");
        }
        require(success, "HBARX transfer failed");
        emit Staked(msg.sender, msg.value, hbarxAmount);
    }

    function unStake(uint256 amount) external returns (uint256) {
        require(amount > 0, "Amount must be greater than 0");
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.transferToken.selector, address(hbarxToken), msg.sender, address(this), int64(uint64(amount)))
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        if (responseCode != HTS_SUCCESS) {
            emit HTSTokenTransferFailed(address(hbarxToken), msg.sender, address(this), responseCode);
            revert("HTS token transfer failed");
        }
        uint256 hbarAmount = (amount * EXCHANGE_RATE) / RATE_PRECISION;
        uint256 contractBalance = address(this).balance;
        
        emit Debug(amount, hbarAmount, contractBalance, EXCHANGE_RATE);
        
        if (contractBalance < hbarAmount) {
            revert InsufficientHBARBalance(hbarAmount, contractBalance);
        }
        payable(msg.sender).sendValue(hbarAmount);
        emit Unstaked(msg.sender, amount, hbarAmount);
        return hbarAmount;
    }

    function getExchangeRate() external pure returns (uint256) {
        return EXCHANGE_RATE;
    }


    // Allow contract to receive HBAR
    receive() external payable {}

    //ONLY FOR TESTING PURPOSES
    //function to withdraw all hbarx from the contract
    function withdrawHbarx() external onlyOwner {
        (bool success, bytes memory result) = HTS_PRECOMPILE.call(
            abi.encodeWithSelector(IHederaTokenService.transferToken.selector, address(hbarxToken), address(this), msg.sender, int64(uint64(hbarxToken.balanceOf(address(this)))))
        );
        int64 responseCode = success ? abi.decode(result, (int64)) : PRECOMPILE_BIND_ERROR;
        if (responseCode != HTS_SUCCESS) {
            emit HTSTokenTransferFailed(address(hbarxToken), address(this), msg.sender, responseCode);
            revert("HTS token transfer failed");
        }
    }
}


