const hardhat = require("hardhat");
const { upgrades } = require("hardhat");

/**
 * Script to deploy SaucerSwapLariRewardsCLMStrategy using Hardhat Upgrades Plugin
 * This is MUCH simpler than manual ProxyAdmin management!
 *
 * Usage:
 * CHAIN_TYPE=testnet npx hardhat run scripts/strategy/deployCLMSaucerSwapLariRewardsStrategyWithHardhatUpgrades.js --network hedera_testnet
 * CHAIN_TYPE=mainnet npx hardhat run scripts/strategy/deployCLMSaucerSwapLariRewardsStrategyWithHardhatUpgrades.js --network hedera_mainnet
 *
 * Benefits:
 * - Automatic ProxyAdmin management
 * - Built-in storage layout validation
 * - Simpler upgrade process
 * - Better error messages
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
    pool: process.env.SAUCERSWAP_POOL_ADDRESS || "0x1a6ca726e07a11849176b3c3b8e2ceda7553b9aa",
    quoter: process.env.SAUCERSWAP_QUOTER_ADDRESS || "0x00000000000000000000000000000000001535b2",
    factory: process.env.SAUCERSWAP_FACTORY_ADDRESS || "0x00000000000000000000000000000000001243ee",
    unirouter: process.env.UNIROUTER_ADDRESS || "0x0000000000000000000000000000000000159398",
  
    token0: process.env.TOKEN0_ADDRESS || "0x00000000000000000000000000000000000014f5", 
    token1: process.env.TOKEN1_ADDRESS || "0x0000000000000000000000000000000000120f46",
    native: "0x0000000000000000000000000000000000003ad2", // WHBAR testnet

    rewardTokens: process.env.REWARD_TOKENS
      ? process.env.REWARD_TOKENS.split(",")
      : [
          "0x0000000000000000000000000000000000120f46", // SAUCE
          "0x0000000000000000000000000000000000003ad2", // WHBAR
        ],

    positionWidth: parseInt(process.env.POSITION_WIDTH) || 200,
    vaultName: process.env.VAULT_NAME || "Beefy CLM LARI SaucerSwap Testnet",
    vaultSymbol: process.env.VAULT_SYMBOL || "bCLM-LARI-SS-T",
  };
} else if (CHAIN_TYPE === "mainnet") {
  config = {
    // USDC-HBAR pool: 0xc5b707348da504e9be1bd4e21525459830e7b11d
    // USDC-SAUCE pool: 0x36acdfe1cbf9098bdb7a3c62b8eaa1016c111e31
    // PACK-XPACK pool: 0x3f5c61862e3546f5424d3f2da46cdb00128c390c
    // SAUCE-XSAUCE pool: 0xcfeffaae43f176f91602d75ec1d0637e273c973b
    // BONZO-XBONZO pool: 0xf6cc94f16bc141115fcb9b587297aecfa14f4eb6
    // USDC-WETH hts pool: 0x335b3a8aaaecd63019091187dc8d99574f6552d0
    pool: process.env.SAUCERSWAP_POOL_ADDRESS || "0xcfeffaae43f176f91602d75ec1d0637e273c973b",
    quoter: process.env.SAUCERSWAP_QUOTER_ADDRESS || "0x00000000000000000000000000000000003c4370",
    factory: process.env.SAUCERSWAP_FACTORY_ADDRESS || "0x00000000000000000000000000000000003c3951",
    unirouter: process.env.UNIROUTER_ADDRESS || "0x00000000000000000000000000000000003c437a",
    
    // Token addresses (mainnet)
    // USDC: 0x000000000000000000000000000000000006f89a
    // HBAR: 0x0000000000000000000000000000000000163b5a
    // SAUCE:0x00000000000000000000000000000000000b2ad5
    // PACK: 0x0000000000000000000000000000000000492a28
    // XPACK:0x00000000000000000000000000000000006e86ce
    // XSAUCE:0x00000000000000000000000000000000001647e8
    // BONZO: 0x00000000000000000000000000000000007e545e
    // XBONZO:0x0000000000000000000000000000000000818e2d
    // WETH: 0x0000000000000000000000000000000000951679
    token0: process.env.TOKEN0_ADDRESS || "0x00000000000000000000000000000000000b2ad5",
    token1: process.env.TOKEN1_ADDRESS || "0x00000000000000000000000000000000001647e8",
    native: "0x0000000000000000000000000000000000163b5a", // WHBAR mainnet

    rewardTokens: process.env.REWARD_TOKENS
      ? process.env.REWARD_TOKENS.split(",")
      : [
          "0x0000000000000000000000000000000000163b5a", // WHBAR
          "0x00000000000000000000000000000000000b2ad5", // SAUCE
          "0x0000000000000000000000000000000000492a28" // PACK
        ],

    positionWidth: 30,
    maxDeviation: 30,
    twapInterval: 300,
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
  console.log("Mode: Deploy with Hardhat Upgrades Plugin 🚀");

  // Validate infrastructure addresses
  if (!addresses.beefyFeeConfig || addresses.beefyFeeConfig === ethers.constants.AddressZero) {
    throw new Error("BeefyFeeConfig address not found. Please run deployChain.js first.");
  }

  if (!addresses.beefyOracle || addresses.beefyOracle === ethers.constants.AddressZero) {
    throw new Error("BeefyOracle address not found. Please run deployChain.js first.");
  }

  console.log("Configuration:");
  console.log("  Pool:", config.pool);
  console.log("  Token0:", config.token0);
  console.log("  Token1:", config.token1);
  console.log("  Position Width:", config.positionWidth);
  console.log("  Native Token:", config.native);
  console.log("  Reward Tokens:", config.rewardTokens);

  return await deployStrategyWithHardhatUpgrades();
}

async function deployStrategyWithHardhatUpgrades() {
  const deployer = await ethers.getSigner();
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║     DEPLOYING WITH HARDHAT UPGRADES PLUGIN                     ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  if (!addresses.clmVault || addresses.clmVault === ethers.constants.AddressZero) {
    throw new Error("CLM Vault address not found. Please run deployChain.js first.");
  }

  // Deploy libraries
  console.log("\n=== Step 1: Deploy Libraries ===");
  const CLMLibraryFactory = await ethers.getContractFactory("SaucerSwapCLMLib");
  const clmLibrary = await CLMLibraryFactory.deploy({ gasLimit: 5000000 });
  await clmLibrary.deployed();
  console.log("✅ CLM Library deployed:", clmLibrary.address);

  const LariLibraryFactory = await ethers.getContractFactory("SaucerSwapLariLib", {
    libraries: {
      SaucerSwapCLMLib: clmLibrary.address,
    },
  });
  const lariLibrary = await LariLibraryFactory.deploy({ gasLimit: 5000000 });
  await lariLibrary.deployed();
  console.log("✅ LARI Library deployed:", lariLibrary.address);

  // Create vault instance
  console.log("\n=== Step 2: Create CLM Vault ===");
  const vaultFactoryAddress = addresses.vaultFactory;
  if (!vaultFactoryAddress || vaultFactoryAddress === ethers.constants.AddressZero) {
    throw new Error("Vault factory address not found.");
  }

  const vaultFactory = await ethers.getContractAt("BonzoVaultV7Factory", vaultFactoryAddress);
  const tx = await vaultFactory.cloneVaultCLM({ gasLimit: 1000000 });
  const receipt = await tx.wait();

  const proxyCreatedEvent = receipt.events?.find(e => e.event === "ProxyCreated");
  const vaultAddress = proxyCreatedEvent?.args?.proxy;
  if (!vaultAddress) {
    throw new Error("Failed to get vault address from ProxyCreated event");
  }

  console.log("✅ CLM vault created:", vaultAddress);
  const vaultInstance = await ethers.getContractAt("BonzoVaultConcLiq", vaultAddress);

  // Deploy strategy using Hardhat Upgrades plugin
  console.log("\n=== Step 3: Deploy Strategy with Hardhat Upgrades ===");
  
  const StrategyFactory = await ethers.getContractFactory("SaucerSwapLariRewardsCLMStrategy", {
    libraries: {
      SaucerSwapCLMLib: clmLibrary.address,
      SaucerSwapLariLib: lariLibrary.address,
    },
  });

  // Prepare initialization parameters
  const initParams = [
    config.pool,
    config.positionWidth,
    config.native,
    config.factory,
    addresses.beefyOracle,
    config.rewardTokens,
  ];

  const commonAddresses = [
    vaultInstance.address,
    config.unirouter,
    deployer.address, // keeper
    deployer.address, // strategist
    deployer.address, // beefyFeeRecipient
    addresses.beefyFeeConfig,
  ];

  console.log("Deploying upgradeable proxy...");
  console.log("  This will automatically:");
  console.log("  • Deploy ProxyAdmin (if needed)");
  console.log("  • Deploy Implementation");
  console.log("  • Deploy TransparentUpgradeableProxy");
  console.log("  • Initialize the strategy");

  // 🎉 THE MAGIC HAPPENS HERE - One line does it all!
  const strategy = await upgrades.deployProxy(
    StrategyFactory,
    [initParams, commonAddresses],
    {
      initializer: 'initialize',
      kind: 'transparent',
      unsafeAllowLinkedLibraries: true, // Required for linked libraries
      txOverrides: { gasLimit: 8000000 }
    }
  );

  await strategy.deployed();
  
  console.log("✅ Strategy proxy deployed:", strategy.address);
  
  // Get implementation and admin addresses
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(strategy.address);
  const adminAddress = await upgrades.erc1967.getAdminAddress(strategy.address);
  
  console.log("✅ Implementation address:", implementationAddress);
  console.log("✅ ProxyAdmin address:", adminAddress);

  // Verify initialization
  console.log("\n=== Step 4: Verify Strategy Initialization ===");
  try {
    console.log("  Pool:", await strategy.pool());
    console.log("  Vault:", await strategy.vault());
    console.log("  Position Width:", (await strategy.positionWidth()).toString());
    console.log("  TWAP Interval:", (await strategy.twapInterval()).toString());
    console.log("  Native:", await strategy.native());
    console.log("  Owner:", await strategy.owner());
    console.log("  Token 0:", await strategy.lpToken0());
    console.log("  Token 1:", await strategy.lpToken1());
    console.log("  Reward Tokens:", (await strategy.getRewardTokensLength()).toString());
    console.log("✅ Strategy initialized successfully");
  } catch (error) {
    console.error("❌ Strategy verification failed:", error);
    throw error;
  }

  // Initialize vault
  console.log("\n=== Step 5: Initialize Vault ===");
  try {
    const token0 = await strategy.lpToken0();
    const token1 = await strategy.lpToken1();

    const vaultInitTx = await vaultInstance.initialize(
      strategy.address,
      config.vaultName,
      config.vaultSymbol,
      addresses.beefyOracle,
      token0,
      token1,
      { gasLimit: 5000000 }
    );

    await vaultInitTx.wait();
    console.log("✅ Vault initialized with strategy:", strategy.address);

    const vaultStrategy = await vaultInstance.strategy();
    if (vaultStrategy.toLowerCase() !== strategy.address.toLowerCase()) {
      throw new Error("Vault strategy reference doesn't match!");
    }
  } catch (error) {
    console.error("❌ Vault initialization failed:", error.message);
    throw error;
  }

  // Set parameters
  console.log("\n=== Step 6: Set Strategy Parameters ===");
  try {
    const uniswapV3Pool = await ethers.getContractAt(
      "contracts/BIFI/interfaces/saucerswap/IUniswapV3Pool.sol:IUniswapV3Pool",
      config.pool
    );
    const tickSpacing = await uniswapV3Pool.tickSpacing();
    console.log(`Tick spacing: ${tickSpacing}`);

    if (config.maxDeviation) {
      const deviationTx = await strategy.setDeviation(config.maxDeviation, { gasLimit: 1000000 });
      await deviationTx.wait();
      console.log(`✅ Max tick deviation set: ${config.maxDeviation}`);
    }

    if (config.twapInterval) {
      const twapTx = await strategy.setTwapInterval(config.twapInterval, { gasLimit: 1000000 });
      await twapTx.wait();
      console.log(`✅ TWAP interval set: ${config.twapInterval}s`);
    }
  } catch (error) {
    console.warn("⚠️  Failed to set parameters:", error.message);
  }

  // Configure reward routes
  console.log("\n=== Step 7: Configure Reward Routes ===");
  try {
    const rewardRoutes = require("./mainnet-reward-routes.js");
    for (let i = 0; i < config.rewardTokens.length; i++) {
      const rewardToken = config.rewardTokens[i];
      const route = rewardRoutes[rewardToken][config.token0].route;
      const fees = rewardRoutes[rewardToken][config.token0].fees;
      const route2 = rewardRoutes[rewardToken][config.token1].route;
      const fees2 = rewardRoutes[rewardToken][config.token1].fees;
      
      await strategy.setRewardRoute(rewardToken, route, route2, fees, fees2, { gasLimit: 1000000 });
      console.log(`✅ Routes set for ${rewardToken}`);
    }
  } catch (error) {
    console.warn("⚠️  Failed to configure routes:", error.message);
  }

  // Deployment summary
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                 DEPLOYMENT SUCCESSFUL! ✅                       ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  console.log("\n📦 Core Contracts:");
  console.log(`  Strategy Proxy:      ${strategy.address}`);
  console.log(`  Implementation:      ${implementationAddress}`);
  console.log(`  ProxyAdmin:          ${adminAddress}`);
  console.log(`  Vault:               ${vaultInstance.address}`);
  
  console.log("\n📚 Libraries:");
  console.log(`  CLM Library:         ${clmLibrary.address}`);
  console.log(`  LARI Library:        ${lariLibrary.address}`);
  
  console.log("\n⚙️  Configuration:");
  console.log(`  Pool:                ${config.pool}`);
  console.log(`  Token0:              ${config.token0}`);
  console.log(`  Token1:              ${config.token1}`);
  console.log(`  Position Width:      ${config.positionWidth}`);
  console.log(`  Reward Tokens:       ${config.rewardTokens.length}`);

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                  UPGRADE INSTRUCTIONS                          ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  console.log("\n🔄 To upgrade in the future, simply run:");
  console.log(`\nCHAIN_TYPE=${CHAIN_TYPE} PROXY_ADDRESS=${strategy.address} \\`);
  console.log("npx hardhat run scripts/strategy/upgradeCLMSaucerSwapLariRewardsStrategyWithHardhatUpgrades.js --network hedera_" + CHAIN_TYPE);
  
  console.log("\n✨ That's it! Hardhat Upgrades handles:");
  console.log("  • ProxyAdmin management automatically");
  console.log("  • Storage layout validation");
  console.log("  • Upgrade safety checks");
  console.log("  • Implementation deployment");

  console.log("\n🔐 Security:");
  console.log("  • ProxyAdmin owner:", deployer.address);
  console.log("  • Transfer ownership to multisig when ready");
  console.log("  • Run upgrades with the same account");

  // Save deployment info
  const deploymentInfo = {
    strategyProxy: strategy.address,
    strategyImplementation: implementationAddress,
    proxyAdmin: adminAddress,
    vault: vaultInstance.address,
    clmLibrary: clmLibrary.address,
    lariLibrary: lariLibrary.address,
    pool: config.pool,
    token0: config.token0,
    token1: config.token1,
    positionWidth: config.positionWidth,
    maxTickDeviation: config.maxDeviation,
    twapInterval: config.twapInterval,
    rewardTokens: config.rewardTokens,
    deployer: deployer.address,
    deploymentTime: new Date().toISOString(),
    chainType: CHAIN_TYPE,
    isUpgradeable: true,
    managedBy: "hardhat-upgrades",
  };

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                 DEPLOYMENT INFO (JSON)                         ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(JSON.stringify(deploymentInfo, null, 2));

  return deploymentInfo;
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });

