const hardhat = require("hardhat");
const { ethers } = hardhat;

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();
  console.log("Deploying contracts with account:", deployer.address);

  // Step 1: Deploy the strategy first
  console.log("Deploying BonzoUSDCSupplyStrategy...");
  const BonzoUSDCSupplyStrategy = await ethers.getContractFactory("BonzoUSDCSupplyStrategy");
  const strategy = await BonzoUSDCSupplyStrategy.deploy();
  await strategy.deployed();
  console.log("BonzoUSDCSupplyStrategy deployed to:", strategy.address);

  // Step 2: Connect to the vault factory
  const vaultFactoryAddress = "0x1995169a48A451914DF021931d0034EA38259f44"; // Update this if needed
  const vaultFactory = await ethers.getContractAt("BeefyVaultV7Factory", vaultFactoryAddress);
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
  const want = "0x0000000000000000000000000000000000001549"; // Hedera USDC token
  const aToken = "0xee72C37fEc48C9FeC6bbD0982ecEb7d7a038841e"; // aUSDC token address
  const lendingPool = "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62"; // Bonzo lending pool address
  const rewardsController = "0x40f1f4247972952ab1D276Cf552070d2E9880DA6"; // Bonzo rewards controller address
  const output = "0x0000000000000000000000000000000000001549"; // Reward token is also USDC

  const commonAddresses = {
    vault: vaultAddress, // Set the vault address
    keeper: "0xbe058ee0884696653e01cfc6f34678f2762d84db",
    strategist: "0xbe058ee0884696653e01cfc6f34678f2762d84db",
    unirouter: "0x00000000000000000000000000000000000026e7", // Router address
    beefyFeeRecipient: "0xbe058ee0884696653e01cfc6f34678f2762d84db",
    beefyFeeConfig: "0x88B0e70751fDEf7881684C1bBB32DE0C16E0aCa0", // Fee config address
  };

  // Add a delay before initialization
  console.log("Waiting for 5 seconds before strategy initialization...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  const stratInitTx = await strategy.initialize(want, aToken, lendingPool, rewardsController, output, commonAddresses, {
    gasLimit: 3000000,
  });
  await stratInitTx.wait();
  console.log("Strategy initialized");

  // Step 6: Initialize the vault
  console.log("Initializing vault...");
  const isHederaToken = true; // Set to true for HTS tokens
  const vaultInitTx = await vault.initialize(
    strategy.address,
    "Beefy USDC Bonzo",
    "bvUSDC-BONZO",
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
