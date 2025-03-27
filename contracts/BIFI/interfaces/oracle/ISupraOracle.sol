// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.19;

import { ISupraSValueFeed } from "./ISupraSValueFeed.sol";

/// @title ISupraOracle Interface
/// @notice Interface for the SupraOracle contract that interacts with the SupraSValueFeed
interface ISupraOracle {
  /// @notice Updates the SupraSValueFeed contract address
  /// @param _newSValueFeed The new address of the SupraSValueFeed contract
  function updateSupraSvalueFeed(ISupraSValueFeed _newSValueFeed) external;

  /// @notice Gets the current SupraSValueFeed contract address
  /// @return The address of the current SupraSValueFeed contract
  function getSupraSvalueFeed() external view returns (ISupraSValueFeed);

  /// @notice Adds a new asset to the oracle
  /// @param _name The name of the asset
  /// @param _asset The address of the asset
  /// @param _index The price index of the asset
  /// @param _decimals The number of decimals for the asset's price
  function addNewAsset(
    string memory _name,
    address _asset,
    uint16 _index,
    uint16 _decimals
  ) external;

  /// @notice Updates an existing asset's details
  /// @param _name The name of the asset
  /// @param _asset The new address of the asset
  /// @param _newIndex The new price index of the asset
  /// @param _newDecimals The new number of decimals for the asset's price
  function updateAsset(
    string memory _name,
    address _asset,
    uint16 _newIndex,
    uint16 _newDecimals
  ) external;

  /// @notice Helper function for tests to get the price feed of an asset
  /// @param _asset The address of the asset
  /// @return The price feed of an asset
  function getPriceFeed(address _asset) external view returns (ISupraSValueFeed.priceFeed memory);

  /// @notice Helper function to test the price of an asset in HBAR
  /// @param amount The amount of the asset
  /// @param asset The address of the asset
  /// @return amountInEth The equivalent price in HBAR
  function getAmountInEth(
    uint256 amount,
    address asset
  ) external view returns (uint256 amountInEth);

  /// @notice Gets the price of an asset in HBAR
  /// @param _asset The address of the asset
  /// @return The price of the asset in HBAR
  function getAssetPrice(address _asset) external view returns (uint256);

  /// @notice Gets the price of an asset in USD
  /// @param _asset The address of the asset
  /// @return The price of the asset in USD
  function getAssetPriceInUSD(address _asset) external view returns (uint256);

  /// @notice Converts an amount of HBAR to USD
  /// @param _amount The amount of HBAR
  /// @return priceInUSD The equivalent price in USD
  function getHbarUSD(uint256 _amount) external view returns (uint256 priceInUSD);

  /// @notice Gets the number of decimals used for prices
  /// @return The number of decimals (18)
  function decimals() external pure returns (uint8);
}
