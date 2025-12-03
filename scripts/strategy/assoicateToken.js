const { ethers } = require("hardhat");

async function associateToken(strategyAddress, tokenAddress, signer) {
  // The correct ABI, per the contract, is:
  // function associateToken(address token) external onlyOwner
  // Only `associateToken()` is externally callable, _associateToken is internal
  const strategyAbi = [
    "function associateToken(address token) external"
  ];
  const signerOrProvider = signer || (await ethers.getSigners())[0];

  const strategy = new ethers.Contract(strategyAddress, strategyAbi, signerOrProvider);

  // Call the associateToken function
  console.log(`Associating token ${tokenAddress} with strategy at ${strategyAddress} ...`)
  const tx = await strategy.associateToken(tokenAddress, {gasLimit: 500000});
  console.log("Sent transaction:", tx.hash);
  const receipt = await tx.wait();
  console.log("Receipt trx hash:", receipt.transactionHash);
  console.log("Confirmed in block:", receipt.blockNumber);
}

// Example CLI usage: node assoicateToken.js <strategyAddress> <tokenAddress>
if (require.main === module) {
  const strategyAddress = "0xD4e57FB18f6B791C9EdC9C955e47aB5F67402614";
  const tokenAddress = "0x0000000000000000000000000000000000163b5a";
  associateToken(strategyAddress, tokenAddress)
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}

