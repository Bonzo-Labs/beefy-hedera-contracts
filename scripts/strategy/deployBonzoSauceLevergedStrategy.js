const hardhat = require("hardhat");
const { ethers } = hardhat;
const addresses = require('../deployed-addresses.json');

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();
  console.log("Deploying contracts with account:", deployer.address);

  // Step 1: Deploy the strategy first
  console.log("Deploying BonzoSAUCELevergedLiqStaking...");
  const BonzoSAUCELevergedLiqStaking = await ethers.getContractFactory("BonzoSAUCELevergedLiqStaking");
  const strategy = await BonzoSAUCELevergedLiqStaking.deploy();
  await strategy.deployed();
  console.log("BonzoSAUCELevergedLiqStaking deployed to:", strategy.address);

  // Step 2: Connect to the vault factory
  const vaultFactoryAddress = addresses.vaultFactory;
  const vaultFactory = await ethers.getContractAt("BeefyVaultV7FactoryHedera", vaultFactoryAddress);
  console.log("Connected to vault factory at:", vaultFactoryAddress);

  // Step 3: Create a new vault using the factory
  console.log("Creating new vault...");
  const tx = await vaultFactory.cloneVault();
  const receipt = await tx.wait();
  
  // Get the new vault address from the ProxyCreated event
  const proxyCreatedEvent = receipt.events?.find(e => e.event === "ProxyCreated");
  const vaultAddress = proxyCreatedEvent?.args?.proxy;
  console.log("New vault deployed to:", vaultAddress);

  // Step 4: Connect to the newly created vault
  const vault = await ethers.getContractAt("BeefyVaultV7Hedera", vaultAddress);

  // Step 5: Initialize the strategy
  console.log("Initializing strategy...");
  
  // These addresses need to be configured for the target network
  const want = "0x000000000000000000000000000000000015a59b"; // xSAUCE token
  const borrowToken = "0x0000000000000000000000000000000000120f46"; // SAUCE token
  const aToken = "0x2217F55E2056C15a21ED7a600446094C36720f29"; // axSAUCE token
  const debtToken = "0x65be417A48511d2f20332673038e5647a4ED194D"; // debtSAUCE token
  const lendingPool = "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62"; // Bonzo lending pool address
  const rewardsController = "0x40f1f4247972952ab1D276Cf552070d2E9880DA6"; // Bonzo rewards controller address
  const stakingPool = "0x000000000000000000000000000000000015a59a"; // SaucerSwap staking pool address
  const maxBorrowable = 5000; // 50% in basis points
  const slippageTolerance = 50; // 0.5% in basis points
  const isRewardsAvailable = false;
  const isBonzoDeployer = true;

  const commonAddresses = {
    vault: vaultAddress,
    keeper: addresses.keeper,
    strategist: deployer.address,
    unirouter: "0x00000000000000000000000000000000000026e7",
    beefyFeeRecipient: addresses.beefyFeeRecipient,
    beefyFeeConfig: addresses.beefyFeeConfig
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
    {gasLimit: 3000000}
  );
  await stratInitTx.wait();
  console.log("Strategy initialized");

  // Step 6: Initialize the vault
  console.log("Initializing vault...");
  const isHederaToken = true; // Set to true for HTS tokens
  const vaultInitTx = await vault.initialize(
    strategy.address,
    "Beefy SAUCE Bonzo Leveraged",
    "bvSAUCE-BONZO-LEV",
    0, // Performance fee - set to 0 initially
    isHederaToken,
    {gasLimit: 3000000}
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
