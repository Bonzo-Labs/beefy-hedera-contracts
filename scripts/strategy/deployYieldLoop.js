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

  // Step 1: Deploy the YieldLoopConfigurable strategy first
  console.log("Deploying YieldLoopConfigurable...");
  const YieldLoopConfigurable = await ethers.getContractFactory("YieldLoopConfigurable");
  const strategy = await YieldLoopConfigurable.deploy({ gasLimit: 5000000 });
  await strategy.deployed();
  console.log("YieldLoopConfigurable deployed to:", strategy.address);

  // Step 2: Connect to the vault factory
  const vaultFactoryAddress = addresses.vaultFactory;
  const vaultFactory = await ethers.getContractAt("BeefyVaultV7FactoryHedera", vaultFactoryAddress);
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
  const vault = await ethers.getContractAt("BeefyVaultV7Hedera", vaultAddress);

  // Step 5: Initialize the strategy
  console.log("Initializing strategy...");

  // Mainnet addresses for BONZO token YieldLoop strategy
  const want = "0x00000000000000000000000000000000007e545e"; // BONZO token as collateral
  const aToken = "0xC5aa104d5e7D9baE3A69Ddd5A722b8F6B69729c9"; // aBONZO token
  const debtToken = "0x1790C9169480c5C67D8011cd0311DDE1b2DC76e0"; // debtBONZO token
  const lendingPool = "0x236897c518996163E7b313aD21D1C9fCC7BA1afc"; // Bonzo lending pool
  const rewardsController = "0x0f3950d2fCbf62a2D79880E4fc251E4CB6625FBC"; // Bonzo rewards controller
  const output = "0x00000000000000000000000000000000007e545e"; // BONZO token as reward
  const isHederaToken = true; // All tokens are HTS tokens
  const leverageLoops = 2; // Number of leverage loops (2-5)

  const commonAddresses = {
    vault: vaultAddress,
    keeper: addresses.keeper,
    strategist: deployer.address,
    unirouter: "0x00000000000000000000000000000000000026e7", // SaucerSwap router
    beefyFeeRecipient: addresses.beefyFeeRecipient,
    beefyFeeConfig: addresses.beefyFeeConfig,
  };

  // Add a delay before initialization
  console.log("Waiting for 5 seconds before strategy initialization...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  const stratInitTx = await strategy.initialize(
    want,
    aToken,
    debtToken,
    lendingPool,
    rewardsController,
    output,
    isHederaToken,
    leverageLoops,
    commonAddresses,
    { gasLimit: 3000000 }
  );
  await stratInitTx.wait();
  console.log("Strategy initialized");

  // Step 6: Initialize the vault
  console.log("Initializing vault...");
  const vaultInitTx = await vault.initialize(
    strategy.address,
    "Beefy BONZO YieldLoop",
    "bvBONZO-YLOOP",
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
