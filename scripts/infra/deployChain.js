const hardhat = require("hardhat");
const { upgrades } = require("hardhat");
const { addressBook } = require("blockchain-addressbook");
const fs = require('fs');
const path = require('path');

/**
 * Script used to deploy the basic infrastructure needed to run Beefy-Bonzo on Hedera.
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

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();

  const TimelockController = await ethers.getContractFactory("TimelockController");

  console.log("Deploying vault owner.");
  let deployParams = [VAULT_OWNER_DELAY, timelockProposers, timelockExecutors];
  const vaultOwner = await TimelockController.deploy(...deployParams, {gasLimit:5000000});
  await vaultOwner.deployed();
  await vaultOwner.renounceRole(TIMELOCK_ADMIN_ROLE, deployer.address, {gasLimit:5000000});
  console.log(`Vault owner deployed to ${vaultOwner.address}`);

  console.log("Deploying strategy owner.");
  const stratOwner = await TimelockController.deploy(STRAT_OWNER_DELAY, timelockProposers, timelockExecutors, {gasLimit:5000000});
  await stratOwner.deployed();
  await stratOwner.renounceRole(TIMELOCK_ADMIN_ROLE, deployer.address, {gasLimit:5000000});
  console.log(`Strategy owner deployed to ${stratOwner.address}`);

  console.log("Deploying multicall");
  const Multicall = await ethers.getContractFactory("Multicall");
  const multicall = await Multicall.deploy({gasLimit:5000000});
  await multicall.deployed();
  console.log(`Multicall deployed to ${multicall.address}`);

  const BeefyFeeConfiguratorFactory = await ethers.getContractFactory("BeefyFeeConfigurator");
  console.log("Deploying BeefyFeeConfigurator");

  const constructorArguments = [keeper, config.totalLimit];
  const transparentUpgradableProxy = await upgrades.deployProxy(BeefyFeeConfiguratorFactory, constructorArguments, {
    kind: "transparent",
    initializer: "initialize",
    txOverrides: {
      gasLimit: 1000000000,
    },
  });
  console.log("BeefyFeeConfigurator deploying...");
  await transparentUpgradableProxy.deployed();
  console.log(`BeefyFeeConfigurator deployed to ${transparentUpgradableProxy.address}`);
  console.log("Setting BeefyFeeConfigurator fee category");
  // const BeefyFeeConfigurator = await ethers.getContractFactory("BeefyFeeConfigurator");
  // const beefyFeeConfigurator = await BeefyFeeConfigurator.deploy(keeper, config.totalLimit, { gasLimit: 5_000_000 });
  // await beefyFeeConfigurator.deployed();
  // console.log("Standalone at", beefyFeeConfigurator.address);
 
  // const transparentUpgradableProxy = beefyFeeConfigurator;

  await transparentUpgradableProxy.setFeeCategory(
    0,
    BigInt(config.totalLimit),
    BigInt(config.callFee),
    BigInt(config.strategist),
    "default",
    true,
    true,
    {gasLimit:5000000}
  );
  console.log("Setting BeefyFeeConfigurator ownership");
  await transparentUpgradableProxy.transferOwnership(config.devMultisig, {gasLimit:5000000});
  console.log("BeefyFeeConfigurator ownership set");
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(transparentUpgradableProxy.address);
  console.log("BeefyFeeConfigurator implementation address:", implementationAddress);
  console.log("BeefyFeeConfig:", transparentUpgradableProxy.address);

  console.log("Deploying Vault Factory");
  const VaultFactory = await ethers.getContractFactory("BeefyVaultV7FactoryHedera");
  const VaultV7 = await ethers.getContractFactory("BeefyVaultV7Hedera");
  const vault7 = await VaultV7.deploy({gasLimit:5000000});
  await vault7.deployed();
  console.log(`Vault V7 deployed to ${vault7.address}`);

  const VaultV7MultiToken = await ethers.getContractFactory("BeefyVaultV7HederaMultiToken");
  const vault7MultiToken = await VaultV7MultiToken.deploy({gasLimit:5000000});
  await vault7MultiToken.deployed();
  console.log(`Vault V7 MultiToken deployed to ${vault7MultiToken.address}`);

  const vaultFactory = await VaultFactory.deploy(vault7.address, vault7MultiToken.address, {gasLimit:5000000});
  await vaultFactory.deployed();
  console.log(`Vault Factory deployed to ${vaultFactory.address}`);

  console.log("Deploying Beefy Swapper");
  const BeefySwapper = await ethers.getContractFactory("BeefySwapper");
  const beefySwapper = await BeefySwapper.deploy({gasLimit:5000000});
  await beefySwapper.deployed();

  console.log(`Beefy Swapper deployed to ${beefySwapper.address}`);

  console.log("Deploying Beefy Oracle");
  const BeefyOracle = await ethers.getContractFactory("BeefyOracle");
  const beefyOracle = await BeefyOracle.deploy({gasLimit:5000000});
  await beefyOracle.deployed();
  console.log(`Beefy Oracle deployed to ${beefyOracle.address}`);

  // Add 5 seconds timeout to ensure transactions are processed
  console.log("Waiting 5 seconds before initializing...");
  await new Promise(resolve => setTimeout(resolve, 5000));
  beefySwapper.initialize(beefyOracle.address, config.totalLimit, {gasLimit:5000000});

  console.log("Waiting 5 seconds before transferring ownership...");
  await new Promise(resolve => setTimeout(resolve, 10000));
  beefySwapper.transferOwnership(keeper, {gasLimit:5000000});
  console.log("Beefy Swapper ownership transferred to keeper");

  console.log("Waiting 5 seconds before initializing...");
  await new Promise(resolve => setTimeout(resolve, 30000));
  beefyOracle.initialize({gasLimit:5000000});
  console.log("Beefy Oracle initialized");

  console.log("Waiting 5 seconds before transferring ownership...");
  await new Promise(resolve => setTimeout(resolve,10000));
  await beefyOracle.transferOwnership(keeper, {gasLimit:5000000});
  console.log(`Beefy Oracle deployed to ${beefyOracle.address}`);
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Create addresses object
  const addresses = {
    vaultFactory: vaultFactory.address,
    vaultV7: vault7.address,
    vaultV7MultiToken: vault7MultiToken.address,
    beefySwapper: beefySwapper.address,
    beefyOracle: beefyOracle.address,
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
    beefyFeeConfig: transparentUpgradableProxy.address,
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
    beefyOracleUniswapV3: ethers.constants.AddressZero
  };

  // Write addresses to JSON file
  const addressesPath = CHAIN_TYPE === "mainnet" ? path.join(__dirname, '..', 'deployed-addresses-mainnet.json') : path.join(__dirname, '..', 'deployed-addresses.json');
  fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));
  console.log(`Addresses saved to ${addressesPath}`);

  console.log(`
    const devMultisig = '${config.devMultisig}';
    const treasuryMultisig = '${config.treasuryMultisig}';
  
    export const beefyfinance = {
      devMultisig: '${config.devMultisig}',
      treasuryMultisig: '${config.treasuryMultisig}',
      strategyOwner: '${stratOwner.address}',
      vaultOwner: '${vaultOwner.address}',
      keeper: '${keeper}',
      treasurer: '${config.treasuryMultisig}',
      launchpoolOwner: '${config.devMultisig}',
      rewardPool: '${ethers.constants.AddressZero}',
      treasury: '${ethers.constants.AddressZero}',
      beefyFeeRecipient: '${config.treasuryMultisig}',
      multicall: '${multicall.address}',
      bifiMaxiStrategy: '${ethers.constants.AddressZero}',
      voter: '${voter}',
      beefyFeeConfig: '${transparentUpgradableProxy.address}',
      vaultFactory: '${vaultFactory.address}',
      wrapperFactory: '${ethers.constants.AddressZero}',
      zap: '${ethers.constants.AddressZero}',
      zapTokenManager: '${ethers.constants.AddressZero}',
      treasurySwapper: '${ethers.constants.AddressZero}',
    
      /// CLM Contracts
      clmFactory: '${ethers.constants.AddressZero}',
      clmStrategyFactory: '${ethers.constants.AddressZero}',
      clmRewardPoolFactory: '${ethers.constants.AddressZero}',
      positionMulticall: '${ethers.constants.AddressZero}',
    
      /// Beefy Swapper Contracts
      beefySwapper: '${beefySwapper.address}',
      beefyOracle: '${beefyOracle.address}',
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
