# Bonzo Contracts (Hedera)

Official repo for strategies and vaults from Bonzo. Community strategists can contribute here to grow the ecosystem. This repository contains Bonzo vaults and strategies built for Hedera. Vaults are user-facing contracts that accept deposits, issue shares, and route funds into strategies that compound rewards. Strategies handle protocol-specific logic, swaps, and reward harvesting. The repo includes Hedera helpers plus strategies already deployed for Bonzo and SaucerSwap.

## Quick Links
- `STRATEGY_DEVELOPMENT_GUIDE.md` for the full strategy walkthrough and required interfaces
- `test/Hedera/README.md` for Hedera test setup and infra deployment details
- `contracts/BIFI/strategies/Bonzo/` for Bonzo strategy implementations
- `contracts/BIFI/strategies/SaucerSwap/` for SaucerSwap strategy implementations

## Create A New Strategy
1. Pick the protocol and vault type. Typical options are single-asset, LP, or CLM.
2. Start from the closest existing strategy in `contracts/BIFI/strategies/Bonzo/` or `contracts/BIFI/strategies/SaucerSwap/` and copy it into a new file.
3. Update protocol-specific addresses, rewards handling, swap routes, and oracle config. Use Hedera helpers in `contracts/BIFI/Hedera/` for HTS integration where needed.
4. Add tests under `test/Hedera/` that cover deposit, withdraw, harvest, and emergency flows.
5. Compile and run tests locally.
6. Deploy to Hedera testnet, verify, and complete manual validation before mainnet.

## Local Setup
```bash
npm install
npm run compile

# Deploy chain infrastructure (vault factory, fee config, etc.)
npm run deploy:chain hedera_testnet

# Deploy Supra Oracle
npx hardhat run scripts/infra/deploySupraOracle.js --network hedera_testnet

# Deploy Chainlink Oracle
npx hardhat run scripts/infra/deployChainlinkOracle.js --network hedera_testnet
```

## Testing On Hedera
Hedera tests live under `test/Hedera/`. See `test/Hedera/README.md` for the full matrix and infra steps.

```bash
# Run a single test on testnet config
CHAIN_TYPE=testnet npx hardhat test test/Hedera/YourStrategy.test.ts

# Run all Hedera tests
CHAIN_TYPE=testnet npx hardhat test test/Hedera/

# Run against an actual network
npx hardhat test test/Hedera/ --network hedera_testnet
```

## Environment Variables
Create a `.env` file at the repo root with the following variables:

```env
# Chain Configuration
CHAIN_TYPE=testnet  # or mainnet

# Testnet Private Keys (without 0x prefix)
DEPLOYER_PK=your_deployer_private_key
KEEPER_PK=your_keeper_private_key
UPGRADER_PK=your_upgrader_private_key
REWARDER_PK=your_rewarder_private_key
NON_MANAGER_PK=your_non_manager_private_key

# Mainnet Private Keys (without 0x prefix)
DEPLOYER_PK_MAINNET=your_mainnet_deployer_private_key
KEEPER_PK_MAINNET=your_mainnet_keeper_private_key
UPGRADER_PK_MAINNET=your_mainnet_upgrader_private_key
REWARDER_PK_MAINNET=your_mainnet_rewarder_private_key
NON_MANAGER_PK_MAINNET=your_mainnet_non_manager_private_key

# RPC Endpoints
HEDERA_TESTNET_RPC=https://testnet.hashio.io/api
HEDERA_MAINNET_RPC=https://mainnet.hashio.io/api
```

## Deployment Notes
- Infra deployment uses `npm run deploy:chain hedera_testnet` and related scripts under `scripts/infra/`.
- Strategy and vault deployments are done via `npx hardhat run scripts/... --network hedera_testnet`.
- Verify deployments and keep constructor args and flattened sources for scanner verification.

## Manual Validation Checklist
1. Deposit a small amount and withdraw.
2. Deposit a larger amount and harvest.
3. Panic, then withdraw and unpause.
4. Re-deposit and harvest again.
5. Verify fee destinations and reward tokens.
6. Transfer ownership to the correct chain owner addresses before going live.

## Troubleshooting
- If RPC calls fail, verify `HEDERA_TESTNET_RPC` or `HEDERA_MAINNET_RPC` connectivity and account balances.
- If gas estimation fails, increase gas limits in the relevant test or deployment script.
