import hardhat, { ethers } from "hardhat";
import BeefyOracleAbi from "../../data/abi/BeefyOracle.json";
import addresses from "../deployed-addresses.json";

// Configuration TESTNET
const supraOracleAddress = "0xA55d9ac9aca329f5687e1cC286d0847e3f02062e"; // Supra Oracle address
const tokenAddress = "0x0000000000000000000000000000000000120f46"; // SAUCE token
// const token2Address = "0x0000000000000000000000000000000000001549"; // USDC token
// const token3Address = "0x0000000000000000000000000000000000001599"; // DAI token
const token4Address = "0x0000000000000000000000000000000000003ad2"; // WHBAR token
const tokenAddresses = [tokenAddress, token4Address];
const beefyOracleAddress = addresses.beefyOracle;

async function main() {
  console.log("Deploying BeefyOracleSupra library...");
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
  const BeefyOracleSupra = await ethers.getContractFactory("BeefyOracleSupra", deployer);
  const beefyOracleSupra = await BeefyOracleSupra.deploy();
  await beefyOracleSupra.deployed();
  console.log("BeefyOracleSupra deployed to:", beefyOracleSupra.address);

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
    
    let tx = await beefyOracle.setOracle(token, beefyOracleSupra.address, data, {gasLimit: 1000000});
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