const hardhat = require("hardhat");
const fs = require("fs");
const path = require("path");

const ethers = hardhat.ethers;
const CHAIN_TYPE = process.env.CHAIN_TYPE;

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

const config = {
  devMultisig: keeper,
  treasuryMultisig: keeper,
  totalLimit: "95000000000000000",
  callFee: "500000000000000",
  strategist: "5000000000000000",
};

const proposer = config.devMultisig;
const timelockProposers = [proposer];
const timelockExecutors = [keeper];

async function main() {
  await hardhat.run("compile");
  const deployer = await ethers.getSigner();
  console.log("Deployer address:", deployer.address);

  // Deploy TimelockControllers
  const TimelockController = await ethers.getContractFactory("TimelockController");
  console.log("Deploying vault owner...");
  const vaultOwner = await TimelockController.deploy(VAULT_OWNER_DELAY, timelockProposers, timelockExecutors, { gasLimit: 5000000 });
  await vaultOwner.deployed();
  await vaultOwner.renounceRole(TIMELOCK_ADMIN_ROLE, deployer.address, { gasLimit: 5000000 });
  console.log(`Vault owner deployed to ${vaultOwner.address}`);

  console.log("Deploying strategy owner...");
  const stratOwner = await TimelockController.deploy(STRAT_OWNER_DELAY, timelockProposers, timelockExecutors, { gasLimit: 5000000 });
  await stratOwner.deployed();
  await stratOwner.renounceRole(TIMELOCK_ADMIN_ROLE, deployer.address, { gasLimit: 5000000 });
  console.log(`Strategy owner deployed to ${stratOwner.address}`);

  // Deploy Multicall
  console.log("Deploying multicall...");
  const Multicall = await ethers.getContractFactory("Multicall");
  const multicall = await Multicall.deploy({ gasLimit: 5000000 });
  await multicall.deployed();
  console.log(`Multicall deployed to ${multicall.address}`);

  // Deploy BeefyFeeConfigurator
  console.log("Deploying BeefyFeeConfigurator...");
  const BeefyFeeConfiguratorFactory = await ethers.getContractFactory("BeefyFeeConfigurator");
  const beefyFeeConfigurator = await BeefyFeeConfiguratorFactory.deploy({ gasLimit: 5_000_000 });
  await beefyFeeConfigurator.deployed();
  console.log(`BeefyFeeConfigurator deployed to ${beefyFeeConfigurator.address}`);
  
  await beefyFeeConfigurator.initialize(keeper, config.totalLimit, { gasLimit: 5_000_000 });
  await beefyFeeConfigurator.setFeeCategory(0, BigInt(config.totalLimit), BigInt(config.callFee), BigInt(config.strategist), "default", true, true, { gasLimit: 5000000 });
  await beefyFeeConfigurator.transferOwnership(config.devMultisig, { gasLimit: 5000000 });
  console.log("BeefyFeeConfigurator configured and ownership transferred");

  // Deploy Vault Factory
  console.log("Deploying Vault Factory...");
  const VaultFactory = await ethers.getContractFactory("BonzoVaultV7Factory");
  const VaultV7 = await ethers.getContractFactory("BonzoVaultV7");
  const vault7 = await VaultV7.deploy({ gasLimit: 5000000 });
  await vault7.deployed();
  console.log(`Vault V7 deployed to ${vault7.address}`);

  const VaultV7MultiToken = await ethers.getContractFactory("BeefyVaultV7HederaMultiToken");
  const vault7MultiToken = await VaultV7MultiToken.deploy({ gasLimit: 5000000 });
  await vault7MultiToken.deployed();
  console.log(`Vault V7 MultiToken deployed to ${vault7MultiToken.address}`);

  const vaultFactory = await VaultFactory.deploy(vault7.address, vault7MultiToken.address, { gasLimit: 5000000 });
  await vaultFactory.deployed();
  console.log(`Vault Factory deployed to ${vaultFactory.address}`);

  // Skip BeefySwapper and BeefyOracle for now
  console.log("Skipping BeefySwapper and BeefyOracle due to deployment issues");

  // Create addresses object
  const addresses = {
    vaultFactory: vaultFactory.address,
    vaultV7: vault7.address,
    vaultV7MultiToken: vault7MultiToken.address,
    beefySwapper: ethers.constants.AddressZero, // Skip for now
    beefyOracle: ethers.constants.AddressZero, // Skip for now
    keeper: keeper,
    devMultisig: config.devMultisig,
    treasuryMultisig: config.treasuryMultisig,
    strategyOwner: stratOwner.address,
    vaultOwner: vaultOwner.address,
    treasurer: config.treasuryMultisig,
    launchpoolOwner: config.devMultisig,
    rewardPool: ethers.constants.AddressZero,
    treasury: ethers.constants.AddressZero,
    beefyFeeRecipient: config.treasuryMultisig,
    multicall: multicall.address,
    bifiMaxiStrategy: ethers.constants.AddressZero,
    voter: voter,
    beefyFeeConfig: beefyFeeConfigurator.address,
    wrapperFactory: ethers.constants.AddressZero,
    zap: ethers.constants.AddressZero,
    zapTokenManager: ethers.constants.AddressZero,
    treasurySwapper: ethers.constants.AddressZero,
    clmFactory: ethers.constants.AddressZero,
    clmStrategyFactory: ethers.constants.AddressZero,
    clmRewardPoolFactory: ethers.constants.AddressZero,
    positionMulticall: ethers.constants.AddressZero,
    beefyOracleChainlink: ethers.constants.AddressZero,
    beefyOracleUniswapV2: ethers.constants.AddressZero,
    beefyOracleUniswapV3: ethers.constants.AddressZero,
  };

  // Write addresses to JSON file
  const addressesPath = CHAIN_TYPE === "mainnet" 
    ? path.join(__dirname, "..", "deployed-addresses-mainnet.json")
    : path.join(__dirname, "..", "deployed-addresses.json");
  fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));
  console.log(`Addresses saved to ${addressesPath}`);

  console.log("✅ Core infrastructure deployed successfully!");
  console.log("⚠️  Note: BeefySwapper and BeefyOracle were skipped due to deployment issues");
  console.log("📋 Next steps: Deploy BeefySwapper and BeefyOracle separately if needed");
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });