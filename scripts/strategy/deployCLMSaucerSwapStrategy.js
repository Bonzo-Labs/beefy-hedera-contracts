const hardhat = require("hardhat");

/**
 * Script to deploy or initialize StrategyPassiveManagerSaucerSwap for CLM (Concentrated Liquidity Management)
 *
 * Usage:
 * Deploy new contracts:
 * CHAIN_TYPE=testnet npx hardhat run scripts/strategy/deployCLMSaucerSwapStrategy.js --network hedera_testnet
 * CHAIN_TYPE=mainnet npx hardhat run scripts/strategy/deployCLMSaucerSwapStrategy.js --network hedera_mainnet
 * 
 * Initialize existing contract:
 * CHAIN_TYPE=testnet INITIALIZE_EXISTING=true npx hardhat run scripts/strategy/deployCLMSaucerSwapStrategy.js --network hedera_testnet
 *
 * Note: All tokens on Hedera are automatically detected as HTS tokens except native HBAR.
 * No need to specify token types manually.
 */

const ethers = hardhat.ethers;

//*******************SET CHAIN TYPE HERE*******************
const CHAIN_TYPE = process.env.CHAIN_TYPE;
const INITIALIZE_EXISTING = process.env.INITIALIZE_EXISTING === "true";
//*******************SET CHAIN TYPE HERE*******************

// Existing deployed contract addresses (for initialization mode)
const EXISTING_STRATEGY_ADDRESS = "0x1b76e2ddA5D44d594cfD435113da598AA6742648";
const EXISTING_VAULT_ADDRESS = "0xb6B12E09dF6B245E4C2DC612F610a8eC2AdebC5F";

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
  console.log("Account:", deployer.address);
  console.log("Account balance:", (await deployer.getBalance()).toString());
  console.log("Chain type:", CHAIN_TYPE);
  console.log("Mode:", INITIALIZE_EXISTING ? "Initialize Existing" : "Deploy New");

  // Validate infrastructure addresses
  if (!addresses.beefyFeeConfig || addresses.beefyFeeConfig === ethers.constants.AddressZero) {
    throw new Error("BeefyFeeConfig address not found. Please run deployChain.js first.");
  }

  if (!addresses.beefyOracle || addresses.beefyOracle === ethers.constants.AddressZero) {
    throw new Error("BeefyOracle address not found. Please run deployChain.js first.");
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

  // Force deployment of new strategy
  return await deployNewStrategy();
}

async function initializeExistingStrategy() {
  const deployer = await ethers.getSigner();
  console.log("\n=== Initializing Existing Strategy ===");
  console.log("Strategy Address:", EXISTING_STRATEGY_ADDRESS);
  console.log("Vault Address:", EXISTING_VAULT_ADDRESS);

  // Connect to existing strategy
  const strategy = await ethers.getContractAt("StrategyPassiveManagerSaucerSwap", EXISTING_STRATEGY_ADDRESS);
  console.log("Connected to strategy at:", strategy.address);

  // Check current state
  console.log("\n=== Current Strategy State ===");
  try {
    console.log("Current pool:", await strategy.pool());
    console.log("Current vault:", await strategy.vault());
    console.log("Current position width:", (await strategy.positionWidth()).toString());
    console.log("Current owner:", await strategy.owner());
  } catch (error) {
    console.log("Error reading current state:", error.message);
  }

  // Check if already initialized by reading current state
  console.log("\n=== Checking Initialization Status ===");
  
  let isAlreadyInitialized = false;
  let currentOwner = ethers.constants.AddressZero;
  
  try {
    // Try to read owner to check if initialized
    currentOwner = await strategy.owner();
    if (currentOwner !== ethers.constants.AddressZero) {
      isAlreadyInitialized = true;
      console.log("✓ Strategy is already initialized");
      console.log("Reading current configuration...");
      
      const currentPool = await strategy.pool();
      const currentVault = await strategy.vault();
      const currentWidth = await strategy.positionWidth();
      const currentTwap = await strategy.twapInterval();
      const currentNative = await strategy.native();
      
      console.log("Current Configuration:");
      console.log("  Pool:", currentPool);
      console.log("  Vault:", currentVault);
      console.log("  Position Width:", currentWidth.toString());
      console.log("  TWAP Interval:", currentTwap.toString());
      console.log("  Native:", currentNative);
      console.log("  Owner:", currentOwner);
      
      // Check if we are the owner
      if (currentOwner.toLowerCase() === deployer.address.toLowerCase()) {
        console.log("\n✓ We are the owner, we can update parameters if needed");
      } else {
        console.log(`\n⚠️ Strategy owner is ${currentOwner}, but we are ${deployer.address}`);
        console.log("Cannot update parameters - not the owner");
      }
    }
  } catch (error) {
    console.log("Could not read owner - contract may not be initialized");
    isAlreadyInitialized = false;
  }

  if (!isAlreadyInitialized) {
    // Initialize strategy
    console.log("\n=== Initializing Strategy ===");
    
    // InitParams struct: pool, quoter, positionWidth, native, factory, beefyOracle
    const initParams = [
      config.pool,
      config.quoter,
      config.positionWidth,
      config.native,
      config.factory,
      addresses.beefyOracle,
    ];

    // CommonAddresses struct: vault, unirouter, keeper, strategist, beefyFeeRecipient, beefyFeeConfig
    const commonAddresses = [
      EXISTING_VAULT_ADDRESS,
      addresses.beefySwapper || ethers.constants.AddressZero,
      deployer.address,
      deployer.address,
      deployer.address,
      addresses.beefyFeeConfig,
    ];

    console.log("Initialization parameters:");
    console.log("  InitParams:", initParams);
    console.log("  CommonAddresses:", commonAddresses);

    try {
      const tx = await strategy.initialize(initParams, commonAddresses, { gasLimit: 5000000 });
      await tx.wait();
      console.log("✓ Strategy initialized successfully!");
      console.log("Transaction hash:", tx.hash);
    } catch (error) {
      console.error("Initialization failed:", error);
      throw error;
    }
  }

  // Verify final state
  console.log("\n=== Final Strategy State ===");
  try {
    console.log("Pool:", await strategy.pool());
    console.log("Vault:", await strategy.vault());
    console.log("Position Width:", (await strategy.positionWidth()).toString());
    console.log("TWAP Interval:", (await strategy.twapInterval()).toString());
    console.log("Native:", await strategy.native());
    console.log("Owner:", await strategy.owner());
    console.log("Quoter:", await strategy.quoter());
  } catch (error) {
    console.log("Error reading final state:", error.message);
  }

  console.log("\n=== Initialization Complete ===");
  return { strategy: EXISTING_STRATEGY_ADDRESS, vault: EXISTING_VAULT_ADDRESS };
}

