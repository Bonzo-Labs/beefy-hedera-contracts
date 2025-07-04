const hardhat = require("hardhat");

/**
 * Script to deploy StrategyPassiveManagerSaucerSwap for CLM (Concentrated Liquidity Management)
 *
 * Usage:
 * CHAIN_TYPE=testnet npx hardhat run scripts/strategy/deployCLMSaucerSwapStrategy.js --network hedera_testnet
 * CHAIN_TYPE=mainnet npx hardhat run scripts/strategy/deployCLMSaucerSwapStrategy.js --network hedera_mainnet
 *
 * Note: All tokens on Hedera are automatically detected as HTS tokens except native HBAR.
 * No need to specify token types manually.
 */

const ethers = hardhat.ethers;

//*******************SET CHAIN TYPE HERE*******************
const CHAIN_TYPE = process.env.CHAIN_TYPE;
//*******************SET CHAIN TYPE HERE*******************

// Load addresses based on chain type
let addresses;
if (CHAIN_TYPE === "mainnet") {
  addresses = require("../deployed-addresses-mainnet.json");
} else if (CHAIN_TYPE === "testnet") {
  addresses = require("../deployed-addresses.json");
} else {
  throw new Error(`Unsupported CHAIN_TYPE: ${CHAIN_TYPE}. Use 'testnet' or 'mainnet'`);
}

