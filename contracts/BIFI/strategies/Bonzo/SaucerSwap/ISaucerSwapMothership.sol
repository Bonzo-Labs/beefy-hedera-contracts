// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

    // Add interface for staking pool
    interface ISaucerSwapMothership {
        /**
         * @dev Enter the bar by sending SAUCE. Mothership mints and sends xSAUCE to msg.sender
         * @param _amount the amount of SAUCE msg.sender intends to lock in the contract for xSAUCE
         */
        function enter(uint256 _amount) external;

        /**
         * @dev Leave the bar by sending xSAUCE. Mothership burns the xSAUCE and sends SAUCE to msg.sender
         * @param _share the amount of xSAUCE msg.sender intends to redeem for SAUCE
         */
        function leave(uint256 _share) external;

        /**
         * @dev returns how much sauce someone gets for redeeming xSAUCE
         * @param _xSauceAmount the amount of xSAUCE to calculate corresponding SAUCE amount
         * @return sauceAmount_ the amount of SAUCE to be received if _xSauceAmount is deposited
         */
        function xSauceForSauce(uint256 _xSauceAmount) external view returns (uint256 sauceAmount_);

        /**
         * @dev returns how much xSAUCE someone gets for depositing SAUCE
         * @param _sauceAmount the amount of SAUCE to calculate corresponding xSAUCE amount
         * @return xSauceAmount_ the amount of xSAUCE to be received if _sauceAmount is deposited
         */
        function sauceForxSauce(uint256 _sauceAmount) external view returns (uint256 xSauceAmount_);

        /**
         * @dev returns the amount of SAUCE in the contract
         * @return sauceAmount_ the amount of SAUCE in the contract
         */
        function sauceBalance(address _account) external view returns (uint256 sauceAmount_);
    }