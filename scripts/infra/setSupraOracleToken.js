import hardhat, { ethers } from "hardhat";
import BeefyOracleAbi from "../../data/abi/BeefyOracle.json";

// Configuration - Update these values as needed
const supraOracleAddress = "0xA55d9ac9aca329f5687e1cC286d0847e3f02062e"; // Supra Oracle address
const beefyOracleAddress = "0xFBeb4a53B3F1398504C6255f5eC43E4736DcB5c0"; // Beefy Oracle address
const beefyOracleSupraAddress = "0xeC77a101B2718Bf5Cd1DA9b91F24aF403073999F"; // Beefy Oracle Supra address

async function main() {
  console.log("Setting Supra Oracle for token...");
  
  // Get token address from command line arguments
  const tokenAddress = "0x0000000000000000000000000000000000220ced";   //HBARX
  console.log("Token address:", tokenAddress);
  
  // Create signer using private key from environment variables
  const provider = new ethers.providers.JsonRpcProvider(process.env.HEDERA_TESTNET_RPC);
  const keeper = new ethers.Wallet(process.env.KEEPER_PK, provider);
  console.log("Keeper:", keeper.address);

  // Get the Beefy Oracle contract
  const beefyOracle = await ethers.getContractAt(BeefyOracleAbi, beefyOracleAddress, keeper);
  const owner = await beefyOracle.owner();
  console.log("BeefyOracle owner:", owner);
  
  // Check if keeper is the owner
  if (owner.toLowerCase() !== keeper.address.toLowerCase()) {
    console.log("Warning: Keeper is not the owner of the BeefyOracle contract");
  }

  // Set oracle for the token
  console.log("Setting oracle for token:", tokenAddress);
  const data = ethers.utils.defaultAbiCoder.encode(
    ["address", "address"],
    [supraOracleAddress, tokenAddress]
  );
  
  let tx = await beefyOracle.setOracle(tokenAddress, beefyOracleSupraAddress, data, {gasLimit: 1000000});
  tx = await tx.wait();
  
  tx.status === 1
    ? console.log(`Oracle set for ${tokenAddress} with tx: ${tx.transactionHash}`)
    : console.log(`Could not set oracle for ${tokenAddress} with tx: ${tx.transactionHash}`);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });

