const hardhat = require("hardhat");
const { ethers } = hardhat;
let addresses;
if(process.env.CHAIN_TYPE === "mainnet") {
  addresses = require("../deployed-addresses-mainnet.json");
} else {
  addresses = require("../deployed-addresses.json");
}

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();
  console.log("Deploying contracts with account:", deployer.address);

  // Step 1: Connect to the vault factory
  const vaultFactoryAddress = addresses.vaultFactory;
  const vaultFactory = await ethers.getContractAt("BonzoVaultV7Factory", vaultFactoryAddress);
  console.log("Connected to vault factory at:", vaultFactoryAddress);

  // Step 2: Create a new vault using the factory
  console.log("Creating new vault...");
  const tx = await vaultFactory.cloneVault({ gasLimit: 3000000 });
  const receipt = await tx.wait();

  // Get the new vault address from the ProxyCreated event
  const proxyCreatedEvent = receipt.events?.find(e => e.event === "ProxyCreated");
  let vaultAddress = proxyCreatedEvent?.args?.proxy;
  console.log("New vault deployed to:", vaultAddress);

  // Step 3: Deploy the strategy first
  console.log("Deploying BonzoSAUCELevergedLiqStaking...");
  const BonzoSAUCELevergedLiqStaking = await ethers.getContractFactory("BonzoSAUCELevergedLiqStaking");
  const strategy = await BonzoSAUCELevergedLiqStaking.deploy({ gasLimit:5000000 });
  await strategy.deployed();
  console.log("BonzoSAUCELevergedLiqStaking deployed to:", strategy.address);


  // Step 4: Connect to the newly created vault

  // note: used in case deployment fails inbetween
  // let vaultAddress="0xb1Ba4210fd85e33c6036353201f79eA5aa77ed6F";
  // let strategyAddress="0xd02C7503B3D81e249C09bD427DA821535c376EC0";
  // const strategy = await ethers.getContractAt("BonzoSAUCELevergedLiqStaking", strategyAddress);
  
  const vault = await ethers.getContractAt("BonzoVaultV7", vaultAddress);

  // Step 5: Initialize the strategy
  console.log("Initializing strategy...");

  // These addresses need to be configured for the target network
  const want = "0x00000000000000000000000000000000001647e8"; // xSAUCE token
  const borrowToken = "0x00000000000000000000000000000000000b2ad5"; // SAUCE token
  const aToken = "0xEc9CEF1167b4673726B1e5f5A978150e63cDf23b"; // axSAUCE token
  const debtToken = "0x736c5dbB8ADC643f04c1e13a9C25f28d3D4f0503"; // debtSAUCE token
  const lendingPool = "0x236897c518996163E7b313aD21D1C9fCC7BA1afc"; // Bonzo lending pool address
  const rewardsController = "0x0f3950d2fCbf62a2D79880E4fc251E4CB6625FBC"; // Bonzo rewards controller address
  const stakingPool = "0x00000000000000000000000000000000001647e7"; // SaucerSwap staking pool address
  const maxBorrowable = 4000; // 50% in basis points
  const slippageTolerance = 50; // 0.5% in basis points
  const isRewardsAvailable = false;
  const isBonzoDeployer = true;

  const commonAddresses = {
    vault: vaultAddress,
    keeper: addresses.keeper,
    strategist: deployer.address,
    unirouter: "0x00000000000000000000000000000000003c437a",
    beefyFeeRecipient: addresses.beefyFeeRecipient,
    beefyFeeConfig: addresses.beefyFeeConfig,
  };

  // Add a delay before initialization
  console.log("Waiting for 5 seconds before strategy initialization...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  const stratInitTx = await strategy.initialize(
    want,
    borrowToken,
    aToken,
    debtToken,
    lendingPool,
    rewardsController,
    stakingPool,
    maxBorrowable,
    slippageTolerance,
    isRewardsAvailable,
    isBonzoDeployer,
    commonAddresses,
    { gasLimit: 3000000 }
  );
  await stratInitTx.wait();
  console.log("Strategy initialized");
  
  console.log("Waiting for 5 seconds before vault initialization...");
  await new Promise(resolve => setTimeout(resolve, 5000));
  // Step 6: Initialize the vault
  console.log("Initializing vault...");
  const isHederaToken = true; // Set to true for HTS tokens
  const vaultInitTx = await vault.initialize(
    strategy.address,
    "Beefy SAUCE Bonzo Leveraged",
    "bvSAUCE-BONZO-LEV",
    0, // Performance fee - set to 0 initially
    isHederaToken,
    { gasLimit: 3000000 }
  );
  await vaultInitTx.wait();
  console.log("Vault initialized");

  console.log("Deployment completed successfully");
  console.log("Strategy:", strategy.address);
  console.log("Vault:", vaultAddress);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
