const hardhat = require("hardhat");

/**
 * Script to panic SaucerSwapLariRewardsCLMStrategy
 * 
 * Usage:
 * STRATEGY_ADDRESS=0x... npx hardhat run scripts/manage/panicSaucerSwapLariRewardsCLMStrategy.js --network hedera_mainnet
 * STRATEGY_ADDRESS=0x... MIN_AMOUNT0=0 MIN_AMOUNT1=0 npx hardhat run scripts/manage/panicSaucerSwapLariRewardsCLMStrategy.js --network hedera_testnet
 * 
 * The panic function requires two parameters:
 * - _minAmount0: Minimum amount of token0 expected after panic
 * - _minAmount1: Minimum amount of token1 expected after panic
 * 
 * Setting both to 0 allows any amount (no slippage check).
 */

const ethers = hardhat.ethers;

// Get strategy address from environment variable or command line args
const STRATEGY_ADDRESS = "0x07A66c6F7cF1a8353Df3e51dB8396BaCceF1FFF1"
const MIN_AMOUNT0 = "0";
const MIN_AMOUNT1 = "0";

async function main() {
  if (!STRATEGY_ADDRESS) {
    throw new Error("STRATEGY_ADDRESS is required. Set it as environment variable or pass as first argument.");
  }

  const [signer] = await ethers.getSigners();
  console.log("Account:", signer.address);
  console.log("Account balance:", ethers.utils.formatEther(await signer.getBalance()), "HBAR");
  console.log("Strategy address:", STRATEGY_ADDRESS);
  console.log("Min Amount0:", MIN_AMOUNT0);
  console.log("Min Amount1:", MIN_AMOUNT1);
  console.log("");

  // Connect to the strategy contract
  const strategy = await ethers.getContractAt(
    "SaucerSwapLariRewardsCLMStrategy",
    STRATEGY_ADDRESS,
    signer
  );

  // Check if strategy is already paused
  try {
    const isPaused = await strategy.paused();
    if (isPaused) {
      console.log("⚠️  Strategy is already paused!");
      return;
    }
  } catch (error) {
    console.log("⚠️  Could not check pause status:", error.message);
  }

  // Get strategy balances before panic
  try {
    const [bal0, bal1] = await strategy.balances();
    console.log("Strategy balances before panic:");
    console.log("  Token0:", bal0.toString());
    console.log("  Token1:", bal1.toString());
    console.log("");
  } catch (error) {
    console.log("⚠️  Could not fetch balances:", error.message);
  }


  // Call panic function
  console.log("Calling panic()...");
  try {
    const minAmount0 = ethers.BigNumber.from(MIN_AMOUNT0);
    const minAmount1 = ethers.BigNumber.from(MIN_AMOUNT1);

    const tx = await strategy.panic(minAmount0, minAmount1, {
      gasLimit: 5000000, // Higher gas limit for panic operations
    });

    console.log("Transaction hash:", tx.hash);
    console.log("Waiting for confirmation...");

    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      console.log("✅ Panic successful!");
      console.log("   Transaction:", receipt.transactionHash);
      console.log("   Gas used:", receipt.gasUsed.toString());
      
      // Verify strategy is paused
      try {
        const isPaused = await strategy.paused();
        console.log("   Strategy paused:", isPaused);
      } catch (error) {
        console.log("   Could not verify pause status");
      }

      // Get strategy balances after panic
      try {
        const [bal0, bal1] = await strategy.balances();
        console.log("\nStrategy balances after panic:");
        console.log("  Token0:", bal0.toString());
        console.log("  Token1:", bal1.toString());
      } catch (error) {
        console.log("   Could not fetch balances after panic");
      }
    } else {
      console.log("❌ Panic transaction failed!");
      console.log("   Transaction:", receipt.transactionHash);
    }
  } catch (error) {
    console.error("❌ Error calling panic():", error.message);
    if (error.reason) {
      console.error("   Reason:", error.reason);
    }
    if (error.data) {
      console.error("   Data:", error.data);
    }
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
