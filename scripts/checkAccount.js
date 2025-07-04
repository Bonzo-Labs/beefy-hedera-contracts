const hardhat = require("hardhat");
const ethers = hardhat.ethers;

async function main() {
  try {
    const deployer = await ethers.getSigner();
    console.log("Deployer address:", deployer.address);
    
    const balance = await deployer.getBalance();
    console.log("Balance:", ethers.utils.formatEther(balance), "HBAR");
    
    const nonce = await deployer.getTransactionCount();
    console.log("Nonce:", nonce);
    
    // Test if account can make a simple call
    const network = await ethers.provider.getNetwork();
    console.log("Network:", network);
    
  } catch (error) {
    console.error("Error checking account:", error.message);
    
    if (error.message.includes("not found")) {
      console.log("\n=== SOLUTION ===");
      console.log("Your account does not exist on Hedera testnet.");
      console.log("Solutions:");
      console.log("1. Fund your account with testnet HBAR from the faucet:");
      console.log("   https://portal.hedera.com/faucet");
      console.log("2. Or use a different account that exists on testnet");
      console.log("3. Check your private key in .env file");
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });