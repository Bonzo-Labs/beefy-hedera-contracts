// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { ISupraOracle } from "../../interfaces/oracle/ISupraOracle.sol";
import { BeefyOracleHelper, BeefyOracleErrors } from "./BeefyOracleHelper.sol";

/// @title Beefy Oracle using Supra
/// @author Beefy
/// @notice On-chain oracle using Supra
library BeefyOracleSupra {

    /// @notice Fetch price from the Supra feed and scale to 18 decimals
    /// @param _data Payload from the central oracle with the address of the Supra oracle and asset
    /// @return price Retrieved price from the Supra feed
    /// @return success Successful price fetch or not
    function getPrice(bytes calldata _data) external view returns (uint256 price, bool success) {
        (address supraOracle, address asset) = abi.decode(_data, (address, address));
        try ISupraOracle(supraOracle).getAssetPrice(asset) returns (uint256 assetPrice) {
            if (assetPrice > 0) {
                uint8 decimals = ISupraOracle(supraOracle).decimals();
                price = BeefyOracleHelper.scaleAmount(assetPrice, decimals);
                success = true;
            }
        } catch {}
    }

    /// @notice Data validation for new oracle data being added to central oracle
    /// @param _data Encoded Supra oracle address and asset address
    function validateData(bytes calldata _data) external view {
        (address supraOracle, address asset) = abi.decode(_data, (address, address));
        try ISupraOracle(supraOracle).getAssetPrice(asset) returns (uint256 assetPrice) {
            if (assetPrice == 0) revert BeefyOracleErrors.NoAnswer();
        } catch {
            revert BeefyOracleErrors.NoAnswer();
        }
    }
}
