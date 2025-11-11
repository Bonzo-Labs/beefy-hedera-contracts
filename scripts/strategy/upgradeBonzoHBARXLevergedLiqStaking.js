const hardhat = require("hardhat");
const { upgrades } = require("hardhat");

/**
 * Script to UPGRADE BonzoHBARXLevergedLiqStaking using Hardhat Upgrades Plugin
 * This is INCREDIBLY simple compared to manual ProxyAdmin management!
 *
 * Usage:
 * CHAIN_TYPE=testnet PROXY_ADDRESS=0x... npx hardhat run scripts/strategy/upgradeBonzoHBARXLevergedLiqStaking.js --network hedera_testnet
 * CHAIN_TYPE=mainnet PROXY_ADDRESS=0x... npx hardhat run scripts/strategy/upgradeBonzoHBARXLevergedLiqStaking.js --network hedera_mainnet
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
const PROXY_ADDRESS = "0x5F9B2CbBcFc9caBC4BCEbAa3d772f8EB8b3C51EB";
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
  const existingStrategy = await ethers.getContractAt("BonzoHBARXLevergedLiqStaking", PROXY_ADDRESS);

  let currentConfig;
  try {
    currentConfig = {
      want: await existingStrategy.want(),
      borrowToken: await existingStrategy.borrowToken(),
      aToken: await existingStrategy.aToken(),
      debtToken: await existingStrategy.debtToken(),
      lendingPool: await existingStrategy.lendingPool(),
      rewardsController: await existingStrategy.rewardsController(),
      stakingContract: await existingStrategy.stakingContract(),
      vault: await existingStrategy.vault(),
      maxBorrowable: await existingStrategy.maxBorrowable(),
      slippageTolerance: await existingStrategy.slippageTolerance(),
      maxLoops: await existingStrategy.maxLoops(),
      owner: await existingStrategy.owner(),
      harvestOnDeposit: await existingStrategy.harvestOnDeposit(),
      isRewardsAvailable: await existingStrategy.isRewardsAvailable(),
      isBonzoDeployer: await existingStrategy.isBonzoDeployer(),
    };

    console.log("Current configuration:");
    console.log("  Want (HBARX):", currentConfig.want);
    console.log("  Borrow Token (WHBAR):", currentConfig.borrowToken);
    console.log("  aToken:", currentConfig.aToken);
    console.log("  Debt Token:", currentConfig.debtToken);
    console.log("  Lending Pool:", currentConfig.lendingPool);
    console.log("  Rewards Controller:", currentConfig.rewardsController);
    console.log("  Staking Contract:", currentConfig.stakingContract);
    console.log("  Vault:", currentConfig.vault);
    console.log("  Max Borrowable:", currentConfig.maxBorrowable.toString());
    console.log("  Slippage Tolerance:", currentConfig.slippageTolerance.toString());
    console.log("  Max Loops:", currentConfig.maxLoops.toString());
    console.log("  Owner:", currentConfig.owner);
    console.log("  Harvest On Deposit:", currentConfig.harvestOnDeposit);
    console.log("  Rewards Available:", currentConfig.isRewardsAvailable);
    console.log("  Bonzo Deployer:", currentConfig.isBonzoDeployer);
  } catch (error) {
    console.error("❌ Failed to read current configuration:", error.message);
    throw error;
  }

  // Prepare factory
  console.log("\n=== Step 3: Prepare New Implementation ===");
  const StrategyFactory = await ethers.getContractFactory("BonzoHBARXLevergedLiqStaking");

  console.log("Preparing upgrade...");
  console.log("  This will:");
  console.log("  • Deploy new implementation");
  console.log("  • Validate storage layout compatibility");
  console.log("  • Check for upgrade safety");
  console.log("  • Preserve all existing state");

  // 🎉 THE MAGIC HAPPENS HERE - Hardhat validates and upgrades!
  console.log("\n=== Step 4: Perform Upgrade ===");
  
  try {
    const upgradedStrategy = await upgrades.upgradeProxy(
      PROXY_ADDRESS,
      StrategyFactory,
      {
        txOverrides: { gasLimit: 5000000 }
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
  console.log("\n=== Step 5: Verify State Preservation ===");
  const upgradedStrategy = await ethers.getContractAt("BonzoHBARXLevergedLiqStaking", PROXY_ADDRESS);

  try {
    const afterConfig = {
      want: await upgradedStrategy.want(),
      borrowToken: await upgradedStrategy.borrowToken(),
      aToken: await upgradedStrategy.aToken(),
      debtToken: await upgradedStrategy.debtToken(),
      lendingPool: await upgradedStrategy.lendingPool(),
      rewardsController: await upgradedStrategy.rewardsController(),
      stakingContract: await upgradedStrategy.stakingContract(),
      vault: await upgradedStrategy.vault(),
      maxBorrowable: await upgradedStrategy.maxBorrowable(),
      slippageTolerance: await upgradedStrategy.slippageTolerance(),
      maxLoops: await upgradedStrategy.maxLoops(),
      owner: await upgradedStrategy.owner(),
      harvestOnDeposit: await upgradedStrategy.harvestOnDeposit(),
      isRewardsAvailable: await upgradedStrategy.isRewardsAvailable(),
      isBonzoDeployer: await upgradedStrategy.isBonzoDeployer(),
    };

    console.log("Configuration after upgrade:");
    console.log("  Want (HBARX):", afterConfig.want);
    console.log("  Borrow Token (WHBAR):", afterConfig.borrowToken);
    console.log("  aToken:", afterConfig.aToken);
    console.log("  Debt Token:", afterConfig.debtToken);
    console.log("  Lending Pool:", afterConfig.lendingPool);
    console.log("  Staking Contract:", afterConfig.stakingContract);
    console.log("  Vault:", afterConfig.vault);
    console.log("  Max Borrowable:", afterConfig.maxBorrowable.toString());
    console.log("  Owner:", afterConfig.owner);

    // Verify critical state preserved
    const statePreserved = 
      currentConfig.want === afterConfig.want &&
      currentConfig.borrowToken === afterConfig.borrowToken &&
      currentConfig.aToken === afterConfig.aToken &&
      currentConfig.debtToken === afterConfig.debtToken &&
      currentConfig.lendingPool === afterConfig.lendingPool &&
      currentConfig.rewardsController === afterConfig.rewardsController &&
      currentConfig.stakingContract === afterConfig.stakingContract &&
      currentConfig.vault === afterConfig.vault &&
      currentConfig.owner === afterConfig.owner &&
      currentConfig.maxBorrowable.toString() === afterConfig.maxBorrowable.toString() &&
      currentConfig.slippageTolerance.toString() === afterConfig.slippageTolerance.toString();

    if (!statePreserved) {
      console.error("❌ CRITICAL: State not preserved!");
      console.error("Before:", JSON.stringify(currentConfig, null, 2));
      console.error("After:", JSON.stringify(afterConfig, null, 2));
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

  console.log("\n🔒 Hardhat Upgrades Plugin validated:");
  console.log("  ✅ Storage layout compatibility");
  console.log("  ✅ No dangerous operations (selfdestruct, delegatecall)");
  console.log("  ✅ Initializer safety");
  console.log("  ✅ ProxyAdmin permissions");

  console.log("\n⚠️  Post-Upgrade Actions:");
  console.log("  1. ✅ Monitor first few deposits/withdrawals closely");
  console.log("  2. ✅ Verify strategy functions correctly");
  console.log("  3. ✅ Test with small amounts first");
  console.log("  4. ✅ Check that all state variables are preserved");

  // Save upgrade info
  const upgradeInfo = {
    proxyAddress: PROXY_ADDRESS,
    oldImplementation: currentImplementation,
    newImplementation: finalImplementation,
    proxyAdmin: adminAddress,
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

