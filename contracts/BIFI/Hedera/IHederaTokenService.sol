// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.4.9 <0.9.0;
pragma experimental ABIEncoderV2;

interface IHederaTokenService {
  struct AccountAmount {
    address accountID;
    int64 amount;
    bool isApproval;
  }

  struct NftTransfer {
    address senderAccountID;
    address receiverAccountID;
    int64 serialNumber;
    bool isApproval;
  }

  struct TokenTransferList {
    address token;
    AccountAmount[] transfers;
    NftTransfer[] nftTransfers;
  }

  struct TransferList {
    AccountAmount[] transfers;
  }

  struct Expiry {
    int64 second;
    address autoRenewAccount;
    int64 autoRenewPeriod;
  }

  struct KeyValue {
    bool inheritAccountKey;
    address contractId;
    bytes ed25519;
    bytes ECDSA_secp256k1;
    address delegatableContractId;
  }

  struct TokenKey {
    uint256 keyType;
    KeyValue key;
  }

  struct HederaToken {
    string name;
    string symbol;
    address treasury;
    string memo;
    bool tokenSupplyType;
    int64 maxSupply;
    bool freezeDefault;
    TokenKey[] tokenKeys;
    Expiry expiry;
  }

  struct TokenInfo {
    HederaToken token;
    int64 totalSupply;
    bool deleted;
    bool defaultKycStatus;
    bool pauseStatus;
    FixedFee[] fixedFees;
    FractionalFee[] fractionalFees;
    RoyaltyFee[] royaltyFees;
    string ledgerId;
  }

  struct FungibleTokenInfo {
    TokenInfo tokenInfo;
    int32 decimals;
  }

  struct NonFungibleTokenInfo {
    TokenInfo tokenInfo;
    int64 serialNumber;
    address ownerId;
    int64 creationTime;
    bytes metadata;
    address spenderId;
  }

  struct FixedFee {
    int64 amount;
    address tokenId;
    bool useHbarsForPayment;
    bool useCurrentTokenForPayment;
    address feeCollector;
  }

  struct FractionalFee {
    int64 numerator;
    int64 denominator;
    int64 minimumAmount;
    int64 maximumAmount;
    bool netOfTransfers;
    address feeCollector;
  }

  struct RoyaltyFee {
    int64 numerator;
    int64 denominator;
    int64 amount;
    address tokenId;
    bool useHbarsForPayment;
    address feeCollector;
  }

  function cryptoTransfer(
    TransferList memory transferList,
    TokenTransferList[] memory tokenTransfers
  ) external returns (int64 responseCode);

  function mintToken(
    address token,
    int64 amount,
    bytes[] memory metadata
  )
    external
    returns (
      int64 responseCode,
      int64 newTotalSupply,
      int64[] memory serialNumbers
    );

  function burnToken(
    address token,
    int64 amount,
    int64[] memory serialNumbers
  ) external returns (int64 responseCode, int64 newTotalSupply);

  function associateTokens(address account, address[] memory tokens)
    external
    returns (int64 responseCode);

  function associateToken(address account, address token) external returns (int64 responseCode);

  function dissociateTokens(address account, address[] memory tokens)
    external
    returns (int64 responseCode);

  function dissociateToken(address account, address token) external returns (int64 responseCode);

  function createFungibleToken(
    HederaToken memory token,
    int64 initialTotalSupply,
    int32 decimals
  ) external payable returns (int64 responseCode, address tokenAddress);

  function createFungibleTokenWithCustomFees(
    HederaToken memory token,
    int64 initialTotalSupply,
    int32 decimals,
    FixedFee[] memory fixedFees,
    FractionalFee[] memory fractionalFees
  ) external payable returns (int64 responseCode, address tokenAddress);

  function createNonFungibleToken(HederaToken memory token)
    external
    payable
    returns (int64 responseCode, address tokenAddress);

  function createNonFungibleTokenWithCustomFees(
    HederaToken memory token,
    FixedFee[] memory fixedFees,
    RoyaltyFee[] memory royaltyFees
  ) external payable returns (int64 responseCode, address tokenAddress);

