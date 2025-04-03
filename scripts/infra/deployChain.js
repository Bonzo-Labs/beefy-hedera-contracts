const hardhat = require("hardhat");
const { upgrades } = require("hardhat");
const { addressBook } = require("blockchain-addressbook");

/**
 * Script used to deploy the basic infrastructure needed to run Beefy.
 */

const ethers = hardhat.ethers;

// const {
//   platforms: { 
//     beefyfinance: {
//       keeper,
//       voter, 
//       beefyFeeRecipient,
//     } },
// } = addressBook.;
const keeper = "0x05240efdafd4756cc6e50491f38baaa52ef12bbc";
const voter = "0x05240efdafd4756cc6e50491f38baaa52ef12bbc";
const beefyFeeRecipient = "0x05240efdafd4756cc6e50491f38baaa52ef12bbc";
const TIMELOCK_ADMIN_ROLE = "0x5f58e3a2316349923ce3780f8d587db2d72378aed66a8261c916544fa6846ca5";
const STRAT_OWNER_DELAY = 21600;
const VAULT_OWNER_DELAY = 0;
const KEEPER = keeper;

const config = {
  devMultisig: "0x05240efdafd4756cc6e50491f38baaa52ef12bbc",
  treasuryMultisig: "0x05240efdafd4756cc6e50491f38baaa52ef12bbc",
  totalLimit: "95000000000000000",
  callFee: "500000000000000",
  strategist: "5000000000000000"
};

const proposer = config.devMultisig || TRUSTED_EOA;
const timelockProposers = [proposer];
const timelockExecutors = [KEEPER];

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();

  const TimelockController = await ethers.getContractFactory("TimelockController");

  console.log("Deploying vault owner.");
  let deployParams = [VAULT_OWNER_DELAY, timelockProposers, timelockExecutors];
  const vaultOwner = await TimelockController.deploy(...deployParams);
  await vaultOwner.deployed();
  await vaultOwner.renounceRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  console.log(`Vault owner deployed to ${vaultOwner.address}`);


  console.log("Deploying strategy owner.");
  const stratOwner = await TimelockController.deploy(STRAT_OWNER_DELAY, timelockProposers, timelockExecutors);
  await stratOwner.deployed();
  await stratOwner.renounceRole(TIMELOCK_ADMIN_ROLE, deployer.address);
  console.log(`Strategy owner deployed to ${stratOwner.address}`);

  console.log("Deploying multicall");
  const Multicall = await ethers.getContractFactory("Multicall");
  const multicall = await Multicall.deploy();
  await multicall.deployed();
  console.log(`Multicall deployed to ${multicall.address}`);

  const BeefyFeeConfiguratorFactory = await ethers.getContractFactory("BeefyFeeConfigurator");
  console.log("Deploying BeefyFeeConfigurator");

  const constructorArguments = [keeper, config.totalLimit];
  const transparentUpgradableProxy = await upgrades.deployProxy(BeefyFeeConfiguratorFactory, constructorArguments);
  await transparentUpgradableProxy.deployed();

  await transparentUpgradableProxy.setFeeCategory(0, BigInt(config.totalLimit), BigInt(config.callFee), BigInt(config.strategist), "default", true, true);
  await transparentUpgradableProxy.transferOwnership(config.devMultisig);

  const implementationAddress = await upgrades.erc1967.getImplementationAddress(transparentUpgradableProxy.address);

  console.log();
  console.log("BeefyFeeConfig:", transparentUpgradableProxy.address);
  console.log(`Implementation address:`, implementationAddress);

  console.log("Deploying Vault Factory");
  const VaultFactory = await ethers.getContractFactory("BeefyVaultV7Factory");
  const VaultV7 = await ethers.getContractFactory("BeefyVaultV7Hedera");
  const vault7 = await VaultV7.deploy();
  await vault7.deployed();
  console.log(`Vault V7 deployed to ${vault7.address}`);

  const vaultFactory = await VaultFactory.deploy(vault7.address);
  await vaultFactory.deployed();
  console.log(`Vault Factory deployed to ${vaultFactory.address}`);

  console.log("Deploying Beefy Swapper");
  const BeefySwapper = await ethers.getContractFactory("BeefySwapperWithHTS");
  const beefySwapper = await BeefySwapper.deploy();
  await beefySwapper.deployed();

  console.log(`Beefy Swapper deployed to ${beefySwapper.address}`);

  console.log('Deploying Beefy Oracle');
  const BeefyOracle = await ethers.getContractFactory("BeefyOracle");
  const beefyOracle = await BeefyOracle.deploy();
  await beefyOracle.deployed();

  const initTrxSwapper = await beefySwapper.initialize(beefyOracle.address, config.totalLimit);
  const initTxReceiptSwapper = await initTrxSwapper.wait(1);
  console.log("initTxReceiptSwapper", initTxReceiptSwapper.transactionHash)

  const trxSwapper = await beefySwapper.transferOwnership(keeper);
  const txReceiptSwapper = await trxSwapper.wait(1);
  console.log("txReceiptSwapper", txReceiptSwapper.transactionHash)
  console.log("Beefy Swapper owner:", await beefySwapper.owner());
  

  const initTrx = await beefyOracle.initialize();
  const initTxReceipt = await initTrx.wait(1);
  console.log("initTxReceipt", initTxReceipt.transactionHash)

  const trx = await beefyOracle.transferOwnership(keeper);
  const txReceipt = await trx.wait(1);
  console.log("txReceipt", txReceipt.transactionHash)

  console.log(`Beefy Oracle deployed to ${beefyOracle.address}`);
  console.log("Beefy Oracle owner:", await beefyOracle.owner());

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
  `)
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
  