const hardhat = require("hardhat");

/**
 * Script to deploy SaucerSwapLariRewardsCLMStrategy for CLM (Concentrated Liquidity Management) with LARI rewards
 *
 * Usage:
 * CHAIN_TYPE=testnet npx hardhat run scripts/strategy/deployCLMSaucerSwapLariRewardsStrategy.js --network hedera_testnet
 * CHAIN_TYPE=mainnet npx hardhat run scripts/strategy/deployCLMSaucerSwapLariRewardsStrategy.js --network hedera_mainnet
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
    // HBAR-SAUCE pool 0x37814edc1ae88cf27c0c346648721fb04e7e0ae7
    // SAUCE-CLXY pool 0x1a6ca726e07a11849176b3c3b8e2ceda7553b9aa
    pool: process.env.SAUCERSWAP_POOL_ADDRESS || "0x37814edc1ae88cf27c0c346648721fb04e7e0ae7", // HBAR-SAUCE pool
    quoter: process.env.SAUCERSWAP_QUOTER_ADDRESS || "0x00000000000000000000000000000000001535b2",
    factory: process.env.SAUCERSWAP_FACTORY_ADDRESS || "0x00000000000000000000000000000000001243ee",
    unirouter: process.env.UNIROUTER_ADDRESS || "0x0000000000000000000000000000000000159398",
    // Token addresses (testnet)
    // CLXY 0x00000000000000000000000000000000000014f5
    // WHBAR 0x0000000000000000000000000000000000003ad2
    token0: process.env.TOKEN0_ADDRESS || "0x0000000000000000000000000000000000003aD2", // HBAR
    token1: process.env.TOKEN1_ADDRESS || "0x0000000000000000000000000000000000120f46", // SAUCE

    // Native token (WHBAR)
    native: "0x0000000000000000000000000000000000003ad2", // WHBAR testnet

    // LARI reward tokens (testnet)
    rewardTokens: process.env.REWARD_TOKENS
      ? process.env.REWARD_TOKENS.split(",")
      : [
          "0x0000000000000000000000000000000000120f46", // SAUCE
          "0x0000000000000000000000000000000000003ad2", // WHBAR
        ],

    // Position configuration
    positionWidth: parseInt(process.env.POSITION_WIDTH) || 200,

    // Vault configuration
    vaultName: process.env.VAULT_NAME || "Beefy CLM LARI SaucerSwap Testnet",
    vaultSymbol: process.env.VAULT_SYMBOL || "bCLM-LARI-SS-T",
  };
} else if (CHAIN_TYPE === "mainnet") {
  config = {
    // SaucerSwap V3 addresses (mainnet)
    pool: process.env.SAUCERSWAP_POOL_ADDRESS || "0x", // Update with actual mainnet pool
    quoter: process.env.SAUCERSWAP_QUOTER_ADDRESS || "0x", // Update with actual mainnet quoter
    factory: process.env.SAUCERSWAP_FACTORY_ADDRESS || "0x", // Update with actual mainnet factory
    unirouter: process.env.UNIROUTER_ADDRESS || "0x", // Update with actual mainnet unirouter
    // Token addresses (mainnet)
    token0: process.env.TOKEN0_ADDRESS || "0x", // Update with actual mainnet token0
    token1: process.env.TOKEN1_ADDRESS || "0x", // Update with actual mainnet token1

    // Native token (WHBAR)
    native: "0x0000000000000000000000000000000000163b5a", // WHBAR mainnet

    // LARI reward tokens (mainnet)
    rewardTokens: process.env.REWARD_TOKENS
      ? process.env.REWARD_TOKENS.split(",")
      : [
          // Add mainnet reward tokens here
        ],

    // Position configuration
    positionWidth: parseInt(process.env.POSITION_WIDTH) || 200,

    // Vault configuration
    vaultName: process.env.VAULT_NAME || "Beefy CLM LARI SaucerSwap",
    vaultSymbol: process.env.VAULT_SYMBOL || "bCLM-LARI-SS",
  };
}

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();
  console.log("Account:", deployer.address);
  console.log("Account balance:", (await deployer.getBalance()).toString());
  console.log("Chain type:", CHAIN_TYPE);
  console.log("Mode: Deploy New CLM LARI Strategy");

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
  console.log("  Reward Tokens:", config.rewardTokens);

  // Always deploy new strategy
  return await deployNewStrategy();
}

async function deployNewStrategy() {
  const deployer = await ethers.getSigner();
  console.log("\n=== Deploying New CLM LARI Strategy ===");

  if (!addresses.clmVault || addresses.clmVault === ethers.constants.AddressZero) {
    throw new Error("CLM Vault address not found. Please run deployChain.js first.");
  }

  // Deploy both libraries
  console.log("\n=== Deploying SaucerSwapCLMLib ===");
  const CLMLibraryFactory = await ethers.getContractFactory("SaucerSwapCLMLib");
  const clmLibrary = await CLMLibraryFactory.deploy({ gasLimit: 5000000 });
  await clmLibrary.deployed();
  console.log("CLM Library deployed to:", clmLibrary.address);

  console.log("\n=== Deploying SaucerSwapLariLib ===");
  const LariLibraryFactory = await ethers.getContractFactory("SaucerSwapLariLib", {
    libraries: {
      SaucerSwapCLMLib: clmLibrary.address,
    },
  });
  const lariLibrary = await LariLibraryFactory.deploy({ gasLimit: 5000000 });
  await lariLibrary.deployed();
  console.log("LARI Library deployed to:", lariLibrary.address);

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
  console.log("\n=== Deploying SaucerSwapLariRewardsCLMStrategy ===");
  const StrategyFactory = await ethers.getContractFactory("SaucerSwapLariRewardsCLMStrategy", {
    libraries: {
      SaucerSwapCLMLib: clmLibrary.address,
      SaucerSwapLariLib: lariLibrary.address,
    },
  });

  const strategy = await StrategyFactory.deploy({ gasLimit: 8000000 });
  await strategy.deployed();
  console.log("Strategy deployed to:", strategy.address);

  // Initialize strategy with proper vault address
  console.log("\n=== Initializing Strategy ===");

  // InitParams struct: pool, quoter, positionWidth, native, factory, beefyOracle, rewardTokens
  const initParams = [
    config.pool,
    config.quoter,
    config.positionWidth,
    config.native,
    config.factory,
    addresses.beefyOracle,
    config.rewardTokens,
  ];

  // CommonAddresses struct: vault, unirouter, keeper, strategist, beefyFeeRecipient, beefyFeeConfig
  const commonAddresses = [
    vaultInstance.address, // vault - use actual vault address
    config.unirouter,
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
    const initTx = await strategy.initialize(initParams, commonAddresses, 
      { gasLimit: 6000000 });
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
    console.log("  Reward Tokens Length:", (await strategy.getRewardTokensLength()).toString());
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

  // Configure reward token routes if specified
  console.log("\n=== Configuring Reward Token Routes ===");
  for (let i = 0; i < config.rewardTokens.length; i++) {
    const rewardToken = config.rewardTokens[i];
    console.log(`Setting routes for reward token ${i}: ${rewardToken}`);

    // Example routes - update these based on your specific token routing needs
    let toLp0Route = [];
    let toLp1Route = [];

    // If reward token is different from LP tokens, set up swap routes
    // if (rewardToken !== config.token0 && rewardToken !== config.token1) {
      // Example: SAUCE -> CLXY route (via WHBAR if needed)
      if (rewardToken === "0x0000000000000000000000000000000000120f46") {
        // SAUCE
        toLp0Route =  config.token0.toLowerCase() == config.native.toLowerCase() ? 
        [rewardToken, config.token0] 
        : 
        [rewardToken, config.native, config.token0]; // SAUCE -> WHBAR -> CLXY
        
        toLp1Route = [rewardToken, config.token1]; // SAUCE -> SAUCE (direct)
      } else if(rewardToken.toLowerCase() == config.native.toLowerCase()){
        toLp0Route = [rewardToken, config.token0];
        toLp1Route = [rewardToken, config.token1];
      }
      else {
        // Generic route via native token
        toLp0Route = config.token0.toLowerCase() == config.native.toLowerCase() ? 
        [rewardToken, config.token0] 
        : 
        [rewardToken, config.native, config.token0];
        
        toLp1Route = config.token1.toLowerCase() == config.native.toLowerCase() ? 
        [rewardToken, config.token1] 
        : 
        [rewardToken, config.native, config.token1];
      }

      try {
        await strategy.setRewardRoute(rewardToken, toLp0Route, toLp1Route, { gasLimit: 1000000 });
        console.log(`  Routes set for ${rewardToken}`);
        console.log(`    To LP0: ${toLp0Route.join(" -> ")}`);
        console.log(`    To LP1: ${toLp1Route.join(" -> ")}`);
      } catch (error) {
        console.log(`  Failed to set routes for ${rewardToken}:`, error.message);
      }
    // }
  }

  console.log("\n=== Deployment Summary ===");
  console.log(`Strategy: ${strategy.address}`);
  console.log(`Vault: ${vaultInstance.address}`);
  console.log(`CLM Library: ${clmLibrary.address}`);
  console.log(`LARI Library: ${lariLibrary.address}`);
  console.log(`Pool: ${config.pool}`);
  console.log(`Token0: ${config.token0}`);
  console.log(`Token1: ${config.token1}`);
  console.log(`Position Width: ${config.positionWidth}`);
  console.log(`Max Tick Deviation: 200 (if set successfully)`);
  console.log(`TWAP Interval: 300s (if set successfully)`);
  console.log(`Reward Tokens: ${config.rewardTokens.length}`);

  console.log("\n=== Next Steps ===");
  console.log("1. LARI Rewards Configuration:");
  console.log("   • Add additional reward tokens: strategy.addRewardToken(token, isHTS)");
  console.log("   • Configure reward routes: strategy.setRewardRoute(token, toLp0Route, toLp1Route)");
  console.log("   • Enable/disable tokens: strategy.updateRewardTokenStatus(token, isActive)");
  console.log("2. HBAR/WHBAR functionality:");
  console.log(`   • Users can deposit native HBAR (auto-wrapped to WHBAR)`);
  console.log(`   • Users can withdraw as WHBAR or native HBAR (withdrawAsHBAR)`);
  console.log(`   • WHBAR addresses are hardcoded in vault contract`);
  console.log("3. Transfer ownership to appropriate multisig:");
  console.log(`   await strategy.transferOwnership("0x...")`);
  console.log(`   await vaultInstance.transferOwnership("0x...")`);
  console.log("4. Test functionality on testnet:");
  console.log(`   • Test deposit/withdraw with CLM positioning`);
  console.log(`   • Test LARI rewards harvesting`);
  console.log(`   • Test reward token management`);
  console.log("5. Associate any additional HTS tokens if needed:");
  console.log(`   await strategy.associateToken("0x...") // All tokens auto-detected as HTS`);
  console.log("6. Verify contracts on Hedera explorer if needed");

  // Save deployment info
  const deploymentInfo = {
    strategy: strategy.address,
    vault: vaultInstance.address,
    clmLibrary: clmLibrary.address,
    lariLibrary: lariLibrary.address,
    pool: config.pool,
    token0: config.token0,
    token1: config.token1,
    positionWidth: config.positionWidth,
    maxTickDeviation: 200, // Default value
    twapInterval: 300, // Default value
    rewardTokens: config.rewardTokens,
    deployer: deployer.address,
    deploymentTime: new Date().toISOString(),
    chainType: CHAIN_TYPE,
  };

  console.log("\n=== Deployment Info (JSON) ===");
  console.log(JSON.stringify(deploymentInfo, null, 2));

  return {
    strategy: strategy.address,
    vault: vaultInstance.address,
    clmLibrary: clmLibrary.address,
    lariLibrary: lariLibrary.address,
    rewardTokensLength: config.rewardTokens.length,
  };
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
