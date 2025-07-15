import hardhat, { ethers } from "hardhat";
import BeefyOracleAbi from "../../data/abi/BeefyOracle.json";

// Configuration
let addresses, tokenAddresses, supraOracleAddress;
if(process.env.CHAIN_TYPE === "mainnet") {
  addresses = require("../deployed-addresses-mainnet.json");
  supraOracleAddress = "0xA40a801E4F6Adc1Bb589ADc4f1999519C635dE50"; // Supra Oracle address
  const sauceAddress = "0x00000000000000000000000000000000000b2ad5";
  const whbarAddress = "0x0000000000000000000000000000000000163b5a";
  const usdcAddress = "0x000000000000000000000000000000000006f89a";
  tokenAddresses = [sauceAddress, whbarAddress, usdcAddress];
} else {
  addresses = require("../deployed-addresses.json");
  supraOracleAddress = "0xA55d9ac9aca329f5687e1cC286d0847e3f02062e"; // Supra Oracle address
  const tokenAddress = "0x0000000000000000000000000000000000120f46"; // SAUCE token
  const token4Address = "0x0000000000000000000000000000000000003ad2"; // WHBAR token
  tokenAddresses = [tokenAddress, token4Address];
}

const beefyOracleAddress = addresses.beefyOracle;

async function main() {
  console.log("Getting token prices from Supra Oracle...");
  
  let DEPLOYER_PK;
  let HEDERA_RPC;
  if (process.env.CHAIN_TYPE === "testnet") {
    DEPLOYER_PK = process.env.DEPLOYER_PK;
    HEDERA_RPC = process.env.HEDERA_TESTNET_RPC;
  } else {
    DEPLOYER_PK = process.env.DEPLOYER_PK_MAINNET;
    HEDERA_RPC = process.env.HEDERA_MAINNET_RPC;
  }

  if (!DEPLOYER_PK) {
    throw new Error("Missing environment variables");
  }
  
  // Create signer using private key from environment variables
  const provider = new ethers.providers.JsonRpcProvider(HEDERA_RPC);
  const deployer = new ethers.Wallet(DEPLOYER_PK, provider);
  console.log("Deployer:", deployer.address);

  // Get the Beefy Oracle contract
  const beefyOracle = await ethers.getContractAt(BeefyOracleAbi, beefyOracleAddress, deployer);
  console.log("Connected to BeefyOracle at:", beefyOracleAddress);

  // Get token prices
  for (const token of tokenAddresses) {
    try {
      console.log(`\nGetting price for token: ${token}`);
      
      // Get the price from the oracle
      const price = await beefyOracle.getPrice(token);
      console.log(`Price for token ${token}: ${JSON.stringify(price)}`);
      console.log(`Price for token ${token}: ${price.toString()}`);
      
      // Get additional price information if available
    //   try {
    //     const priceWithDecimals = await beefyOracle.getPriceWithDecimals(token);
    //     console.log(`Price with decimals: ${ethers.utils.formatUnits(priceWithDecimals.price, priceWithDecimals.decimals)} USD`);
    //   } catch (error) {
    //     console.log("Price with decimals not available for this token");
    //   }
      
    } catch (error) {
      console.error(`Error getting price for token ${token}:`, error.message);
    }
  }

  // Also try to get price directly from Supra Oracle if needed
//   console.log("\n--- Direct Supra Oracle Access ---");
//   try {
//     const supraOracle = await ethers.getContractAt("ISupraOracle", supraOracleAddress, deployer);
    
//     for (const token of tokenAddresses) {
//       try {
//         // Note: You'll need to know the specific price feed ID for each token
//         // This is just an example - you'll need to replace with actual feed IDs
//         const feedId = 1; // Replace with actual feed ID for each token
//         const priceData = await supraOracle.getPrice(feedId);
//         console.log(`Direct Supra price for token ${token} (feed ${feedId}):`, priceData);
//       } catch (error) {
//         console.log(`Direct Supra Oracle access failed for token ${token}:`, error.message);
//       }
//     }
//   } catch (error) {
//     console.log("Direct Supra Oracle access not available:", error.message);
//   }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
