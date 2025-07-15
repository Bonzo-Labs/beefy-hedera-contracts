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
    // pool: process.env.SAUCERSWAP_POOL_ADDRESS || "0x37814edc1ae88cf27c0c346648721fb04e7e0ae7", // SAUCE-WHBAR pool
    pool: process.env.SAUCERSWAP_POOL_ADDRESS || "0x1a6ca726e07a11849176b3c3b8e2ceda7553b9aa", // SAUCE-CLXY pool
    quoter: process.env.SAUCERSWAP_QUOTER_ADDRESS || "0x00000000000000000000000000000000001535b2",
    factory: process.env.SAUCERSWAP_FACTORY_ADDRESS || "0x00000000000000000000000000000000001243ee",

    // Token addresses (testnet)
    token0: process.env.TOKEN0_ADDRESS || "0x00000000000000000000000000000000000014f5", // CLXY
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
    // USDC-HBAR pool: 0xc5b707348da504e9be1bd4e21525459830e7b11d
    // USDC-SAUCE pool: 0x36acdfe1cbf9098bdb7a3c62b8eaa1016c111e31
    pool: process.env.SAUCERSWAP_POOL_ADDRESS || "0xc5b707348da504e9be1bd4e21525459830e7b11d", // Update with actual mainnet pool
    quoter: process.env.SAUCERSWAP_QUOTER_ADDRESS || "0x00000000000000000000000000000000003c4370", // Update with actual mainnet quoter
    factory: process.env.SAUCERSWAP_FACTORY_ADDRESS || "0x00000000000000000000000000000000003c3951", // Update with actual mainnet factory

    // Token addresses (mainnet)
    // USDC: 0x000000000000000000000000000000000006f89a
    // HBAR: 0x0000000000000000000000000000000000163b5a
    // SAUCE: 0x00000000000000000000000000000000000b2ad5
    token0: process.env.TOKEN0_ADDRESS || "0x000000000000000000000000000000000006f89a", // Update with actual mainnet token0
    token1: process.env.TOKEN1_ADDRESS || "0x0000000000000000000000000000000000163b5a", // Update with actual mainnet token1

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

  // Always deploy new strategy
  return await deployNewStrategy();
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

  // Create vault instance using factory
  console.log("\n=== Creating CLM Vault Instance via Factory ===");

  // Connect to the vault factory
  const vaultFactoryAddress = addresses.vaultFactory;
  if (!vaultFactoryAddress || vaultFactoryAddress === ethers.constants.AddressZero) {
    throw new Error("Vault factory address not found. Please deploy factory first.");
  }

  const vaultFactory = await ethers.getContractAt("BeefyVaultV7FactoryHedera", vaultFactoryAddress);
  console.log("Connected to vault factory at:", vaultFactoryAddress);

  // Create new CLM vault using the factory
  console.log("Creating new CLM vault...");
  const tx = await vaultFactory.cloneVaultCLM({ gasLimit: 1000000 });
  const receipt = await tx.wait();

  // Get the new vault address from the ProxyCreated event
  const proxyCreatedEvent = receipt.events?.find(e => e.event === "ProxyCreated");
  const vaultAddress = proxyCreatedEvent?.args?.proxy;
  if (!vaultAddress) {
    throw new Error("Failed to get vault address from ProxyCreated event");
  }

  console.log("New CLM vault created at:", vaultAddress);

  // Connect to the newly created vault
  const vaultInstance = await ethers.getContractAt("BeefyVaultConcLiqHedera", vaultAddress);

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
    console.log("  Token 0:", await strategy.lpToken0());
    console.log("  Token 1:", await strategy.lpToken1());
  } catch (error) {
    console.error("Strategy initialization failed:", error);
    throw error;
  }

  // Initialize vault with strategy address
  console.log("\n=== Initializing Vault ===");

  try {
    console.log("Calling vault.initialize...");
    console.log("  Strategy Address:", strategy.address);
    console.log("  Vault Name:", config.vaultName);
    console.log("  Vault Symbol:", config.vaultSymbol);
    console.log("  Oracle Address:", addresses.beefyOracle);

    // Get token addresses from the strategy
    const token0 = await strategy.lpToken0();
    const token1 = await strategy.lpToken1();
    
    console.log("  Token0:", token0);
    console.log("  Token1:", token1);

    const vaultInitTx = await vaultInstance.initialize(
      strategy.address,
      config.vaultName,
      config.vaultSymbol,
      addresses.beefyOracle,
      token0,
      token1,
      { gasLimit: 5000000 }
    );

    console.log("Vault initialization transaction hash:", vaultInitTx.hash);
    const vaultReceipt = await vaultInitTx.wait();

    console.log("Vault initialization transaction confirmed:");
    console.log("  Status:", vaultReceipt.status);
    console.log("  Gas Used:", vaultReceipt.gasUsed.toString());
    console.log("  Block Number:", vaultReceipt.blockNumber);

    // Check for any events that might indicate issues
    if (vaultReceipt.events && vaultReceipt.events.length > 0) {
      console.log("  Events:");
      vaultReceipt.events.forEach((event, index) => {
        console.log(`    ${index + 1}. ${event.event || "Unknown Event"}:`, event.args || event.data);
      });
    }

    if (vaultReceipt.status !== 1) {
      throw new Error(`Vault initialization transaction failed with status: ${vaultReceipt.status}`);
    }

    console.log("✅ Vault successfully initialized with strategy:", strategy.address);

    // Verify vault initialization by checking strategy reference
    try {
      const vaultStrategy = await vaultInstance.strategy();
      console.log("  Verified vault strategy reference:", vaultStrategy);
      if (vaultStrategy.toLowerCase() !== strategy.address.toLowerCase()) {
        console.warn("⚠️  WARNING: Vault strategy reference doesn't match deployed strategy!");
      }
    } catch (verifyError) {
      console.warn("⚠️  Could not verify vault strategy reference:", verifyError.message);
    }
  } catch (error) {
    console.error("❌ Vault initialization failed:");
    console.error("  Error message:", error.message);

    if (error.transaction) {
      console.error("  Transaction hash:", error.transaction.hash);
    }

    if (error.receipt) {
      console.error("  Transaction status:", error.receipt.status);
      console.error("  Gas used:", error.receipt.gasUsed.toString());

      // Log any revert reason if available
      if (error.receipt.logs && error.receipt.logs.length > 0) {
        console.error("  Transaction logs:");
        error.receipt.logs.forEach((log, index) => {
          console.error(`    ${index + 1}. Log:`, log);
        });
      }
    }

    if (error.reason) {
      console.error("  Revert reason:", error.reason);
    }

    if (error.code) {
      console.error("  Error code:", error.code);
    }

    // Provide helpful debugging information
    console.error("\n🔍 Debugging Information:");
    console.error("  - Check if vault proxy was created correctly");
    console.error("  - Verify strategy address is valid:", strategy.address);
    console.error("  - Check if oracle address is valid:", addresses.beefyOracle);
    console.error("  - Ensure vault hasn't been initialized before");
    console.error("  - Verify token association succeeded in vault");

    throw new Error(`Vault initialization failed: ${error.message}`);
  }

  // Set recommended parameters
  console.log("\n=== Setting Recommended Parameters ===");

  try {
    // Set max tick deviation (example: 200 ticks)
    const maxTickDeviation = 200;
    console.log(`Setting max tick deviation to: ${maxTickDeviation}`);
    const deviationTx = await strategy.setDeviation(maxTickDeviation, { gasLimit: 1000000 });
    const deviationReceipt = await deviationTx.wait();

    if (deviationReceipt.status !== 1) {
      throw new Error(`Set deviation transaction failed with status: ${deviationReceipt.status}`);
    }
    console.log(`✅ Max tick deviation set to: ${maxTickDeviation}`);

    // Set TWAP interval (example: 300 seconds = 5 minutes)
    const twapInterval = 300;
    console.log(`Setting TWAP interval to: ${twapInterval} seconds`);
    const twapTx = await strategy.setTwapInterval(twapInterval, { gasLimit: 1000000 });
    const twapReceipt = await twapTx.wait();

    if (twapReceipt.status !== 1) {
      throw new Error(`Set TWAP interval transaction failed with status: ${twapReceipt.status}`);
    }
    console.log(`✅ TWAP interval set to: ${twapInterval} seconds`);
  } catch (error) {
    console.error("❌ Failed to set strategy parameters:");
    console.error("  Error message:", error.message);

    if (error.transaction) {
      console.error("  Transaction hash:", error.transaction.hash);
    }

    if (error.receipt) {
      console.error("  Transaction status:", error.receipt.status);
    }

    // Don't throw here - strategy is functional without these parameters
    console.warn("⚠️  Strategy deployed successfully but parameter setting failed");
    console.warn("  You can set these parameters manually later");
  }

  console.log("\n=== Deployment Summary ===");
  console.log(`Strategy: ${strategy.address}`);
  console.log(`Vault: ${vaultInstance.address}`);
  console.log(`Pool: ${config.pool}`);
  console.log(`Token0: ${config.token0}`);
  console.log(`Token1: ${config.token1}`);
  console.log(`Position Width: ${config.positionWidth}`);
  console.log(`Max Tick Deviation: 200 (if set successfully)`);
  console.log(`TWAP Interval: 300s (if set successfully)`);

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
    maxTickDeviation: 200, // Default value
    twapInterval: 300, // Default value
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