// Chain-specific configuration
let config;
if (CHAIN_TYPE === "testnet") {
  config = {
    // SaucerSwap V3 addresses (testnet)
    pool: process.env.SAUCERSWAP_POOL_ADDRESS || "0x37814edc1ae88cf27c0c346648721fb04e7e0ae7", // SAUCE-WHBAR pool
    quoter: process.env.SAUCERSWAP_QUOTER_ADDRESS || "0x00000000000000000000000000000000001535b2",
    factory: process.env.SAUCERSWAP_FACTORY_ADDRESS || "0x00000000000000000000000000000000001243ee",

    // Token addresses (testnet)
    token0: process.env.TOKEN0_ADDRESS || "0x0000000000000000000000000000000000003ad2", // WHBAR
    token1: process.env.TOKEN1_ADDRESS || "0x0000000000000000000000000000000000120f46", // SAUCE

    // Native token (WHBAR)
    native: "0x0000000000000000000000000000000000003ad2", // WHBAR testnet

    // Position configuration
    positionWidth: parseInt(process.env.POSITION_WIDTH) || 200,

    // Vault configuration
    vaultName: process.env.VAULT_NAME || "Beefy CLM SaucerSwap Testnet",
    vaultSymbol: process.env.VAULT_SYMBOL || "bCLM-SS-T",
  };
} else if (CHAIN_TYPE === "mainnet") {
  config = {
    // SaucerSwap V3 addresses (mainnet)
    pool: process.env.SAUCERSWAP_POOL_ADDRESS || "0x", // Update with actual mainnet pool
    quoter: process.env.SAUCERSWAP_QUOTER_ADDRESS || "0x", // Update with actual mainnet quoter
    factory: process.env.SAUCERSWAP_FACTORY_ADDRESS || "0x", // Update with actual mainnet factory

    // Token addresses (mainnet)
    token0: process.env.TOKEN0_ADDRESS || "0x", // Update with actual mainnet token0
    token1: process.env.TOKEN1_ADDRESS || "0x", // Update with actual mainnet token1

    // Native token (WHBAR)
    native: "0x0000000000000000000000000000000000163b5a", // WHBAR mainnet

    // Position configuration
    positionWidth: parseInt(process.env.POSITION_WIDTH) || 200,

    // Vault configuration
    vaultName: process.env.VAULT_NAME || "Beefy CLM SaucerSwap",
    vaultSymbol: process.env.VAULT_SYMBOL || "bCLM-SS",
  };
}

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await deployer.getBalance()).toString());
  console.log("Chain type:", CHAIN_TYPE);

  // Validate infrastructure addresses
  if (!addresses.beefyFeeConfig || addresses.beefyFeeConfig === ethers.constants.AddressZero) {
    throw new Error("BeefyFeeConfig address not found. Please run deployChain.js first.");
  }

  if (!addresses.beefyOracle || addresses.beefyOracle === ethers.constants.AddressZero) {
    throw new Error("BeefyOracle address not found. Please run deployChain.js first.");
  }

  if (!addresses.clmVault || addresses.clmVault === ethers.constants.AddressZero) {
    throw new Error("CLM Vault address not found. Please run deployChain.js first.");
  }

  // Validate configuration
  if (config.pool === ethers.constants.AddressZero) {
    throw new Error("SAUCERSWAP_POOL_ADDRESS environment variable is required");
  }

  if (config.quoter === ethers.constants.AddressZero) {
    throw new Error("SAUCERSWAP_QUOTER_ADDRESS environment variable is required");
  }

  console.log("Configuration:");
  console.log("  Pool:", config.pool);
  console.log("  Token0:", config.token0);
  console.log("  Token1:", config.token1);
  console.log("  Position Width:", config.positionWidth);
  console.log("  Native Token:", config.native);

  // Deploy library first
  console.log("\n=== Deploying SaucerSwapCLMLib ===");
  const LibraryFactory = await ethers.getContractFactory("SaucerSwapCLMLib");
  const library = await LibraryFactory.deploy({ gasLimit: 3000000 });
  await library.deployed();
  console.log("Library deployed to:", library.address);

  // Deploy strategy with library linking
  console.log("\n=== Deploying StrategyPassiveManagerSaucerSwap ===");
  const StrategyFactory = await ethers.getContractFactory("StrategyPassiveManagerSaucerSwap", {
    libraries: {
      SaucerSwapCLMLib: library.address,
    },
  });

  const strategy = await StrategyFactory.deploy({ gasLimit: 8000000 });
  await strategy.deployed();
  console.log("Strategy deployed to:", strategy.address);

  // Initialize strategy
  console.log("\n=== Initializing Strategy ===");
  const commonAddresses = {
    vault: ethers.constants.AddressZero, // Will be set after vault initialization
    keeper: deployer.address,
    strategist: deployer.address,
    unirouter: addresses.beefySwapper || ethers.constants.AddressZero,
    beefyFeeRecipient: deployer.address,
    beefyFeeConfig: addresses.beefyFeeConfig,
  };

  const initParams = {
    pool: config.pool,
    quoter: config.quoter,
    positionWidth: config.positionWidth,
    native: config.native,
    factory: config.factory,
    beefyOracle: addresses.beefyOracle,
  };

  await strategy.initialize(initParams, commonAddresses, { gasLimit: 5000000 });
  console.log("Strategy initialized");

  // Deploy vault instance using factory pattern (similar to existing pattern)
  console.log("\n=== Creating CLM Vault Instance ===");
  const VaultConcLiq = await ethers.getContractFactory("BeefyVaultConcLiqHedera");
  const vaultInstance = await VaultConcLiq.deploy({ gasLimit: 5000000 });
  await vaultInstance.deployed();
  console.log("Vault instance deployed to:", vaultInstance.address);

  // Initialize vault
  console.log("\n=== Initializing Vault ===");
  await vaultInstance.initialize(strategy.address, config.vaultName, config.vaultSymbol, addresses.beefyOracle, {
    gasLimit: 5000000,
  });
  console.log("Vault initialized");

  // Update strategy vault address
  console.log("\n=== Updating Strategy Vault Address ===");
  await strategy.setVault(vaultInstance.address, { gasLimit: 1000000 });
  console.log("Strategy vault address updated");

  // Set recommended parameters
  console.log("\n=== Setting Recommended Parameters ===");

  // Set max tick deviation (example: 200 ticks)
  const maxTickDeviation = 200;
  await strategy.setDeviation(maxTickDeviation, { gasLimit: 1000000 });
  console.log(`Max tick deviation set to: ${maxTickDeviation}`);

  // Set TWAP interval (example: 300 seconds = 5 minutes)
  const twapInterval = 300;
  await strategy.setTwapInterval(twapInterval, { gasLimit: 1000000 });
  console.log(`TWAP interval set to: ${twapInterval} seconds`);

  console.log("\n=== Deployment Summary ===");
  console.log(`Strategy: ${strategy.address}`);
  console.log(`Vault: ${vaultInstance.address}`);
  console.log(`Pool: ${config.pool}`);
  console.log(`Token0: ${config.token0}`);
  console.log(`Token1: ${config.token1}`);
  console.log(`Position Width: ${config.positionWidth}`);
  console.log(`Max Tick Deviation: ${maxTickDeviation}`);
  console.log(`TWAP Interval: ${twapInterval}s`);

  console.log("\n=== Next Steps ===");
  console.log("1. HBAR/WHBAR functionality:");
  console.log(`   • Users can deposit native HBAR (auto-wrapped to WHBAR)`);
  console.log(`   • Users can withdraw as WHBAR or native HBAR (withdrawAsHBAR)`);
  console.log(`   • WHBAR addresses are hardcoded in vault contract`);
  console.log("3. Transfer ownership to appropriate multisig:");
  console.log(`   await strategy.transferOwnership("0x...")`);
  console.log(`   await vaultInstance.transferOwnership("0x...")`);
  console.log("4. Test deposit/withdraw functionality on testnet:");
  console.log(`   • Test HBAR deposit: vault.deposit(amount0, amount1, minShares, {value: hbarAmount})`);
  console.log(`   • Test HBAR withdrawal: vault.withdrawAsHBAR(shares, minAmount0, minAmount1)`);
  console.log("5. Associate any additional HTS tokens if needed:");
  console.log(`   await strategy.associateToken("0x...") // All tokens auto-detected as HTS`);
  console.log("6. Verify contracts on Hedera explorer if needed");

  // Save deployment info
  const deploymentInfo = {
    strategy: strategy.address,
    vault: vaultInstance.address,
    pool: config.pool,
    token0: config.token0,
    token1: config.token1,
    positionWidth: config.positionWidth,
    maxTickDeviation: maxTickDeviation,
    twapInterval: twapInterval,
    deployer: deployer.address,
    deploymentTime: new Date().toISOString(),
    chainType: CHAIN_TYPE,
  };

  console.log("\n=== Deployment Info (JSON) ===");
  console.log(JSON.stringify(deploymentInfo, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
