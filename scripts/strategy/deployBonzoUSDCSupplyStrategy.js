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
  const aToken = "0x2e8Ba2d93436A275Cacb663Cb5129B8CDe087D44"; // aUSDC token address
  const lendingPool = "0x102a8435D5875cEa9066F486bD560EfA6A45677c"; // Bonzo lending pool address  
  const rewardsController = "0x39b98c21d9B4821d775Ab5c1F0F7a9cBA279f9Bc"; // Bonzo rewards controller address
  const output = want; // Reward token is also USDC

  const commonAddresses = {
    keeper: "0x05240efdafd4756cc6e50491f38baaa52ef12bbc",
    strategist: "0x05240efdafd4756cc6e50491f38baaa52ef12bbc",
    unirouter: "0x00000000000000000000000000000000000026e7", // Router address
    beefyFeeRecipient: "0x05240efdafd4756cc6e50491f38baaa52ef12bbc",
    beefyFeeConfig: "0xCeb8ab445Ab748C9C609b18C3CDAae8d79F06D6c" // Fee config address
  };

  await strategy.initialize(
    want,
    aToken, 
    lendingPool,
    rewardsController,
    output,
    commonAddresses
  );

  console.log("Strategy initialized");


  console.log("Deployment completed");
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
