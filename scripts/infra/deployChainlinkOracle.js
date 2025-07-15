import hardhat, { ethers } from "hardhat";
import BeefyOracleAbi from "../../data/abi/BeefyOracle.json";

// Configuration TESTNET
let addresses,tokenAddresses, chainlinkAddress_hbar, chainlinkAddress_usdc, hbarAddress, usdcAddress;

if(process.env.CHAIN_TYPE === "mainnet") {
  addresses = require("../deployed-addresses-mainnet.json");
  chainlinkAddress_hbar = "0xAF685FB45C12b92b5054ccb9313e135525F9b5d5"; // Supra Oracle address
  chainlinkAddress_usdc = "0x2b358642c7C37b6e400911e4FE41770424a7349F"; // Supra Oracle address
  hbarAddress = "0x0000000000000000000000000000000000163b5a";
  usdcAddress = "0x000000000000000000000000000000000006f89a";
} else {
  addresses = require("../deployed-addresses.json");
  chainlinkAddress_hbar = "0xAF685FB45C12b92b5054ccb9313e135525F9b5d5"; // Supra Oracle address
  chainlinkAddress_usdc = "0x2b358642c7C37b6e400911e4FE41770424a7349F"; // Supra Oracle address
  hbarAddress = "0x0000000000000000000000000000000000003ad2";
  usdcAddress = "0x0000000000000000000000000000000000001549";
}
tokenAddresses = [hbarAddress, usdcAddress];
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
  const BeefyOracleChainlink = await ethers.getContractFactory("BeefyOracleChainlink", deployer);
  const beefyOracleChainlink = await BeefyOracleChainlink.deploy({gasLimit: 3000000});
  await beefyOracleChainlink.deployed();
  console.log("BeefyOracleChainlink deployed to:", beefyOracleChainlink.address);
  let beefyOracleChainlinkAddress = beefyOracleChainlink.address;

  // 2. Get the Beefy Oracle contract
  const beefyOracle = await ethers.getContractAt(BeefyOracleAbi, beefyOracleAddress, keeper);
  const owner = await beefyOracle.owner();
  console.log("BeefyOracle owner:", owner);
  
  // Check if deployer is the owner
  if (owner.toLowerCase() !== keeper.address.toLowerCase()) {
    console.log("Warning: Keeper is not the owner of the BeefyOracle contract");
  }

  // 3. Set oracle for a token hbar
    console.log("Setting oracle for token:", hbarAddress);
    const data = ethers.utils.defaultAbiCoder.encode(
      ["address"], 
      [chainlinkAddress_hbar]
    );
    
    let tx = await beefyOracle.setOracleForUSD(hbarAddress, beefyOracleChainlinkAddress, data, {gasLimit: 1000000});
    tx = await tx.wait();
    tx.status === 1
      ? console.log(`Oracle set for ${hbarAddress} with tx: ${tx.transactionHash}`)
      : console.log(`Could not set oracle for ${hbarAddress} with tx: ${tx.transactionHash}`);

    // 4. Set oracle for a token usdc
    console.log("Setting oracle for token:", usdcAddress);
    const data2 = ethers.utils.defaultAbiCoder.encode(
      ["address"], 
      [chainlinkAddress_usdc]
    );
    let tx2 = await beefyOracle.setOracleForUSD(usdcAddress, beefyOracleChainlinkAddress, data2, {gasLimit: 1000000});
    tx2 = await tx2.wait();
    tx2.status === 1
      ? console.log(`Oracle set for ${usdcAddress} with tx: ${tx2.transactionHash}`)
      : console.log(`Could not set oracle for ${usdcAddress} with tx: ${tx2.transactionHash}`);
    
    // get the price for hbar
    const price = await beefyOracle.getPriceInUSD(hbarAddress);
    console.log("Price for hbar:", price.toString());
    // get the price for usdc
    const price2 = await beefyOracle.getPriceInUSD(usdcAddress);
    console.log("Price for usdc:", price2.toString());

    const usdcHbarPrice = +price2.toString() / +price.toString();
    console.log("USDC/HBAR price:", usdcHbarPrice);

    // const data = ethers.utils.defaultAbiCoder.encode(
    //   ["address"], 
    //   [chainlinkAddress_hbar]
    // );
    // const beefyOracleChainlinkContract = await ethers.getContractAt("BeefyOracleChainlink", "0x0DA594027A33d221137E5B6198De0f3686296932", keeper);
    // const hbarPriceFromChainlink = await beefyOracleChainlink.getPriceI(data);
    // console.log("HBAR price from chainlink:", hbarPriceFromChainlink.toString());

}
main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });