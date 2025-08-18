# Hedera Tests

This directory contains comprehensive tests for Hedera-based vaults and strategies in the Bonzo ecosystem. These tests cover various DeFi protocols and strategies deployed on the Hedera network.

## Overview

The Hedera tests are designed to validate the functionality of:
- **Vault Contracts**: Bonzo vault implementations for different asset types
- **Strategy Contracts**: Yield farming and liquidity management strategies
- **Integration Tests**: End-to-end testing of vault-strategy interactions
- **Protocol-Specific Tests**: Tests for SaucerSwap, YieldLoop, and other Hedera DeFi protocols

## Prerequisites

### Node.js and npm
- Node.js version 16 or higher
- npm package manager

### Environment Setup
1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Compile Contracts**:
   ```bash
   npm run compile
   ```

3. **Deploy Infrastructure**:
   ```bash
   # Deploy chain infrastructure (vault factory, fee config, etc.)
   npm run deploy:chain hedera_testnet
   
   # Deploy Supra Oracle
   npx hardhat run scripts/infra/deploySupraOracle.js --network hedera_testnet
   
   # Deploy Chainlink Oracle
   npx hardhat run scripts/infra/deployChainlinkOracle.js --network hedera_testnet
   
   ```

4. **Environment Variables**:
   Create a `.env` file in the root directory with the following variables:

   ```env
   # Chain Configuration
   CHAIN_TYPE=testnet  # or mainnet
   
   # Testnet Private Keys (without 0x prefix)
   DEPLOYER_PK=your_deployer_private_key
   KEEPER_PK=your_keeper_private_key
   UPGRADER_PK=your_upgrader_private_key
   REWARDER_PK=your_rewarder_private_key
   NON_MANAGER_PK=your_non_manager_private_key
   
   # Mainnet Private Keys (without 0x prefix) - if testing on mainnet
   DEPLOYER_PK_MAINNET=your_mainnet_deployer_private_key
   KEEPER_PK_MAINNET=your_mainnet_keeper_private_key
   UPGRADER_PK_MAINNET=your_mainnet_upgrader_private_key
   REWARDER_PK_MAINNET=your_mainnet_rewarder_private_key
   NON_MANAGER_PK_MAINNET=your_mainnet_non_manager_private_key
   
   # RPC Endpoints
   HEDERA_TESTNET_RPC=https://testnet.hashio.io/api
   HEDERA_MAINNET_RPC=https://mainnet.hashio.io/api
   ```

## Test Files

### Vault Tests
- **`BonzoSupplyVault.test.ts`** - Tests for supply vault functionality
- **`USDCSupplyVault.test.ts`** - USD Coin supply vault tests
- **`HbarXHbarVault.test.ts`** - HBAR staking vault tests
- **`SauceXSauceVault.test.ts`** - SAUCE token vault tests
- **`YieldLoopConfigurable.test.ts`** - YieldLoop lending strategy tests
- **`SaucerSwapLariRewardsCLMStrategy.test.ts`** - SaucerSwap CLM rewards strategy tests
- **`StrategyPassiveManagerSaucerSwap.test.ts`** - Passive manager strategy tests


## Running Tests

### 1. Run All Hedera Tests
```bash
# Run all tests in the Hedera directory
npx hardhat test test/Hedera/<testfile.test.ts>

# Run with specific chain type
CHAIN_TYPE=testnet npx hardhat test test/Hedera/
CHAIN_TYPE=mainnet npx hardhat test test/Hedera/
```

### 2. Run Specific Test Files
```bash
# Run a specific test file
npx hardhat test test/Hedera/BonzoSupplyVault.test.ts
npx hardhat test test/Hedera/YieldLoopConfigurable.test.ts
npx hardhat test test/Hedera/SaucerSwapLariRewardsCLMStrategy.test.ts

# Run with specific chain type
CHAIN_TYPE=testnet npx hardhat test test/Hedera/BonzoSupplyVault.test.ts
```

