const hardhat = require("hardhat");
const { ethers } = hardhat;
let addresses;
if (process.env.CHAIN_TYPE === "mainnet") {
  addresses = require("../deployed-addresses-mainnet.json");
} else {
  addresses = require("../deployed-addresses.json");
}

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();
  console.log("Deploying contracts with account:", deployer.address);

  // Step 1: Deploy the strategy first
  console.log("Deploying BonzoSupplyStrategy...");
  const BonzoSupplyStrategy = await ethers.getContractFactory("BonzoSupplyStrategy");
  const strategy = await BonzoSupplyStrategy.deploy({ gasLimit: 3000000 });
  await strategy.deployed();
  console.log("BonzoSupplyStrategy deployed to:", strategy.address);

  // Step 2: Connect to the vault factory
  const vaultFactoryAddress = addresses.vaultFactory;
  const vaultFactory = await ethers.getContractAt("BonzoVaultV7Factory", vaultFactoryAddress);
  console.log("Connected to vault factory at:", vaultFactoryAddress);

  // Step 3: Create a new vault using the factory
  console.log("Creating new vault...");
  const tx = await vaultFactory.cloneVault({ gasLimit: 3000000 });
  const receipt = await tx.wait();

  // Get the new vault address from the ProxyCreated event
  const proxyCreatedEvent = receipt.events?.find(e => e.event === "ProxyCreated");
  const vaultAddress = proxyCreatedEvent?.args?.proxy;
  console.log("New vault deployed to:", vaultAddress);

  // Step 4: Connect to the newly created vault
  
  // note: used in case deployment fails inbetween
  // let vaultAddress="0x29612C9A07ECc0D5cb2BA3B9603ba5cFEba24f43";
  // let strategyAddress="0x3cb6623Ef399334484ea905eABcE72465169E121";
  // const strategy = await ethers.getContractAt("BonzoSupplyStrategy", strategyAddress);
   
  const vault = await ethers.getContractAt("BonzoVaultV7", vaultAddress);

  // Step 5: Initialize the strategy
  console.log("Initializing strategy...");

  // Configure addresses based on chain type
  let BONZO_TOKEN_ADDRESS, ABONZO_TOKEN_ADDRESS, LENDING_POOL_ADDRESS, REWARDS_CONTROLLER_ADDRESS;
  let UNIROUTER_ADDRESS;
  if (process.env.CHAIN_TYPE === "mainnet") {
    BONZO_TOKEN_ADDRESS = "0x00000000000000000000000000000000007e545e"; // Hedera BONZO token
    ABONZO_TOKEN_ADDRESS = "0xC5aa104d5e7D9baE3A69Ddd5A722b8F6B69729c9"; // aBONZO token
    LENDING_POOL_ADDRESS = "0x236897c518996163E7b313aD21D1C9fCC7BA1afc"; // Bonzo lending pool
    REWARDS_CONTROLLER_ADDRESS = "0x0f3950d2fCbf62a2D79880E4fc251E4CB6625FBC"; // Bonzo rewards controller
    UNIROUTER_ADDRESS = "0x00000000000000000000000000000000003c437a"; // Router address
} else {
    BONZO_TOKEN_ADDRESS = "0x0000000000000000000000000000000000001549"; // Hedera BONZO token (testnet)
    ABONZO_TOKEN_ADDRESS = "0xee72C37fEc48C9FeC6bbD0982ecEb7d7a038841e"; // aBONZO token (testnet)
    LENDING_POOL_ADDRESS = "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62"; // Bonzo lending pool (testnet)
    REWARDS_CONTROLLER_ADDRESS = "0x40f1f4247972952ab1D276Cf552070d2E9880DA6"; // Bonzo rewards controller (testnet)
    UNIROUTER_ADDRESS = "0x0000000000000000000000000000000000159398"; // Router address
  }

  const want = BONZO_TOKEN_ADDRESS; // BONZO token as collateral
  const aToken = ABONZO_TOKEN_ADDRESS; // aBONZO token
  const lendingPool = LENDING_POOL_ADDRESS; // Bonzo lending pool
  const rewardsController = REWARDS_CONTROLLER_ADDRESS; // Bonzo rewards controller
  const output = BONZO_TOKEN_ADDRESS; // BONZO token as reward
  const isHederaToken = true; // All tokens are HTS tokens

  const commonAddresses = {
    vault: vaultAddress,
    keeper: addresses.keeper,
    strategist: deployer.address,
    unirouter: UNIROUTER_ADDRESS, // SaucerSwap router
    beefyFeeRecipient: addresses.beefyFeeRecipient,
    beefyFeeConfig: addresses.beefyFeeConfig,
  };

  // Add a delay before initialization
  console.log("Waiting for 5 seconds before strategy initialization...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  const stratInitTx = await strategy.initialize(
    want,
    aToken,
    lendingPool,
    rewardsController,
    output,
    isHederaToken,
    commonAddresses,
    { gasLimit: 3000000 }
  );
  await stratInitTx.wait();
  console.log("Strategy initialized");

  // Step 6: Initialize the vault
  console.log("Initializing vault...");
  const vaultInitTx = await vault.initialize(
    strategy.address,
    "Beefy BONZO Supply",
    "bvBONZO-SUPPLY",
    0, // Performance fee - set to 0 initially
    true,
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
