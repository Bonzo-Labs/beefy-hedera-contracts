const hardhat = require("hardhat");
const { upgrades } = require("hardhat");
const { addressBook } = require("blockchain-addressbook");
const fs = require("fs");
const path = require("path");

/**
 * Script used to deploy the basic infrastructure needed to run Beefy-Bonzo on Hedera.
 * Note - Run this script with `CHAIN_TYPE=mainnet timeout 5m npx hardhat run scripts/infra/deployChain.js --network hedera_mainnet`
 */

const ethers = hardhat.ethers;

//*******************SET CHAIN TYPE HERE*******************
const CHAIN_TYPE = process.env.CHAIN_TYPE;
//*******************SET CHAIN TYPE HERE*******************

let keeper, voter, beefyFeeRecipient;
if (CHAIN_TYPE === "testnet") {
  keeper = process.env.KEEPER_ADDRESS;
  voter = process.env.KEEPER_ADDRESS;
  beefyFeeRecipient = process.env.KEEPER_ADDRESS;
} else if (CHAIN_TYPE === "mainnet") {
  keeper = process.env.KEEPER_ADDRESS_MAINNET;
  voter = process.env.KEEPER_ADDRESS_MAINNET;
  beefyFeeRecipient = process.env.KEEPER_ADDRESS_MAINNET;
}

const TIMELOCK_ADMIN_ROLE = "0x5f58e3a2316349923ce3780f8d587db2d72378aed66a8261c916544fa6846ca5";
const STRAT_OWNER_DELAY = 21600;
const VAULT_OWNER_DELAY = 0;
const KEEPER = keeper;

const config = {
  devMultisig: keeper,
  treasuryMultisig: keeper,
  totalLimit: "95000000000000000",
  callFee: "500000000000000",
  strategist: "5000000000000000",
};

const proposer = config.devMultisig;
const timelockProposers = [proposer];
const timelockExecutors = [KEEPER];

// Helper function to save addresses to file
function saveAddresses(addresses) {
  const addressesPath =
    CHAIN_TYPE === "mainnet"
      ? path.join(__dirname, "..", "deployed-addresses-mainnet.json")
      : path.join(__dirname, "..", "deployed-addresses.json");
  fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));
  console.log(`Addresses saved to ${addressesPath}`);
}

// Helper function to load existing addresses
function loadExistingAddresses() {
  const addressesPath =
    CHAIN_TYPE === "mainnet"
      ? path.join(__dirname, "..", "deployed-addresses-mainnet.json")
      : path.join(__dirname, "..", "deployed-addresses.json");
  
  if (fs.existsSync(addressesPath)) {
    const existingAddresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
    console.log(`Found existing addresses file: ${addressesPath}`);
    return existingAddresses;
  }
  return null;
}

