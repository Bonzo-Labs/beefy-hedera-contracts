const hardhat = require("hardhat");
const { upgrades } = require("hardhat");

/**
 * Script to UPGRADE BonzoSAUCELevergedLiqStaking using Hardhat Upgrades Plugin
 *
 * Usage:
 * CHAIN_TYPE=testnet PROXY_ADDRESS=0x... npx hardhat run scripts/strategy/upgradeBonzoSAUCELevergedLiqStaking.js --network hedera_testnet
 * CHAIN_TYPE=mainnet PROXY_ADDRESS=0x... npx hardhat run scripts/strategy/upgradeBonzoSAUCELevergedLiqStaking.js --network hedera_mainnet
 *
 * Required:
 * - PROXY_ADDRESS: The proxy address to upgrade
 */

const ethers = hardhat.ethers;

//*******************SET CHAIN TYPE HERE*******************
const CHAIN_TYPE = process.env.CHAIN_TYPE;
const PROXY_ADDRESS = process.env.PROXY_ADDRESS;
//*******************SET CHAIN TYPE HERE*******************

// Load addresses based on chain type (kept for parity with other scripts)
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
  const existingStrategy = await ethers.getContractAt("BonzoSAUCELevergedLiqStaking", PROXY_ADDRESS);

  let currentConfig;
  try {
    currentConfig = {
      want: await existingStrategy.want(),
      borrowToken: await existingStrategy.borrowToken(),
      aToken: await existingStrategy.aToken(),
      debtToken: await existingStrategy.debtToken(),
      lendingPool: await existingStrategy.lendingPool(),
      rewardsController: await existingStrategy.rewardsController(),
      stakingPool: await existingStrategy.stakingPool(),
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
    console.log("  Want (xSAUCE):", currentConfig.want);
    console.log("  Borrow Token (SAUCE):", currentConfig.borrowToken);
    console.log("  aToken:", currentConfig.aToken);
    console.log("  Debt Token:", currentConfig.debtToken);
    console.log("  Lending Pool:", currentConfig.lendingPool);
    console.log("  Rewards Controller:", currentConfig.rewardsController);
    console.log("  Staking Pool:", currentConfig.stakingPool);
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
  const StrategyFactory = await ethers.getContractFactory("BonzoSAUCELevergedLiqStaking");

  console.log("\n=== Step 4: Perform Upgrade ===");
  try {
    const upgradedStrategy = await upgrades.upgradeProxy(PROXY_ADDRESS, StrategyFactory, {
      txOverrides: { gasLimit: 5000000 },
    });

    await upgradedStrategy.deployed();
    console.log("✅ Upgrade successful!");

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
      console.error("  • New variables must be appended at the END only");
      console.error("  • Avoid reordering/removing/changing types of existing vars");
    }
    throw error;
  }

  // Verify state preservation
  console.log("\n=== Step 5: Verify State Preservation ===");
  const upgradedStrategy = await ethers.getContractAt("BonzoSAUCELevergedLiqStaking", PROXY_ADDRESS);

  try {
    const afterConfig = {
      want: await upgradedStrategy.want(),
      borrowToken: await upgradedStrategy.borrowToken(),
      aToken: await upgradedStrategy.aToken(),
      debtToken: await upgradedStrategy.debtToken(),
      lendingPool: await upgradedStrategy.lendingPool(),
      rewardsController: await upgradedStrategy.rewardsController(),
      stakingPool: await upgradedStrategy.stakingPool(),
      vault: await upgradedStrategy.vault(),
      maxBorrowable: await upgradedStrategy.maxBorrowable(),
      slippageTolerance: await upgradedStrategy.slippageTolerance(),
      maxLoops: await upgradedStrategy.maxLoops(),
      owner: await upgradedStrategy.owner(),
      harvestOnDeposit: await upgradedStrategy.harvestOnDeposit(),
      isRewardsAvailable: await upgradedStrategy.isRewardsAvailable(),
      isBonzoDeployer: await upgradedStrategy.isBonzoDeployer(),
    };

    const statePreserved =
      currentConfig.want === afterConfig.want &&
      currentConfig.borrowToken === afterConfig.borrowToken &&
      currentConfig.aToken === afterConfig.aToken &&
      currentConfig.debtToken === afterConfig.debtToken &&
      currentConfig.lendingPool === afterConfig.lendingPool &&
      currentConfig.rewardsController === afterConfig.rewardsController &&
      currentConfig.stakingPool === afterConfig.stakingPool &&
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

  const finalImplementation = await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);

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
  };

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                  UPGRADE INFO (JSON)                           ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(JSON.stringify(upgradeInfo, null, 2));

  return upgradeInfo;
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error("\n❌ UPGRADE FAILED");
    console.error(error);
    process.exit(1);
  });

