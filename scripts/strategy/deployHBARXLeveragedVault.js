const hardhat = require("hardhat");
const { ethers } = hardhat;
const addresses = require("../deployed-addresses-mainnet.json");

async function main() {
  await hardhat.run("compile");

  const deployer = await ethers.getSigner();
  console.log("Deploying contracts with account:", deployer.address);

  const stakingContract = "0x0000000000000000000000000000000000158d97";

  // Step 1: Deploy the strategy first
  console.log("Deploying BonzoHBARXLeveragedLiqStaking...");
  const BonzoHBARXLeveragedLiqStaking = await ethers.getContractFactory("BonzoHBARXLevergedLiqStaking");
  const strategy = await BonzoHBARXLeveragedLiqStaking.deploy({gasLimit: 5000000});
  await strategy.deployed();
  console.log("BonzoHBARXLeveragedLiqStaking deployed to:", strategy.address);

  // Step 2: Connect to the vault factory
  const vaultFactoryAddress = addresses.vaultFactory;
  const vaultFactory = await ethers.getContractAt("BonzoVaultV7Factory", vaultFactoryAddress);
  console.log("Connected to vault factory at:", vaultFactoryAddress);

  // Step 3: Create a new vault using the factory
  console.log("Creating new vault...");
  const tx = await vaultFactory.cloneVault({gasLimit: 3000000});
  const receipt = await tx.wait();

  // Get the new vault address from the ProxyCreated event
  const proxyCreatedEvent = receipt.events?.find(e => e.event === "ProxyCreated");
  const vaultAddress = proxyCreatedEvent?.args?.proxy;
  console.log("New vault deployed to:", vaultAddress);

  // Step 4: Connect to the newly created vault
  // note: used in case deployment fails inbetween
  // let vaultAddress="0x16A63c621a7EA760689738aFC0e3D2fe42805f62";
  // let strategyAddress="0x6337fBB285A48Fd6F54Df74B9Eab326d4b8dE9a1";
  // const strategy = await ethers.getContractAt("BonzoHBARXLevergedLiqStaking", strategyAddress);

  const vault = await ethers.getContractAt("BonzoVaultV7", vaultAddress);

  // Step 5: Initialize the strategy
  console.log("Initializing strategy...");

  // These addresses need to be configured for the target network
  const want = "0x00000000000000000000000000000000000cba44"; // HBARX token
  const borrowToken = "0x0000000000000000000000000000000000163b5a"; // WHBAR token (or native HBAR representation)
  const aToken = "0x40EBC87627Fe4689567C47c8C9C84EDC4Cf29132"; // aHBARX token address
  const debtToken = "0xCD5A1FF3AD6EDd7e85ae6De3854f3915dD8c9103"; // debtWHBAR token address
  const lendingPool = "0x236897c518996163E7b313aD21D1C9fCC7BA1afc"; // Bonzo lending pool address
  const rewardsController = "0x0f3950d2fCbf62a2D79880E4fc251E4CB6625FBC"; // Bonzo rewards controller address

  // Strategy parameters
  const maxBorrowable = 4000; // 80% max borrowable
  const slippageTolerance = 50; // 0.5% slippage tolerance
  const isRewardsAvailable = false; // Whether rewards are available
  const isBonzoDeployer = false; // Whether this is deployed by Bonzo team

  const commonAddresses = {
    vault: vaultAddress, // Set the vault address
    keeper: addresses.keeper,
    strategist: deployer.address,
    unirouter: "0x00000000000000000000000000000000003c437a", // Router address
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
    stakingContract,
    maxBorrowable,
    slippageTolerance,
    isRewardsAvailable,
    isBonzoDeployer,
    commonAddresses,
    {
      gasLimit: 5000000,
    }
  );
  await stratInitTx.wait();
  console.log("Strategy initialized");

  // Step 6: Initialize the vault
  console.log("Initializing vault...");
  const isHederaToken = true; // Set to true for HTS tokens
  const vaultInitTx = await vault.initialize(
    strategy.address,
    "Beefy HBARX Leveraged Bonzo",
    "bvHBARX-LEV-BONZO",
    0, // Performance fee - set to 0 initially
    isHederaToken,
    { gasLimit: 3000000 }
  );
  await vaultInitTx.wait();
  console.log("Vault initialized");

  // Step 7: Verify deployment
  console.log("Verifying deployment...");
  const strategyWant = await strategy.want();
  const strategyBorrowToken = await strategy.borrowToken();
  const strategyVault = await strategy.vault();
  const strategyMaxBorrowable = await strategy.maxBorrowable();
  const strategyMaxLoops = await strategy.maxLoops();

  console.log("Strategy verification:");
  console.log("- Want token:", strategyWant);
  console.log("- Borrow token:", strategyBorrowToken);
  console.log("- Vault address:", strategyVault);
  console.log("- Max borrowable:", strategyMaxBorrowable.toString());
  console.log("- Max loops:", strategyMaxLoops.toString());

  const vaultStrategy = await vault.strategy();
  const vaultName = await vault.name();
  const vaultSymbol = await vault.symbol();

  console.log("Vault verification:");
  console.log("- Strategy address:", vaultStrategy);
  console.log("- Vault name:", vaultName);
  console.log("- Vault symbol:", vaultSymbol);

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
