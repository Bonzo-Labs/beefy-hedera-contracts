const hardhat = require("hardhat");
const { ethers } = hardhat;

//*******************SET CHAIN TYPE HERE*******************
const CHAIN_TYPE = process.env.CHAIN_TYPE;
//*******************SET CHAIN TYPE HERE*******************

let addresses;
if (CHAIN_TYPE === "mainnet") {
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
  const vault = await ethers.getContractAt("BonzoVaultV7", vaultAddress);

  // Step 5: Initialize the strategy
  console.log("Initializing strategy...");

  // Dynamic addresses based on chain type
  let want, aToken, debtToken, lendingPool, rewardsController, output, unirouter;

  if (CHAIN_TYPE === "testnet") {
    want = "0x0000000000000000000000000000000000120f46";
    aToken = "0xC4d4315Ac919253b8bA48D5e609594921eb5525c";
    debtToken = "0x65be417A48511d2f20332673038e5647a4ED194D";
    lendingPool = "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62"; // Bonzo lending pool testnet
    rewardsController = "0x40f1f4247972952ab1D276Cf552070d2E9880DA6"; // Bonzo rewards controller testnet
    output = want; // Output is same as want
    unirouter = "0x00000000000000000000000000000000000026e7"; // SaucerSwap router
  } else if (CHAIN_TYPE === "mainnet") {
    want = "0x00000000000000000000000000000000007e545e"; // BONZO token mainnet
    aToken = "0xC5aa104d5e7D9baE3A69Ddd5A722b8F6B69729c9"; // aBONZO token mainnet
    debtToken = "0x1790C9169480c5C67D8011cd0311DDE1b2DC76e0"; // debtBONZO token mainnet
    lendingPool = "0x236897c518996163E7b313aD21D1C9fCC7BA1afc"; // Bonzo lending pool mainnet
    rewardsController = "0x0f3950d2fCbf62a2D79880E4fc251E4CB6625FBC"; // Bonzo rewards controller mainnet
    output = want; // Output is same as want
    unirouter = "0x00000000000000000000000000000000003c437a"; // SaucerSwap router
  } else {
    throw new Error(`Unsupported CHAIN_TYPE: ${CHAIN_TYPE}. Use 'testnet' or 'mainnet'`);
  }

  // Validate required addresses
  if (!want || !aToken || !debtToken) {
    console.log("⚠️ Warning: Some token addresses are empty. This may be expected for testnet.");
    console.log(`CHAIN_TYPE: ${CHAIN_TYPE}`);
    console.log(`Want: ${want}`);
    console.log(`aToken: ${aToken}`);
    console.log(`debtToken: ${debtToken}`);

    if (CHAIN_TYPE === "mainnet") {
      throw new Error("All token addresses must be provided for mainnet deployment");
    }

    if (CHAIN_TYPE === "testnet") {
      console.log("Skipping deployment for testnet - token addresses not available yet");
      return;
    }
  }

  const isHederaToken = true; // All tokens are HTS tokens
  const leverageLoops = 2; // Number of leverage loops (2-5)

  const commonAddresses = {
    vault: vaultAddress,
    unirouter: unirouter, // Router address
    keeper: addresses.keeper,
    strategist: deployer.address,
    beefyFeeRecipient: addresses.beefyFeeRecipient,
    beefyFeeConfig: addresses.beefyFeeConfig,
  };
  console.log("Common addresses:", commonAddresses);

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
