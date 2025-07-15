import hardhat, { ethers } from "hardhat";
import BeefyOracleAbi from "../../data/abi/BeefyOracle.json";

// Configuration TESTNET
let addresses,tokenAddresses, supraOracleAddress;
const deployNewOracle = true;
let beefyOracleSupraAddress="";
if(!deployNewOracle && beefyOracleSupraAddress.length == 0) {
  throw new Error("BeefyOracleSupra address is not set and deployNewOracle is false");
}

if(process.env.CHAIN_TYPE === "mainnet") {
  addresses = require("../deployed-addresses-mainnet.json");
  supraOracleAddress = "0xA40a801E4F6Adc1Bb589ADc4f1999519C635dE50"; // Supra Oracle address
  const sauceAddress = "0x00000000000000000000000000000000000b2ad5";
  const whbarAddress = "0x0000000000000000000000000000000000163b5a";
  const usdcAddress = "0x000000000000000000000000000000000006f89a";
  const grelfAddress = "0x000000000000000000000000000000000011afa2"
  tokenAddresses = [sauceAddress, whbarAddress, usdcAddress, grelfAddress];
} else {
  addresses = require("../deployed-addresses.json");
  supraOracleAddress = "0xA55d9ac9aca329f5687e1cC286d0847e3f02062e"; // Supra Oracle address
  const tokenAddress = "0x0000000000000000000000000000000000120f46"; // SAUCE token
  const token2Address = "0x0000000000000000000000000000000000001549"; // USDC token
  const token3Address = "0x0000000000000000000000000000000000001599"; // DAI token
  const token4Address = "0x0000000000000000000000000000000000003ad2"; // WHBAR token
  const clxyAddress="0x00000000000000000000000000000000000014f5"; // CLXY token
  tokenAddresses = [tokenAddress, token4Address, clxyAddress];
}
const beefyOracleAddress = addresses.beefyOracle;

async function main() {
  console.log("Deploying BeefyOracleSupra library...");
  let DEPLOYER_PK;
  let KEEPER_PK;
  let HEDERA_RPC;
  if (process.env.CHAIN_TYPE === "testnet") {
    DEPLOYER_PK = process.env.DEPLOYER_PK;
    KEEPER_PK = process.env.KEEPER_PK;
    HEDERA_RPC = process.env.HEDERA_TESTNET_RPC;
  } else {
    DEPLOYER_PK = process.env.DEPLOYER_PK_MAINNET;
    KEEPER_PK = process.env.KEEPER_PK_MAINNET;
    HEDERA_RPC = process.env.HEDERA_MAINNET_RPC;
  }

  if (!DEPLOYER_PK || !KEEPER_PK) {
    throw new Error("Missing environment variables");
  }
  
  // Create signer using private key from environment variables
  const provider = new ethers.providers.JsonRpcProvider(HEDERA_RPC);
  const deployer = new ethers.Wallet(DEPLOYER_PK, provider);
  console.log("Deployer:", deployer.address);

  const keeper = new ethers.Wallet(KEEPER_PK, provider);
  console.log("Keeper:", keeper.address);

  // 1. Deploy BeefyOracleSupra library
  if(deployNewOracle) {
    const BeefyOracleSupra = await ethers.getContractFactory("BeefyOracleSupra", deployer);
    const beefyOracleSupra = await BeefyOracleSupra.deploy({gasLimit: 1000000});
    await beefyOracleSupra.deployed();
    console.log("BeefyOracleSupra deployed to:", beefyOracleSupra.address);
    beefyOracleSupraAddress = beefyOracleSupra.address;
  }

  // 2. Get the Beefy Oracle contract
  const beefyOracle = await ethers.getContractAt(BeefyOracleAbi, beefyOracleAddress, keeper);
  const owner = await beefyOracle.owner();
  console.log("BeefyOracle owner:", owner);
  
  // Check if deployer is the owner
  if (owner.toLowerCase() !== keeper.address.toLowerCase()) {
    console.log("Warning: Keeper is not the owner of the BeefyOracle contract");
  }

  // 3. Set oracle for a token
  for (const token of tokenAddresses) {
    console.log("Setting oracle for token:", token);
    const data = ethers.utils.defaultAbiCoder.encode(
      ["address", "address"], 
      [supraOracleAddress, token]
    );
    
    let tx = await beefyOracle.setOracle(token, beefyOracleSupraAddress, data, {gasLimit: 1000000});
    tx = await tx.wait();
    
    tx.status === 1
      ? console.log(`Oracle set for ${token} with tx: ${tx.transactionHash}`)
      : console.log(`Could not set oracle for ${token} with tx: ${tx.transactionHash}`);
    }
}
main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });