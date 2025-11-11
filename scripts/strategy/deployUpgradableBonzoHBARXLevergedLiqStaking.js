const hardhat = require("hardhat");
const { upgrades } = require("hardhat");

/**
 * Script to deploy BonzoHBARXLevergedLiqStaking using Hardhat Upgrades Plugin
 * This is MUCH simpler than manual ProxyAdmin management!
 *
 * Usage:
 * CHAIN_TYPE=testnet npx hardhat run scripts/strategy/deployUpgradableBonzoHBARXLevergedLiqStaking.js --network hedera_testnet
 * CHAIN_TYPE=mainnet npx hardhat run scripts/strategy/deployUpgradableBonzoHBARXLevergedLiqStaking.js --network hedera_mainnet
 *
 * Environment Variables (optional):
 * - MAX_BORROWABLE: Maximum borrowable percentage in basis points (default: 3000 = 30%)
 * - SLIPPAGE_TOLERANCE: Slippage tolerance in basis points (default: 50 = 0.5%)
 * - IS_REWARDS_AVAILABLE: Whether rewards are available (default: false)
 * - IS_BONZO_DEPLOYER: Whether deployed by Bonzo team (default: false)
 * - VAULT_NAME: Vault name (default: "Beefy HBARX Leveraged Bonzo")
 * - VAULT_SYMBOL: Vault symbol (default: "bvHBARX-LEV-BONZO")
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
    want: "0x0000000000000000000000000000000000220ced", // HBARX token
    borrowToken: "0x0000000000000000000000000000000000003ad2", // WHBAR token
    aToken: "0x37FfB9d2c91ef6858E54DD5B05805339A1aEA207", // aHBARX token
    debtToken:  "0xacE6c84d8737e377c1f85BE5f7BC82E4fF3248E6", // debtWHBAR token
    lendingPool:  "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62", // Bonzo lending pool
    rewardsController:  "0x40f1f4247972952ab1D276Cf552070d2E9880DA6", // Bonzo rewards controller
    stakingContract: "", // Will be set by mock deployment or env var
    unirouter: "0x0000000000000000000000000000000000159398", // Router address
    whbarGateway: "0xa7e46f496b088A8f8ee35B74D7E58d6Ce648Ae64", // WHBARGateway address
    maxBorrowable: 3000, // 30% max borrowable
    slippageTolerance: 50, // 0.5% slippage tolerance
    isRewardsAvailable: false,
    isBonzoDeployer: true,
    vaultName: "Beefy HBARX Leveraged Bonzo Testnet",
    vaultSymbol: "bvHBARX-LEV-BONZO-T",
  };
} else if (CHAIN_TYPE === "mainnet") {
  config = {
    want: "0x00000000000000000000000000000000000cba44", // HBARX token mainnet
    borrowToken: "0x0000000000000000000000000000000000163b5a", // WHBAR token mainnet
    aToken: "0x40EBC87627Fe4689567C47c8C9C84EDC4Cf29132", // aHBARX token mainnet
    debtToken: "0xCD5A1FF3AD6EDd7e85ae6De3854f3915dD8c9103", // debtWHBAR token mainnet
    lendingPool:  "0x236897c518996163E7b313aD21D1C9fCC7BA1afc", // Bonzo lending pool mainnet
    rewardsController: "0x0f3950d2fCbf62a2D79880E4fc251E4CB6625FBC", // Bonzo rewards controller mainnet
    stakingContract: "0x0000000000000000000000000000000000158d97", // Stader staking contract mainnet
    unirouter: "0x00000000000000000000000000000000003c437a", // Router address mainnet
    whbarGateway: "0xa7e46f496b088A8f8ee35B74D7E58d6Ce648Ae64", // WHBARGateway address
    maxBorrowable: 3000, // 30% max borrowable
    slippageTolerance: 50, // 0.5% slippage tolerance
    isRewardsAvailable: false,
    isBonzoDeployer: false,
    vaultName: "Beefy HBARX Leveraged Bonzo",
    vaultSymbol: "bvHBARX-LEV-BONZO",
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

  // Validate staking contract address
  if (!config.stakingContract || config.stakingContract === ethers.constants.AddressZero) {
    if (CHAIN_TYPE === "testnet") {
      console.warn("⚠️  Staking contract address not provided. Will deploy mock staking contract.");
    } else {
      throw new Error("Staking contract address is required for mainnet.");
    }
  }

  console.log("Configuration:");
  console.log("  Want (HBARX):", config.want);
  console.log("  Borrow Token (WHBAR):", config.borrowToken);
  console.log("  aToken (aHBARX):", config.aToken);
  console.log("  Debt Token (debtWHBAR):", config.debtToken);
  console.log("  Lending Pool:", config.lendingPool);
  console.log("  Rewards Controller:", config.rewardsController);
  console.log("  Staking Contract:", config.stakingContract || "(will deploy mock)");
  console.log("  Unirouter:", config.unirouter);
  console.log("  WHBAR Gateway:", config.whbarGateway);
  console.log("  Max Borrowable:", config.maxBorrowable, "bps (", config.maxBorrowable / 100, "%)");
  console.log("  Slippage Tolerance:", config.slippageTolerance, "bps (", config.slippageTolerance / 100, "%)");
  console.log("  Rewards Available:", config.isRewardsAvailable);
  console.log("  Bonzo Deployer:", config.isBonzoDeployer);

  return await deployStrategyWithHardhatUpgrades();
}

async function deployStrategyWithHardhatUpgrades() {
  const deployer = await ethers.getSigner();
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║     DEPLOYING WITH HARDHAT UPGRADES PLUGIN                     ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  // Deploy mock staking contract for testnet if needed
  let stakingContractAddress = config.stakingContract;
  if (CHAIN_TYPE === "testnet" && (!stakingContractAddress || stakingContractAddress === "")) {
    console.log("\n=== Step 0: Deploy Mock Staking Contract (Testnet Only) ===");
    const MockStakingFactory = await ethers.getContractFactory("MockStaking");
    const mockStaking = await MockStakingFactory.deploy(config.want, { gasLimit: 2000000 });
    await mockStaking.deployed();
    stakingContractAddress = mockStaking.address;
    console.log("✅ Mock Staking Contract deployed:", stakingContractAddress);
    
    // Transfer some HBARX to the mock staking contract for testing
    try {
      const wantToken = await ethers.getContractAt("IERC20", config.want);
      const transferTx = await wantToken.transfer(stakingContractAddress, ethers.utils.parseUnits("100", 8));
      await transferTx.wait();
      console.log("✅ Transferred 100 HBARX to mock staking contract");
    } catch (error) {
      console.warn("⚠️  Could not transfer HBARX to mock staking contract:", error.message);
    }
  }

  // Create vault instance
  console.log("\n=== Step 1: Create Vault ===");
  const vaultFactoryAddress = addresses.vaultFactory;
  if (!vaultFactoryAddress || vaultFactoryAddress === ethers.constants.AddressZero) {
    throw new Error("Vault factory address not found.");
  }

  const vaultFactory = await ethers.getContractAt("BonzoVaultV7Factory", vaultFactoryAddress);
  const tx = await vaultFactory.cloneVault({ gasLimit: 4000000 });
  const receipt = await tx.wait();

  const proxyCreatedEvent = receipt.events?.find(e => e.event === "ProxyCreated");
  const vaultAddress = proxyCreatedEvent?.args?.proxy;
  if (!vaultAddress) {
    throw new Error("Failed to get vault address from ProxyCreated event");
  }

  // const vaultAddress = "0x48ac1231196082B0E4800827f9122827328baFdA";
  console.log("✅ Vault created:", vaultAddress);
  const vaultInstance = await ethers.getContractAt("BonzoVaultV7", vaultAddress);

  // Deploy strategy using Hardhat Upgrades plugin
  console.log("\n=== Step 2: Deploy Strategy with Hardhat Upgrades ===");
  
  const StrategyFactory = await ethers.getContractFactory("BonzoHBARXLevergedLiqStaking");

  // Prepare initialization parameters
  const initParams = [
    config.want,
    config.borrowToken,
    config.aToken,
    config.debtToken,
    config.lendingPool,
    config.rewardsController,
    stakingContractAddress,
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
  console.log("  This will automatically:");
  console.log("  • Deploy ProxyAdmin (if needed)");
  console.log("  • Deploy Implementation");
  console.log("  • Deploy TransparentUpgradeableProxy");
  console.log("  • Initialize the strategy");

  // 🎉 THE MAGIC HAPPENS HERE - One line does it all!
  const strategy = await upgrades.deployProxy(
    StrategyFactory,
    [...initParams, commonAddresses],
    {
      initializer: 'initialize',
      kind: 'transparent',
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
  console.log("\n=== Step 3: Verify Strategy Initialization ===");
  try {
    console.log("  Want:", await strategy.want());
    console.log("  Borrow Token:", await strategy.borrowToken());
    console.log("  aToken:", await strategy.aToken());
    console.log("  Debt Token:", await strategy.debtToken());
    console.log("  Lending Pool:", await strategy.lendingPool());
    console.log("  Rewards Controller:", await strategy.rewardsController());
    console.log("  Staking Contract:", await strategy.stakingContract());
    console.log("  Vault:", await strategy.vault());
    console.log("  Max Borrowable:", (await strategy.maxBorrowable()).toString());
    console.log("  Slippage Tolerance:", (await strategy.slippageTolerance()).toString());
    console.log("  Max Loops:", (await strategy.maxLoops()).toString());
    console.log("  Owner:", await strategy.owner());
    console.log("✅ Strategy initialized successfully");
  } catch (error) {
    console.error("❌ Strategy verification failed:", error);
    throw error;
  }

  // Initialize vault
  console.log("\n=== Step 4: Initialize Vault ===");
  try {
    const isHederaToken = true; // HBARX is an HTS token
    const vaultInitTx = await vaultInstance.initialize(
      strategy.address,
      config.vaultName,
      config.vaultSymbol,
      0, // Performance fee - set to 0 initially
      isHederaToken,
      { gasLimit: 3000000 }
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

  // Deployment summary
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                 DEPLOYMENT SUCCESSFUL! ✅                       ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  console.log("\n📦 Core Contracts:");
  console.log(`  Strategy Proxy:      ${strategy.address}`);
  console.log(`  Implementation:       ${implementationAddress}`);
  console.log(`  ProxyAdmin:           ${adminAddress}`);
  console.log(`  Vault:                ${vaultInstance.address}`);
  
  if (CHAIN_TYPE === "testnet" && stakingContractAddress !== config.stakingContract) {
    console.log(`  Mock Staking Contract: ${stakingContractAddress}`);
  }
  
  console.log("\n⚙️  Configuration:");
  console.log(`  Want (HBARX):         ${config.want}`);
  console.log(`  Borrow Token (WHBAR): ${config.borrowToken}`);
  console.log(`  aToken (aHBARX):      ${config.aToken}`);
  console.log(`  Debt Token:           ${config.debtToken}`);
  console.log(`  Lending Pool:         ${config.lendingPool}`);
  console.log(`  Staking Contract:     ${stakingContractAddress}`);
  console.log(`  Max Borrowable:       ${config.maxBorrowable} bps (${config.maxBorrowable / 100}%)`);
  console.log(`  Slippage Tolerance:   ${config.slippageTolerance} bps (${config.slippageTolerance / 100}%)`);
  console.log(`  Rewards Available:    ${config.isRewardsAvailable}`);
  console.log(`  Bonzo Deployer:       ${config.isBonzoDeployer}`);

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                  UPGRADE INSTRUCTIONS                          ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  console.log("\n🔄 To upgrade in the future, create an upgrade script:");
  console.log(`\nconst { upgrades } = require("hardhat");`);
  console.log(`const PROXY_ADDRESS = "${strategy.address}";`);
  console.log(`\n// Deploy new implementation`);
  console.log(`const StrategyFactory = await ethers.getContractFactory("BonzoHBARXLevergedLiqStaking");`);
  console.log(`const upgraded = await upgrades.upgradeProxy(PROXY_ADDRESS, StrategyFactory);`);
  console.log(`await upgraded.deployed();`);
  console.log(`console.log("Upgraded:", upgraded.address);`);
  
  console.log("\n✨ Hardhat Upgrades handles:");
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
    want: config.want,
    borrowToken: config.borrowToken,
    aToken: config.aToken,
    debtToken: config.debtToken,
    lendingPool: config.lendingPool,
    rewardsController: config.rewardsController,
    stakingContract: stakingContractAddress,
    unirouter: config.unirouter,
    whbarGateway: config.whbarGateway,
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

