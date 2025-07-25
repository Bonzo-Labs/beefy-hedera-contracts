import hardhat, { ethers } from "hardhat";
import BeefyOracleAbi from "../../data/abi/BeefyOracle.json";

// Configuration
const supraOracleAddress = "0xA55d9ac9aca329f5687e1cC286d0847e3f02062e"; // Supra Oracle address
const tokenAddress = "0x0000000000000000000000000000000000120f46"; // SAUCE token
const beefyOracleAddress = "0x3f1DDEd53Ab55520698d11e4D3295F8dAE2a834f"; // Beefy Oracle address

async function main() {
  console.log("Testing BeefyOracle with Supra Oracle integration...");
  
  const chainType = process.env.CHAIN_TYPE;
  let DEPLOYER_PK;
  let KEEPER_PK;
  let HEDERA_RPC;
  if (chainType !== "testnet") {
    DEPLOYER_PK = process.env.DEPLOYER_PK;
    KEEPER_PK = process.env.KEEPER_PK;
    HEDERA_RPC = process.env.HEDERA_RPC;
  } else {
    DEPLOYER_PK = process.env.DEPLOYER_PK_TESTNET;
    KEEPER_PK = process.env.KEEPER_PK_TESTNET;
    HEDERA_RPC = process.env.HEDERA_MAINNET_RPC;
  }


  // Create signer using private key from environment variables
  const provider = new ethers.providers.JsonRpcProvider(HEDERA_RPC);
  const deployer = new ethers.Wallet(DEPLOYER_PK, provider);
  console.log("Deployer:", deployer.address);

  // Get the Beefy Oracle contract
  const beefyOracle = await ethers.getContractAt(BeefyOracleAbi, beefyOracleAddress, deployer);
  console.log("Connected to BeefyOracle at:", beefyOracleAddress);

  // Get oracle information for the token
  const oracleInfo = await beefyOracle.subOracle(tokenAddress);
  console.log("Oracle Info for token:", tokenAddress);
  console.log("Oracle Address:", oracleInfo);
  const staleness = await beefyOracle.staleness();
  console.log(`Staleness: ${staleness}`);

  const latestPrice = await beefyOracle.latestPrice(tokenAddress);
  console.log(`Latest Price: ${latestPrice}`);

  // Test getting the price
  try {
    const price1 = await beefyOracle.getPrice(tokenAddress);
    console.log(`Price of token: ${price1} `);
    
    const getPriceTrx = await beefyOracle.getFreshPrice(tokenAddress);
    console.log(`Result trx hash: ${getPriceTrx.hash}`);
    
    // // Get the last update time
    // const lastUpdated = await beefyOracle.lastUpdated(tokenAddress);
    // const lastUpdatedDate = new Date(lastUpdated.toNumber() * 1000);
    // console.log(`Last updated: ${lastUpdatedDate.toLocaleString()}`);
    
    // // Calculate time since last update
    // const now = Math.floor(Date.now() / 1000);
    // const timeSinceUpdate = now - lastUpdated.toNumber();
    // console.log(`Time since last update: ${timeSinceUpdate} seconds (${Math.floor(timeSinceUpdate / 60)} minutes)`);
    
    // // Check if the price is stale (more than 1 hour old)
    // if (timeSinceUpdate > 3600) {
    //   console.log("WARNING: Price data is stale (more than 1 hour old)");
    // }
  } catch (error) {
    console.error("Error getting price:", error.message);
    
    // Try to get more detailed error information
    if (error.data) {
      const errorReason = error.data.toString();
      console.error("Error data:", errorReason);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