async function deployNewStrategy() {
  const deployer = await ethers.getSigner();
  console.log("\n=== Deploying New Strategy ===");

  if (!addresses.clmVault || addresses.clmVault === ethers.constants.AddressZero) {
    throw new Error("CLM Vault address not found. Please run deployChain.js first.");
  }

  // Deploy library first
  console.log("\n=== Deploying SaucerSwapCLMLib ===");
  const LibraryFactory = await ethers.getContractFactory("SaucerSwapCLMLib");
  const library = await LibraryFactory.deploy({ gasLimit: 3000000 });
  await library.deployed();
  console.log("Library deployed to:", library.address);

  // Deploy vault instance first
  console.log("\n=== Creating CLM Vault Instance ===");
  const VaultConcLiq = await ethers.getContractFactory("BeefyVaultConcLiqHedera");
  const vaultInstance = await VaultConcLiq.deploy({ gasLimit: 5000000 });
  await vaultInstance.deployed();
  console.log("Vault instance deployed to:", vaultInstance.address);

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

  // Initialize strategy with proper vault address
  console.log("\n=== Initializing Strategy ===");
  
  // InitParams struct: pool, quoter, positionWidth, native, factory, beefyOracle
  const initParams = [
    config.pool,
    config.quoter,
    config.positionWidth,
    config.native,
    config.factory,
    addresses.beefyOracle,
  ];

  // CommonAddresses struct: vault, unirouter, keeper, strategist, beefyFeeRecipient, beefyFeeConfig
  const commonAddresses = [
    vaultInstance.address, // vault - use actual vault address
    addresses.beefySwapper || ethers.constants.AddressZero, // unirouter
    deployer.address, // keeper
    deployer.address, // strategist
    deployer.address, // beefyFeeRecipient
    addresses.beefyFeeConfig, // beefyFeeConfig
  ];

  console.log("Initialization parameters:");
  console.log("  InitParams:", initParams);
  console.log("  CommonAddresses:", commonAddresses);

  try {
    console.log("Calling strategy.initialize...");
    const initTx = await strategy.initialize(initParams, commonAddresses, { gasLimit: 5000000 });
    console.log("Initialization transaction hash:", initTx.hash);
    const receipt = await initTx.wait();
    console.log("Initialization transaction confirmed, status:", receipt.status);
    console.log("Strategy initialized with vault:", vaultInstance.address);
    
    // Verify initialization
    console.log("Verifying strategy initialization...");
    console.log("  Pool:", await strategy.pool());
    console.log("  Vault:", await strategy.vault());
    console.log("  Position Width:", (await strategy.positionWidth()).toString());
    console.log("  TWAP Interval:", (await strategy.twapInterval()).toString());
    console.log("  Native:", await strategy.native());
    console.log("  Owner:", await strategy.owner());
  } catch (error) {
    console.error("Strategy initialization failed:", error);
    throw error;
  }

  // Initialize vault with strategy address
  console.log("\n=== Initializing Vault ===");
  await vaultInstance.initialize(strategy.address, config.vaultName, config.vaultSymbol, addresses.beefyOracle, {
    gasLimit: 5000000,
  });
  console.log("Vault initialized with strategy:", strategy.address);

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
  
  return { strategy: strategy.address, vault: vaultInstance.address };
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