### 3. Run Tests with Verbose Output
```bash
# Run tests with detailed logging
npx hardhat test test/Hedera/ --verbose

# Run specific test with verbose output
npx hardhat test test/Hedera/BonzoSupplyVault.test.ts --verbose
```

### 4. Run Tests on Specific Network
```bash
# Run tests on Hedera testnet
npx hardhat test test/Hedera/ --network hedera_testnet

# Run tests on Hedera mainnet
npx hardhat test test/Hedera/ --network hedera_mainnet
```

### 5. Verify Infrastructure Deployment
```bash
# Verify chain infrastructure is deployed
npx hardhat run scripts/verify/verify-chain.js --network hedera_testnet

# Verify oracle deployments
npx hardhat run scripts/verify/verify-oracles.js --network hedera_testnet

# Check deployed addresses
cat scripts/deployed-addresses.json
```

## Test Configuration

### Chain Type Configuration
The tests support two chain types:
- **`testnet`**: Uses Hedera testnet addresses and configurations
- **`mainnet`**: Uses Hedera mainnet addresses and configurations

Set the `CHAIN_TYPE` environment variable to control which configuration is used.

### Test Timeouts
Tests are configured with extended timeouts (up to 1000 seconds) to accommodate Hedera's block time and transaction processing.

### Gas Configuration
Tests use appropriate gas limits for Hedera transactions:
- Strategy deployment: 4,000,000 gas
- Vault creation: 3,000,000 gas
- Standard transactions: Default gas estimation

## Test Structure

### Common Test Patterns
1. **Setup Phase**: Deploy contracts and initialize configurations
2. **Deposit Phase**: Test vault deposit functionality
3. **Strategy Phase**: Test strategy operations (harvest, rebalance)
4. **Withdrawal Phase**: Test vault withdrawal functionality
5. **Emergency Phase**: Test emergency functions (panic, pause)

### Test Utilities
Tests use common utilities for:
- Contract deployment and initialization
- Token balance checking
- Transaction verification
- Error handling

## Troubleshooting

### Common Issues

1. **Environment Variable Errors**:
   ```bash
   # Ensure CHAIN_TYPE is set
   export CHAIN_TYPE=testnet
   ```

2. **Private Key Format**:
   - Ensure private keys are provided without the `0x` prefix
   - Verify all required private keys are set in `.env`

3. **Network Connection Issues**:
   ```bash
   # Check RPC endpoint connectivity
   curl -X POST -H "Content-Type: application/json" \
     --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
     https://testnet.hashio.io/api
   ```

4. **Gas Estimation Failures**:
   - Increase gas limits in test files if needed
   - Check account balances for sufficient HBAR

5. **Contract Deployment Failures**:
   ```bash
   # Clean and recompile
   npm run clean
   npm run compile
   ```

6. **Infrastructure Deployment Issues**:
   ```bash
   # Check if infrastructure is already deployed
   cat scripts/deployed-addresses.json
   
   # Redeploy infrastructure if needed
   npm run deploy:chain -- --network hedera_testnet
   npm run deploy:supra-oracle -- --network hedera_testnet
   npm run deploy:chainlink-oracle -- --network hedera_testnet
   
   # Verify oracle configurations
   npx hardhat run scripts/verify/verify-oracles.js --network hedera_testnet
   ```


```

## Test Coverage

The Hedera tests cover:
- ✅ Vault deposit/withdrawal functionality
- ✅ Strategy yield farming operations
- ✅ Emergency functions (panic, pause)
- ✅ Fee collection and distribution
- ✅ Multi-token support
- ✅ Concentrated liquidity management
- ✅ Protocol integrations (SaucerSwap, YieldLoop)

## Contributing

When adding new tests:
1. Follow the existing test structure and patterns
2. Include proper error handling and assertions
3. Add appropriate timeouts for Hedera operations
4. Document any new environment variables or dependencies
5. Test on both testnet and mainnet configurations

## Support

For issues related to Hedera tests:
1. Check the troubleshooting section above
2. Review the main project README for general setup
3. Check the test file comments for specific configuration details
4. Ensure all environment variables are properly configured