  function transferTokens(
    address token,
    address[] memory accountId,
    int64[] memory amount
  ) external returns (int64 responseCode);

  function transferNFTs(
    address token,
    address[] memory sender,
    address[] memory receiver,
    int64[] memory serialNumber
  ) external returns (int64 responseCode);

  function transferToken(
    address token,
    address sender,
    address recipient,
    int64 amount
  ) external returns (int64 responseCode);

  function transferNFT(
    address token,
    address sender,
    address recipient,
    int64 serialNumber
  ) external returns (int64 responseCode);

  function approve(
    address token,
    address spender,
    uint256 amount
  ) external returns (int64 responseCode);

  function transferFrom(
    address token,
    address from,
    address to,
    uint256 amount
  ) external returns (int64 responseCode);

  function allowance(
    address token,
    address owner,
    address spender
  ) external returns (int64 responseCode, uint256 allowance);

  function approveNFT(
    address token,
    address approved,
    uint256 serialNumber
  ) external returns (int64 responseCode);

  function transferFromNFT(
    address token,
    address from,
    address to,
    uint256 serialNumber
  ) external returns (int64 responseCode);

  function getApproved(address token, uint256 serialNumber)
    external
    returns (int64 responseCode, address approved);

  function setApprovalForAll(
    address token,
    address operator,
    bool approved
  ) external returns (int64 responseCode);

  function isApprovedForAll(
    address token,
    address owner,
    address operator
  ) external returns (int64 responseCode, bool approved);

  function isFrozen(address token, address account)
    external
    returns (int64 responseCode, bool frozen);

  function isKyc(address token, address account)
    external
    returns (int64 responseCode, bool kycGranted);

  function deleteToken(address token) external returns (int64 responseCode);

  function getTokenCustomFees(address token)
    external
    returns (
      int64 responseCode,
      FixedFee[] memory fixedFees,
      FractionalFee[] memory fractionalFees,
      RoyaltyFee[] memory royaltyFees
    );

  function getTokenDefaultFreezeStatus(address token)
    external
    returns (int64 responseCode, bool defaultFreezeStatus);

  function getTokenDefaultKycStatus(address token)
    external
    returns (int64 responseCode, bool defaultKycStatus);

  function getTokenExpiryInfo(address token)
    external
    returns (int64 responseCode, Expiry memory expiry);

  function getFungibleTokenInfo(address token)
    external
    returns (int64 responseCode, FungibleTokenInfo memory fungibleTokenInfo);

  function getTokenInfo(address token)
    external
    returns (int64 responseCode, TokenInfo memory tokenInfo);

  function getTokenKey(address token, uint256 keyType)
    external
    returns (int64 responseCode, KeyValue memory key);

  function getNonFungibleTokenInfo(address token, int64 serialNumber)
    external
    returns (int64 responseCode, NonFungibleTokenInfo memory nonFungibleTokenInfo);

  function freezeToken(address token, address account) external returns (int64 responseCode);

  function unfreezeToken(address token, address account) external returns (int64 responseCode);

  function grantTokenKyc(address token, address account) external returns (int64 responseCode);

  function revokeTokenKyc(address token, address account) external returns (int64 responseCode);

  function pauseToken(address token) external returns (int64 responseCode);

  function unpauseToken(address token) external returns (int64 responseCode);

  function wipeTokenAccount(
    address token,
    address account,
    int64 amount
  ) external returns (int64 responseCode);

  function wipeTokenAccountNFT(
    address token,
    address account,
    int64[] memory serialNumbers
  ) external returns (int64 responseCode);

  function updateTokenInfo(address token, HederaToken memory tokenInfo)
    external
    returns (int64 responseCode);

  function updateTokenExpiryInfo(address token, Expiry memory expiryInfo)
    external
    returns (int64 responseCode);

  function updateTokenKeys(address token, TokenKey[] memory keys)
    external
    returns (int64 responseCode);

  function isToken(address token) external returns (int64 responseCode, bool isToken);

  function getTokenType(address token) external returns (int64 responseCode, int32 tokenType);

  function redirectForToken(address token, bytes memory encodedFunctionSelector)
    external
    returns (int64 responseCode, bytes memory response);
}
