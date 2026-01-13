const hardhat = require("hardhat");
const { upgrades } = require("hardhat");

/**
 * Script to deploy BonzoSAUCELevergedLiqStaking using Hardhat Upgrades Plugin
 *
 * Usage:
 * CHAIN_TYPE=testnet npx hardhat run scripts/strategy/deployUpgradableBonzoSAUCELevergedLiqStaking.js --network hedera_testnet
 * CHAIN_TYPE=mainnet npx hardhat run scripts/strategy/deployUpgradableBonzoSAUCELevergedLiqStaking.js --network hedera_mainnet
 *
 * Optional env overrides:
 * - MAX_BORROWABLE (bps, default from config)
 * - SLIPPAGE_TOLERANCE (bps, default from config)
 * - IS_REWARDS_AVAILABLE (true/false, default from config)
 * - IS_BONZO_DEPLOYER (true/false, default from config)
 * - VAULT_NAME (default from config)
 * - VAULT_SYMBOL (default from config)
 */

const ethers = hardhat.ethers;

//*******************SET CHAIN TYPE HERE*******************
const CHAIN_TYPE = process.env.CHAIN_TYPE;
//*******************SET CHAIN TYPE HERE*******************

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function envNum(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number`);
  return n;
}

// Load addresses based on chain type
let addresses;
if (CHAIN_TYPE === "mainnet") {
  addresses = require("../deployed-addresses-mainnet.json");
} else if (CHAIN_TYPE === "testnet") {
  addresses = require("../deployed-addresses.json");
} else {
  throw new Error(`Unsupported CHAIN_TYPE: ${CHAIN_TYPE}. Use 'testnet' or 'mainnet'`);
}

// Chain-specific configuration (mirrors test/Hedera/SauceXSauceVault.test.ts)
let config;
if (CHAIN_TYPE === "testnet") {
  config = {
    want: "0x000000000000000000000000000000000015a59b", // xSAUCE token
    borrowToken: "0x0000000000000000000000000000000000120f46", // SAUCE token
    aToken: "0x2217F55E2056C15a21ED7a600446094C36720f29", // axSAUCE token
    debtToken: "0x65be417A48511d2f20332673038e5647a4ED194D", // debtSAUCE token
    lendingPool: "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62", // Bonzo lending pool
    rewardsController: "0x40f1f4247972952ab1D276Cf552070d2E9880DA6", // Bonzo rewards controller
    stakingPool: "0x000000000000000000000000000000000015A59A", // SaucerSwap staking pool
    unirouter: "0x0000000000000000000000000000000000159398", // Router address
    maxBorrowable: 3000, // 30%
    slippageTolerance: 200, // 2% (used as conversion buffer in unwind)
    isRewardsAvailable: false,
    isBonzoDeployer: true,
    vaultName: "Beefy xSAUCE Leveraged Bonzo Testnet",
    vaultSymbol: "bvXSAUCE-LEV-BONZO-T",
  };
} else if (CHAIN_TYPE === "mainnet") {
  config = {
    want: "0x00000000000000000000000000000000001647e8", // xSAUCE token mainnet
    borrowToken: "0x00000000000000000000000000000000000b2ad5", // SAUCE token mainnet
    aToken: "0xEc9CEF1167b4673726B1e5f5A978150e63cDf23b", // axSAUCE token mainnet
    debtToken: "0x736c5dbB8ADC643f04c1e13a9C25f28d3D4f0503", // debtSAUCE token mainnet
    lendingPool: "0x236897c518996163E7b313aD21D1C9fCC7BA1afc", // Bonzo lending pool mainnet
    rewardsController: "0x0f3950d2fCbf62a2D79880E4fc251E4CB6625FBC", // Bonzo rewards controller mainnet
    stakingPool: "0x00000000000000000000000000000000001647e7", // SaucerSwap staking pool mainnet
    unirouter: "0x00000000000000000000000000000000003c437a", // Router address mainnet
    maxBorrowable: 3000, // 30%
    slippageTolerance: 200, // 2% (used as conversion buffer in unwind)
    isRewardsAvailable: false,
    isBonzoDeployer: false,
    vaultName: "Beefy xSAUCE Leveraged Bonzo",
    vaultSymbol: "bvXSAUCE-LEV-BONZO",
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

  if (!addresses.vaultFactory || addresses.vaultFactory === ethers.constants.AddressZero) {
    throw new Error("Vault factory address not found. Please run deployChain.js first.");
  }

  console.log("Configuration:");
  console.log("  Want (xSAUCE):", config.want);
  console.log("  Borrow Token (SAUCE):", config.borrowToken);
  console.log("  aToken (axSAUCE):", config.aToken);
  console.log("  Debt Token (debtSAUCE):", config.debtToken);
  console.log("  Lending Pool:", config.lendingPool);
  console.log("  Rewards Controller:", config.rewardsController);
  console.log("  Staking Pool:", config.stakingPool);
  console.log("  Unirouter:", config.unirouter);
  console.log("  Max Borrowable:", config.maxBorrowable, "bps (", config.maxBorrowable / 100, "%)");
  console.log("  Slippage Tolerance:", config.slippageTolerance, "bps (", config.slippageTolerance / 100, "%)");
  console.log("  Rewards Available:", config.isRewardsAvailable);
  console.log("  Bonzo Deployer:", config.isBonzoDeployer);
  console.log("  Vault Name:", config.vaultName);
  console.log("  Vault Symbol:", config.vaultSymbol);

  return await deployStrategyWithHardhatUpgrades();
}

async function deployStrategyWithHardhatUpgrades() {
  const deployer = await ethers.getSigner();
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║     DEPLOYING WITH HARDHAT UPGRADES PLUGIN                     ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  // Create vault instance
  console.log("\n=== Step 1: Create Vault ===");
  const vaultFactory = await ethers.getContractAt("BonzoVaultV7Factory", addresses.vaultFactory);
  const tx = await vaultFactory.cloneVault({ gasLimit: 4000000 });
  const receipt = await tx.wait();

  const proxyCreatedEvent = receipt.events?.find(e => e.event === "ProxyCreated");
  const vaultAddress = proxyCreatedEvent?.args?.proxy;
  if (!vaultAddress) {
    throw new Error("Failed to get vault address from ProxyCreated event");
  }
  console.log("✅ Vault created:", vaultAddress);
  const vaultInstance = await ethers.getContractAt("BonzoVaultV7", vaultAddress);

  // Deploy strategy using Hardhat Upgrades plugin
  console.log("\n=== Step 2: Deploy Strategy with Hardhat Upgrades ===");
  const StrategyFactory = await ethers.getContractFactory("BonzoSAUCELevergedLiqStaking");

  const initParams = [
    config.want,
    config.borrowToken,
    config.aToken,
    config.debtToken,
    config.lendingPool,
    config.rewardsController,
    config.stakingPool,
    config.maxBorrowable,
    config.slippageTolerance,
    config.isRewardsAvailable,
    config.isBonzoDeployer,
  ];

  const commonAddresses = [
    vaultAddress,
    config.unirouter,
    addresses.keeper || deployer.address, // keeper
    addresses.strategyOwner || deployer.address, // strategist
    addresses.beefyFeeRecipient || deployer.address, // beefyFeeRecipient
    addresses.beefyFeeConfig,
  ];

  console.log("Deploying upgradeable proxy...");
  const strategy = await upgrades.deployProxy(StrategyFactory, [...initParams, commonAddresses], {
    initializer: "initialize",
    kind: "transparent",
    txOverrides: { gasLimit: 8000000 },
  });

  await strategy.deployed();
  console.log("✅ Strategy proxy deployed:", strategy.address);

  const implementationAddress = await upgrades.erc1967.getImplementationAddress(strategy.address);
  const adminAddress = await upgrades.erc1967.getAdminAddress(strategy.address);
  console.log("✅ Implementation address:", implementationAddress);
  console.log("✅ ProxyAdmin address:", adminAddress);

  // Verify initialization
  console.log("\n=== Step 3: Verify Strategy Initialization ===");
  console.log("  Want:", await strategy.want());
  console.log("  Borrow Token:", await strategy.borrowToken());
  console.log("  aToken:", await strategy.aToken());
  console.log("  Debt Token:", await strategy.debtToken());
  console.log("  Lending Pool:", await strategy.lendingPool());
  console.log("  Rewards Controller:", await strategy.rewardsController());
  console.log("  Staking Pool:", await strategy.stakingPool());
  console.log("  Vault:", await strategy.vault());
  console.log("  Max Borrowable:", (await strategy.maxBorrowable()).toString());
  console.log("  Slippage Tolerance:", (await strategy.slippageTolerance()).toString());
  console.log("  Max Loops:", (await strategy.maxLoops()).toString());
  console.log("  Owner:", await strategy.owner());
  console.log("✅ Strategy initialized successfully");

  // Initialize vault
  console.log("\n=== Step 4: Initialize Vault ===");
  const isHederaToken = true; // xSAUCE is an HTS token
  const vaultInitTx = await vaultInstance.initialize(
    strategy.address,
    config.vaultName,
    config.vaultSymbol,
    0, // Performance fee
    isHederaToken,
    { gasLimit: 3000000 }
  );
  await vaultInitTx.wait();
  console.log("✅ Vault initialized with strategy:", strategy.address);

  const vaultStrategy = await vaultInstance.strategy();
  if (vaultStrategy.toLowerCase() !== strategy.address.toLowerCase()) {
    throw new Error("Vault strategy reference doesn't match!");
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

  const deploymentInfo = {
    strategyProxy: strategy.address,
    strategyImplementation: implementationAddress,
    proxyAdmin: adminAddress,
    vault: vaultInstance.address,
    want: config.want,
    borrowToken: config.borrowToken,
    aToken: config.aToken,
    debtToken: config.debtToken,
    lendingPool: config.lendingPool,
    rewardsController: config.rewardsController,
    stakingPool: config.stakingPool,
    unirouter: config.unirouter,
    maxBorrowable: config.maxBorrowable,
    slippageTolerance: config.slippageTolerance,
    isRewardsAvailable: config.isRewardsAvailable,
    isBonzoDeployer: config.isBonzoDeployer,
    vaultName: config.vaultName,
    vaultSymbol: config.vaultSymbol,
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

