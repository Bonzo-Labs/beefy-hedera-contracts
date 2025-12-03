const { ethers } = require("hardhat");

const strategyAbi = [
  "function keeper() external view returns (address)",
  "function setKeeper(address _keeper) external"
];

function normalizeAddress(addressLabel, value) {
  if (!value) {
    throw new Error(`Missing ${addressLabel}. Provide it as an argument or env var.`);
  }

  if (!ethers.utils.isAddress(value)) {
    throw new Error(`Invalid ${addressLabel}: ${value}`);
  }

  return ethers.utils.getAddress(value);
}

async function setKeeper(strategyAddress, keeperAddress, signer) {
  const normalizedStrategy = normalizeAddress("strategy address", strategyAddress);
  const normalizedKeeper = normalizeAddress("keeper address", keeperAddress);
  const signerOrProvider = signer || (await ethers.getSigners())[0];

  const strategy = new ethers.Contract(normalizedStrategy, strategyAbi, signerOrProvider);

  const currentKeeper = await strategy.keeper();
  console.log(`Current keeper: ${currentKeeper}`);

  if (currentKeeper.toLowerCase() === normalizedKeeper.toLowerCase()) {
    console.log("Keeper already set to the desired address. Nothing to do.");
    return;
  }

  console.log(`Setting keeper to ${normalizedKeeper} on strategy ${normalizedStrategy} ...`);
  const tx = await strategy.setKeeper(normalizedKeeper, { gasLimit: 1000000 });
  console.log("Sent transaction:", tx.hash);

  const receipt = await tx.wait();
  console.log("Receipt trx hash:", receipt.transactionHash);
  console.log("Confirmed in block:", receipt.blockNumber);
}

/**
 * Example CLI usage:
 * STRATEGY_ADDRESS=0x... KEEPER_ADDRESS=0x... npx hardhat run scripts/strategy/setKeeper.js --network hedera_testnet
 * or
 * npx hardhat run scripts/strategy/setKeeper.js --network hedera_testnet -- 0xStrategy 0xKeeper
 */
if (require.main === module) {
  const strategyAddress = ""
  const keeperAddress = ""
  if (!strategyAddress.length || !keeperAddress.length) {
    console.error("please set strategy and keeper addresses");
    process.exit(1);
  }



  setKeeper(strategyAddress, keeperAddress)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { setKeeper };

