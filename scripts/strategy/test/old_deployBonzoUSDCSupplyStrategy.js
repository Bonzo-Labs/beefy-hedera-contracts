const hardhat = require("hardhat");
const { ethers } = hardhat;

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();
  console.log("Deploying contracts with account:", deployer.address);

  // Get contract factory
  const BonzoUSDCSupplyStrategy = await ethers.getContractFactory("BonzoUSDCSupplyStrategy");

  // Deploy strategy
  console.log("Deploying BonzoUSDCSupplyStrategy...");
  const strategy = await BonzoUSDCSupplyStrategy.deploy();
  await strategy.deployed();
  console.log("BonzoUSDCSupplyStrategy deployed to:", strategy.address);

  // Initialize strategy
  console.log("Initializing strategy...");
  
  // These addresses need to be configured for the target network
  const want = "0x0000000000000000000000000000000000001549"; // Hedera USDC token
  const aToken = "0xee72C37fEc48C9FeC6bbD0982ecEb7d7a038841e"; // aUSDC token address
  const lendingPool = "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62"; // Bonzo lending pool address  
  const rewardsController = "0x40f1f4247972952ab1D276Cf552070d2E9880DA6"; // Bonzo rewards controller address
  const output = "0x0000000000000000000000000000000000001549"; // Reward token is also USDC

  const commonAddresses = {
    vault: "0x0000000000000000000000000000000000000000", // Vault address will be set later
    keeper: "0x05240efdafd4756cc6e50491f38baaa52ef12bbc",
    strategist: "0x05240efdafd4756cc6e50491f38baaa52ef12bbc",
    unirouter: "0x00000000000000000000000000000000000026e7", // Router address
    beefyFeeRecipient: "0x05240efdafd4756cc6e50491f38baaa52ef12bbc",
    beefyFeeConfig: "0x57c996f670364cAE84DEc46eA42E1Bc755e9A264" // Fee config address
  };

  
  // Add a 5 second delay before initialization
  console.log("Waiting for 5 seconds before initialization...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  const tx = await strategy.initialize(
    want,
    aToken, 
    lendingPool,
    rewardsController,
    output,
    commonAddresses,
    {gasLimit: 3000000}
  );
  const receipt = await tx.wait();
  console.log("Transaction receipt:", receipt);

  console.log("Strategy initialized");

  console.log("Deployment completed");
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
