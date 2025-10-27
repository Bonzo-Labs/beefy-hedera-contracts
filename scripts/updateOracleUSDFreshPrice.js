import hardhat, { ethers } from "hardhat";
import BeefyOracleAbi from "../data/abi/BeefyOracle.json";

// Use mainnet deployed addresses as requested
const addresses = require("./deployed-addresses-mainnet.json");

// Hedera mainnet HBAR (WHBAR) address
const HBAR_MAINNET = "0x0000000000000000000000000000000000163b5a";

async function main() {
  const rpcUrl = process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api";
  const keeperPk = process.env.KEEPER_PK_MAINNET || process.env.KEEPER_PK;

  if (!keeperPk) {
    throw new Error("Missing KEEPER_PK_MAINNET (or KEEPER_PK) env var");
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(keeperPk, provider);

  const beefyOracleAddress = addresses.beefyOracle;
  if (!beefyOracleAddress || beefyOracleAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("BeefyOracle address not found in deployed-addresses-mainnet.json");
  }

  const beefyOracle = await ethers.getContractAt(BeefyOracleAbi, beefyOracleAddress, signer);

  // Log current stored price
  const before = await beefyOracle.getPriceInUSD(HBAR_MAINNET);
  console.log(`Before -> price: ${before}`);

  console.log(`Calling getFreshPriceInUSD(HBAR) on BeefyOracle at ${beefyOracleAddress}...`);
  const tx = await beefyOracle.getFreshPriceInUSD(HBAR_MAINNET, { gasLimit: 1_200_000 });
  console.log(`Submitted tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Mined in block ${receipt.blockNumber} status ${receipt.status}`);

  const after = await beefyOracle.getPriceInUSD(HBAR_MAINNET);
  console.log(`After  -> price: ${after}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });


