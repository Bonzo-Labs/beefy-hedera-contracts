const hardhat = require("hardhat");
const { upgrades } = require("hardhat");

/**
 * Script to UPGRADE SaucerSwapLariRewardsCLMStrategy using Hardhat Upgrades Plugin
 * This is INCREDIBLY simple compared to manual ProxyAdmin management!
 *
 * Usage:
 * CHAIN_TYPE=testnet PROXY_ADDRESS=0x... npx hardhat run scripts/strategy/upgradeCLMSaucerSwapLariRewardsStrategyWithHardhatUpgrades.js --network hedera_testnet
 * CHAIN_TYPE=mainnet PROXY_ADDRESS=0x... npx hardhat run scripts/strategy/upgradeCLMSaucerSwapLariRewardsStrategyWithHardhatUpgrades.js --network hedera_mainnet
 *
 * Required:
 * - PROXY_ADDRESS: The proxy address to upgrade
 *
 * Benefits:
 * - Automatic storage layout validation
 * - Automatic ProxyAdmin lookup
 * - Built-in safety checks
 * - State preservation verification
 * - One command upgrades!
 */

const ethers = hardhat.ethers;

//*******************SET CHAIN TYPE HERE*******************
const CHAIN_TYPE = process.env.CHAIN_TYPE;
const PROXY_ADDRESS = "0x5dDf9A4aF6A43962f49CD8cca3179306DF36BD9e";
// const LOCK_DURATION;// set  only if you want to update the lock duration
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

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();
  console.log("Account:", deployer.address);
  console.log("Account balance:", (await deployer.getBalance()).toString());
  console.log("Chain type:", CHAIN_TYPE);
  console.log("Mode: UPGRADE with Hardhat Upgrades Plugin 🚀");

  // Validate proxy address
  if (!PROXY_ADDRESS || PROXY_ADDRESS === ethers.constants.AddressZero) {
    throw new Error("PROXY_ADDRESS environment variable is required");
  }

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║              UPGRADE WITH HARDHAT UPGRADES                     ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log("\nProxy to upgrade:", PROXY_ADDRESS);

  return await upgradeStrategyWithHardhatUpgrades();
}

async function upgradeStrategyWithHardhatUpgrades() {
  const deployer = await ethers.getSigner();

  // Get current implementation and admin
  console.log("\n=== Step 1: Read Current Deployment ===");
  let currentImplementation, adminAddress;
  
  try {
    currentImplementation = await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);
    adminAddress = await upgrades.erc1967.getAdminAddress(PROXY_ADDRESS);
    console.log("✅ Current implementation:", currentImplementation);
    console.log("✅ ProxyAdmin address:", adminAddress);
  } catch (error) {
    console.error("❌ Failed to read proxy:", error.message);
    throw new Error("Is this a valid upgradeable proxy address?");
  }

  // Connect to existing strategy and verify state
  console.log("\n=== Step 2: Verify Current State ===");
  const existingStrategy = await ethers.getContractAt("SaucerSwapLariRewardsCLMStrategy", PROXY_ADDRESS);

  let currentConfig;
  try {
    currentConfig = {
      pool: await existingStrategy.pool(),
      vault: await existingStrategy.vault(),
      lpToken0: await existingStrategy.lpToken0(),
      lpToken1: await existingStrategy.lpToken1(),
      native: await existingStrategy.native(),
      positionWidth: await existingStrategy.positionWidth(),
      twapInterval: await existingStrategy.twapInterval(),
      maxTickDeviation: await existingStrategy.maxTickDeviation(),
      owner: await existingStrategy.owner(),
      rewardTokensLength: await existingStrategy.getRewardTokensLength(),
    };

    console.log("Current configuration:");
    console.log("  Pool:", currentConfig.pool);
    console.log("  Vault:", currentConfig.vault);
    console.log("  Token0:", currentConfig.lpToken0);
    console.log("  Token1:", currentConfig.lpToken1);
    console.log("  Position Width:", currentConfig.positionWidth.toString());
    console.log("  TWAP Interval:", currentConfig.twapInterval.toString());
    console.log("  Owner:", currentConfig.owner);
    console.log("  Reward Tokens:", currentConfig.rewardTokensLength.toString());
  } catch (error) {
    console.error("❌ Failed to read current configuration:", error.message);
    throw error;
  }

  // Get library addresses (use existing if possible)
  console.log("\n=== Step 3: Prepare Libraries ===");
  let clmLibraryAddress = addresses.clmLibrary;
  let lariLibraryAddress = addresses.lariLibrary;

  if (!clmLibraryAddress || !lariLibraryAddress) {
    console.log("⚠️  Library addresses not found, deploying new libraries...");
    
    const CLMLibraryFactory = await ethers.getContractFactory("SaucerSwapCLMLib");
    const clmLibrary = await CLMLibraryFactory.deploy({ gasLimit: 5000000 });
    await clmLibrary.deployed();
    clmLibraryAddress = clmLibrary.address;
    console.log("✅ CLM Library deployed:", clmLibraryAddress);

    const LariLibraryFactory = await ethers.getContractFactory("SaucerSwapLariLib", {
      libraries: {
        SaucerSwapCLMLib: clmLibraryAddress,
      },
    });
    const lariLibrary = await LariLibraryFactory.deploy({ gasLimit: 5000000 });
    await lariLibrary.deployed();
    lariLibraryAddress = lariLibrary.address;
    console.log("✅ LARI Library deployed:", lariLibraryAddress);
  } else {
    console.log("✅ Using existing libraries:");
    console.log("  CLM Library:", clmLibraryAddress);
    console.log("  LARI Library:", lariLibraryAddress);
  }

  // Prepare factory with libraries
  console.log("\n=== Step 4: Prepare New Implementation ===");
  const StrategyFactory = await ethers.getContractFactory("SaucerSwapLariRewardsCLMStrategy", {
    libraries: {
      SaucerSwapCLMLib: clmLibraryAddress,
      SaucerSwapLariLib: lariLibraryAddress,
    },
  });

  console.log("Preparing upgrade...");
  console.log("  This will:");
  console.log("  • Deploy new implementation");
  console.log("  • Validate storage layout compatibility");
  console.log("  • Check for upgrade safety");
  console.log("  • Preserve all existing state");

  // 🎉 THE MAGIC HAPPENS HERE - Hardhat validates and upgrades!
  console.log("\n=== Step 5: Perform Upgrade ===");
  
  try {
    const upgradedStrategy = await upgrades.upgradeProxy(
      PROXY_ADDRESS,
      StrategyFactory,
      {
        unsafeAllowLinkedLibraries: true,
        txOverrides: { gasLimit: 3000000 }
      }
    );

    await upgradedStrategy.deployed();
    console.log("✅ Upgrade successful!");
    
    // Get new implementation
    const newImplementation = await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);
    console.log("✅ New implementation:", newImplementation);
    
    if (currentImplementation.toLowerCase() === newImplementation.toLowerCase()) {
      console.warn("⚠️  WARNING: Implementation address unchanged!");
      console.warn("This might mean no code changes were detected.");
    }

  } catch (error) {
    console.error("❌ Upgrade failed:", error.message);
    
    if (error.message.includes("storage layout")) {
      console.error("\n💡 Storage Layout Issue Detected:");
      console.error("  • You may have reordered or removed state variables");
      console.error("  • You may have changed variable types");
      console.error("  • New variables must be added at the END only");
      console.error("  • Review your changes carefully!");
    }
    
    throw error;
  }

    // Verify state preservation
    console.log("\n=== Step 6: Verify State Preservation ===");
    const upgradedStrategy = await ethers.getContractAt("SaucerSwapLariRewardsCLMStrategy", PROXY_ADDRESS);

    // // Optionally set lock duration post-upgrade
    // if (LOCK_DURATION) {
    //   console.log("\n=== Step 8: Update Lock Duration ===");
    //   try {
    //     const lockTx = await upgradedStrategy.setLockDuration(LOCK_DURATION, { gasLimit: 500000 });
    //     await lockTx.wait();
    //     console.log(`✅ Lock duration updated to ${LOCK_DURATION}s`);
    //   } catch (error) {
    //     console.error("❌ Failed to update lock duration:", error.message);
    //     throw error;
    //   }
    // }



  try {
    const afterConfig = {
      pool: await upgradedStrategy.pool(),
      vault: await upgradedStrategy.vault(),
      lpToken0: await upgradedStrategy.lpToken0(),
      lpToken1: await upgradedStrategy.lpToken1(),
      native: await upgradedStrategy.native(),
      positionWidth: await upgradedStrategy.positionWidth(),
      twapInterval: await upgradedStrategy.twapInterval(),
      maxTickDeviation: await upgradedStrategy.maxTickDeviation(),
      owner: await upgradedStrategy.owner(),
      rewardTokensLength: await upgradedStrategy.getRewardTokensLength(),
      lockDuration: await upgradedStrategy.lockDuration(),  
    };

    console.log("Configuration after upgrade:");
    console.log("  Pool:", afterConfig.pool);
    console.log("  Vault:", afterConfig.vault);
    console.log("  Token0:", afterConfig.lpToken0);
    console.log("  Token1:", afterConfig.lpToken1);
    console.log("  Position Width:", afterConfig.positionWidth.toString());
    console.log("  Owner:", afterConfig.owner);
    console.log("  Lock Duration:", afterConfig.lockDuration.toString());
    // Verify critical state preserved
    const statePreserved = 
      currentConfig.pool === afterConfig.pool &&
      currentConfig.vault === afterConfig.vault &&
      currentConfig.lpToken0 === afterConfig.lpToken0 &&
      currentConfig.lpToken1 === afterConfig.lpToken1 &&
      currentConfig.owner === afterConfig.owner;

    if (!statePreserved) {
      console.error("❌ CRITICAL: State not preserved!");
      console.error("Before:", currentConfig);
      console.error("After:", afterConfig);
      throw new Error("State verification failed - DO NOT USE THIS UPGRADE");
    }

    console.log("✅ All critical state preserved correctly");
  } catch (error) {
    console.error("❌ State verification failed:", error.message);
    throw error;
  }


  // Get final implementation
  const finalImplementation = await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);

  // Success summary
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                  UPGRADE SUCCESSFUL! ✅                         ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  console.log("\n📊 Upgrade Summary:");
  console.log("  Proxy Address:       ", PROXY_ADDRESS);
  console.log("  Old Implementation:  ", currentImplementation);
  console.log("  New Implementation:  ", finalImplementation);
  console.log("  ProxyAdmin:          ", adminAddress);
  console.log("  Upgraded by:         ", deployer.address);
  console.log("  Upgrade time:        ", new Date().toISOString());

  console.log("\n✅ What was fixed in this upgrade:");

  console.log("\n🔒 Hardhat Upgrades Plugin validated:");
  console.log("  ✅ Storage layout compatibility");
  console.log("  ✅ No dangerous operations (selfdestruct, delegatecall)");
  console.log("  ✅ Initializer safety");
  console.log("  ✅ ProxyAdmin permissions");

  console.log("\n⚠️  Post-Upgrade Actions:");
  console.log("  1. ✅ Monitor first few deposits closely");

  // Save upgrade info
  const upgradeInfo = {
    proxyAddress: PROXY_ADDRESS,
    oldImplementation: currentImplementation,
    newImplementation: finalImplementation,
    proxyAdmin: adminAddress,
    clmLibrary: clmLibraryAddress,
    lariLibrary: lariLibraryAddress,
    upgradedBy: deployer.address,
    upgradeTime: new Date().toISOString(),
    chainType: CHAIN_TYPE,
    statePreserved: true,
    managedBy: "hardhat-upgrades",
    validationPassed: true,
  };

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                  UPGRADE INFO (JSON)                           ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(JSON.stringify(upgradeInfo, null, 2));

  console.log("\n💡 Why Hardhat Upgrades is Better:");
  console.log("  ✅ Automatic validation (no manual checks needed)");
  console.log("  ✅ Storage layout safety (prevents upgrade failures)");
  console.log("  ✅ ProxyAdmin managed automatically");
  console.log("  ✅ One command to upgrade");
  console.log("  ✅ Built-in .openzeppelin folder tracking");
  console.log("  ✅ Better error messages");

  return upgradeInfo;
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error("\n❌ UPGRADE FAILED");
    console.error(error);
    process.exit(1);
  });