// Helper function to check if contract is already deployed
function isContractDeployed(address) {
  return address && address !== ethers.constants.AddressZero;
}

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();
  console.log("Deployer address:", deployer.address);

  // Load existing addresses if available
  const existingAddresses = loadExistingAddresses();

  // Initialize addresses object
  const addresses = {
    vaultFactory: ethers.constants.AddressZero,
    vaultV7: ethers.constants.AddressZero,
    vaultV7MultiToken: ethers.constants.AddressZero,
    beefySwapper: ethers.constants.AddressZero,
    beefyOracle: ethers.constants.AddressZero,
    keeper: keeper,
    devMultisig: config.devMultisig,
    treasuryMultisig: config.treasuryMultisig,
    strategyOwner: ethers.constants.AddressZero,
    vaultOwner: ethers.constants.AddressZero,
    treasurer: config.treasuryMultisig,
    launchpoolOwner: config.devMultisig,
    rewardPool: ethers.constants.AddressZero,
    treasury: ethers.constants.AddressZero,
    beefyFeeRecipient: config.treasuryMultisig,
    multicall: ethers.constants.AddressZero,
    bifiMaxiStrategy: ethers.constants.AddressZero,
    voter: voter,
    beefyFeeConfig: ethers.constants.AddressZero,
    wrapperFactory: ethers.constants.AddressZero,
    zap: ethers.constants.AddressZero,
    zapTokenManager: ethers.constants.AddressZero,
    treasurySwapper: ethers.constants.AddressZero,
    clmFactory: ethers.constants.AddressZero,
    clmStrategyFactory: ethers.constants.AddressZero,
    clmRewardPoolFactory: ethers.constants.AddressZero,
    positionMulticall: ethers.constants.AddressZero,
    clmVault: ethers.constants.AddressZero,
    beefyOracleChainlink: ethers.constants.AddressZero,
    beefyOracleUniswapV2: ethers.constants.AddressZero,
    beefyOracleUniswapV3: ethers.constants.AddressZero,
  };

  // Merge with existing addresses if available
  if (existingAddresses) {
    Object.assign(addresses, existingAddresses);
    console.log("Resuming deployment with existing addresses:");
    Object.entries(addresses).forEach(([key, value]) => {
      if (isContractDeployed(value)) {
        console.log(`  ${key}: ${value} (already deployed)`);
      }
    });
  }

  const TimelockController = await ethers.getContractFactory("TimelockController");

  // Deploy vault owner if not already deployed
  if (!isContractDeployed(addresses.vaultOwner)) {
    console.log("Deploying vault owner.");
    let deployParams = [VAULT_OWNER_DELAY, timelockProposers, timelockExecutors];
    const vaultOwner = await TimelockController.deploy(...deployParams, { gasLimit: 5000000 });
    await vaultOwner.deployed();
    await vaultOwner.renounceRole(TIMELOCK_ADMIN_ROLE, deployer.address, { gasLimit: 5000000 });
    console.log(`Vault owner deployed to ${vaultOwner.address}`);
    addresses.vaultOwner = vaultOwner.address;
    saveAddresses(addresses);
  } else {
    console.log(`Vault owner already deployed at ${addresses.vaultOwner}`);
  }

  // Deploy strategy owner if not already deployed
  if (!isContractDeployed(addresses.strategyOwner)) {
    console.log("Deploying strategy owner.");
    const stratOwner = await TimelockController.deploy(STRAT_OWNER_DELAY, timelockProposers, timelockExecutors, {
      gasLimit: 5000000,
    });
    await stratOwner.deployed();
    await stratOwner.renounceRole(TIMELOCK_ADMIN_ROLE, deployer.address, { gasLimit: 5000000 });
    console.log(`Strategy owner deployed to ${stratOwner.address}`);
    addresses.strategyOwner = stratOwner.address;
    saveAddresses(addresses);
  } else {
    console.log(`Strategy owner already deployed at ${addresses.strategyOwner}`);
  }

  // Deploy multicall if not already deployed
  if (!isContractDeployed(addresses.multicall)) {
    console.log("Deploying multicall");
    const Multicall = await ethers.getContractFactory("Multicall");
    const multicall = await Multicall.deploy({ gasLimit: 5000000 });
    await multicall.deployed();
    console.log(`Multicall deployed to ${multicall.address}`);
    addresses.multicall = multicall.address;
    saveAddresses(addresses);
  } else {
    console.log(`Multicall already deployed at ${addresses.multicall}`);
  }

  // Deploy BeefyFeeConfigurator if not already deployed
  if (!isContractDeployed(addresses.beefyFeeConfig)) {
    const BeefyFeeConfiguratorFactory = await ethers.getContractFactory("BeefyFeeConfigurator");
    console.log("Deploying BeefyFeeConfigurator");

    // Deploy directly instead of using upgrades proxy for Hedera compatibility
    const beefyFeeConfigurator = await BeefyFeeConfiguratorFactory.deploy({ gasLimit: 5_000_000 });
    await beefyFeeConfigurator.deployed();
    console.log(`BeefyFeeConfigurator deployed to ${beefyFeeConfigurator.address}`);
    addresses.beefyFeeConfig = beefyFeeConfigurator.address;
    saveAddresses(addresses);

    // Initialize the contract
    console.log("Initializing BeefyFeeConfigurator");
    await beefyFeeConfigurator.initialize(keeper, config.totalLimit, { gasLimit: 5_000_000 });
    console.log("Setting BeefyFeeConfigurator fee category");

    const transparentUpgradableProxy = beefyFeeConfigurator;

    await transparentUpgradableProxy.setFeeCategory(
      0,
      BigInt(config.totalLimit),
      BigInt(config.callFee),
      BigInt(config.strategist),
      "default",
      true,
      true,
      { gasLimit: 5000000 }
    );
    console.log("Setting BeefyFeeConfigurator ownership");
    await transparentUpgradableProxy.transferOwnership(config.devMultisig, { gasLimit: 5000000 });
    console.log("BeefyFeeConfigurator ownership set");
    console.log("BeefyFeeConfig:", transparentUpgradableProxy.address);
  } else {
    console.log(`BeefyFeeConfigurator already deployed at ${addresses.beefyFeeConfig}`);
  }

  // Deploy vault V7 if not already deployed
  if (!isContractDeployed(addresses.vaultV7)) {
    console.log("Deploying Vault V7");
    const VaultV7 = await ethers.getContractFactory("BeefyVaultV7Hedera");
    const vault7 = await VaultV7.deploy({ gasLimit: 5000000 });
    await vault7.deployed();
    console.log(`Vault V7 deployed to ${vault7.address}`);
    addresses.vaultV7 = vault7.address;
    saveAddresses(addresses);
  } else {
    console.log(`Vault V7 already deployed at ${addresses.vaultV7}`);
  }

  // Deploy vault V7 MultiToken if not already deployed
  if (!isContractDeployed(addresses.vaultV7MultiToken)) {
    console.log("Deploying Vault V7 MultiToken");
    const VaultV7MultiToken = await ethers.getContractFactory("BeefyVaultV7HederaMultiToken");
    const vault7MultiToken = await VaultV7MultiToken.deploy({ gasLimit: 5000000 });
    await vault7MultiToken.deployed();
    console.log(`Vault V7 MultiToken deployed to ${vault7MultiToken.address}`);
    addresses.vaultV7MultiToken = vault7MultiToken.address;
    saveAddresses(addresses);
  } else {
    console.log(`Vault V7 MultiToken already deployed at ${addresses.vaultV7MultiToken}`);
  }

  // Deploy CLM Vault if not already deployed
  if (!isContractDeployed(addresses.clmVault)) {
    console.log("Deploying CLM Vault (BeefyVaultConcLiqHedera)");
    const CLMVault = await ethers.getContractFactory("BeefyVaultConcLiqHedera");
    const clmVault = await CLMVault.deploy({ gasLimit: 5000000 });
    await clmVault.deployed();
    console.log(`CLM Vault deployed to ${clmVault.address}`);
    addresses.clmVault = clmVault.address;
    saveAddresses(addresses);
  } else {
    console.log(`CLM Vault already deployed at ${addresses.clmVault}`);
  }

  // Deploy vault factory if not already deployed
  if (!isContractDeployed(addresses.vaultFactory)) {
    console.log("Deploying Vault Factory");
    const VaultFactory = await ethers.getContractFactory("BeefyVaultV7FactoryHedera");
    const vaultFactory = await VaultFactory.deploy(addresses.vaultV7, addresses.vaultV7MultiToken, { gasLimit: 5000000 });
    await vaultFactory.deployed();
    console.log(`Vault Factory deployed to ${vaultFactory.address}`);
    addresses.vaultFactory = vaultFactory.address;
    saveAddresses(addresses);
  } else {
    console.log(`Vault Factory already deployed at ${addresses.vaultFactory}`);
  }

  // Deploy Beefy Swapper if not already deployed
  if (!isContractDeployed(addresses.beefySwapper)) {
    console.log("Deploying Beefy Swapper");
    const BeefySwapper = await ethers.getContractFactory("BeefySwapper");
    console.log("BeefySwapper factory created, starting deployment...");

    let beefySwapper;
    try {
      beefySwapper = await BeefySwapper.deploy({ gasLimit: 8000000 });
      console.log("BeefySwapper deploy transaction sent, waiting for confirmation...");
      await beefySwapper.deployed();
      console.log(`Beefy Swapper deployed to ${beefySwapper.address}`);
      addresses.beefySwapper = beefySwapper.address;
      saveAddresses(addresses);
    } catch (error) {
      console.error("BeefySwapper deployment failed:", error.message);
      throw error;
    }
  } else {
    console.log(`Beefy Swapper already deployed at ${addresses.beefySwapper}`);
  }

  // Deploy Beefy Oracle if not already deployed
  if (!isContractDeployed(addresses.beefyOracle)) {
    console.log("Deploying Beefy Oracle");
    const BeefyOracle = await ethers.getContractFactory("BeefyOracle");
    const beefyOracle = await BeefyOracle.deploy({ gasLimit: 5000000 });
    await beefyOracle.deployed();
    console.log(`Beefy Oracle deployed to ${beefyOracle.address}`);
    addresses.beefyOracle = beefyOracle.address;
    saveAddresses(addresses);
  } else {
    console.log(`Beefy Oracle already deployed at ${addresses.beefyOracle}`);
  }

  // Initialize and configure contracts if they were just deployed
  if (!isContractDeployed(existingAddresses?.beefySwapper)) {
    console.log("Initializing newly deployed Beefy Swapper...");
    const beefySwapper = await ethers.getContractAt("BeefySwapper", addresses.beefySwapper);
    
    // Add 5 seconds timeout to ensure transactions are processed
    console.log("Waiting 5 seconds before initializing...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    await beefySwapper.initialize(addresses.beefyOracle, config.totalLimit, { gasLimit: 5000000 });

    console.log("Waiting 5 seconds before transferring ownership...");
    await new Promise(resolve => setTimeout(resolve, 10000));
    await beefySwapper.transferOwnership(keeper, { gasLimit: 5000000 });
    console.log("Beefy Swapper ownership transferred to keeper");
  }

  if (!isContractDeployed(existingAddresses?.beefyOracle)) {
    console.log("Initializing newly deployed Beefy Oracle...");
    const beefyOracle = await ethers.getContractAt("BeefyOracle", addresses.beefyOracle);
    
    console.log("Waiting 5 seconds before initializing...");
    await new Promise(resolve => setTimeout(resolve, 30000));
    await beefyOracle.initialize({ gasLimit: 5000000 });
    console.log("Beefy Oracle initialized");

    console.log("Waiting 5 seconds before transferring ownership...");
    await new Promise(resolve => setTimeout(resolve, 10000));
    await beefyOracle.transferOwnership(keeper, { gasLimit: 5000000 });
    console.log("Beefy Oracle ownership transferred to keeper");
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  console.log(`
    const devMultisig = '${config.devMultisig}';
    const treasuryMultisig = '${config.treasuryMultisig}';
  
    export const beefyfinance = {
      devMultisig: '${config.devMultisig}',
      treasuryMultisig: '${config.treasuryMultisig}',
      strategyOwner: '${addresses.strategyOwner}',
      vaultOwner: '${addresses.vaultOwner}',
      keeper: '${keeper}',
      treasurer: '${config.treasuryMultisig}',
      launchpoolOwner: '${config.devMultisig}',
      rewardPool: '${ethers.constants.AddressZero}',
      treasury: '${ethers.constants.AddressZero}',
      beefyFeeRecipient: '${config.treasuryMultisig}',
      multicall: '${addresses.multicall}',
      bifiMaxiStrategy: '${ethers.constants.AddressZero}',
      voter: '${voter}',
      beefyFeeConfig: '${addresses.beefyFeeConfig}',
      vaultFactory: '${addresses.vaultFactory}',
      wrapperFactory: '${ethers.constants.AddressZero}',
      zap: '${ethers.constants.AddressZero}',
      zapTokenManager: '${ethers.constants.AddressZero}',
      treasurySwapper: '${ethers.constants.AddressZero}',
    
      /// CLM Contracts
      clmFactory: '${ethers.constants.AddressZero}',
      clmStrategyFactory: '${ethers.constants.AddressZero}',
      clmRewardPoolFactory: '${ethers.constants.AddressZero}',
      positionMulticall: '${ethers.constants.AddressZero}',
      clmVault: '${addresses.clmVault}',
    
      /// Beefy Swapper Contracts
      beefySwapper: '${addresses.beefySwapper}',
      beefyOracle: '${addresses.beefyOracle}',
      beefyOracleChainlink: '${ethers.constants.AddressZero}',
      beefyOracleUniswapV2: '${ethers.constants.AddressZero}',
      beefyOracleUniswapV3: '${ethers.constants.AddressZero}',
    } as const;
  `);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
