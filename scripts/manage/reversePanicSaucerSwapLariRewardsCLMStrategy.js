const hardhat = require("hardhat");

/**
 * Script to reverse panic SaucerSwapLariRewardsCLMStrategy
 * 
 * This script restores the strategy after a panic by:
 * 1. Restoring token allowances
 * 2. Unpausing the strategy
 * 3. Setting tick positions
 * 4. Adding liquidity back to the pool
 * 
 * Usage:
 * STRATEGY_ADDRESS=0x... npx hardhat run scripts/manage/reversePanicSaucerSwapLariRewardsCLMStrategy.js --network hedera_mainnet
 * STRATEGY_ADDRESS=0x... npx hardhat run scripts/manage/reversePanicSaucerSwapLariRewardsCLMStrategy.js --network hedera_testnet
 * 
 * Note: reversePanic requires:
 * - Strategy to be paused
 * - Pool to be in calm state (onlyCalmPeriods modifier)
 * - Sufficient HBAR for mint fees (typically 2x getMintFee() for both positions)
 */

const ethers = hardhat.ethers;

// Get strategy address from environment variable
const STRATEGY_ADDRESS = "0x07A66c6F7cF1a8353Df3e51dB8396BaCceF1FFF1";

async function main() {
  if (!STRATEGY_ADDRESS) {
    throw new Error("STRATEGY_ADDRESS is required. Set it as environment variable.");
  }

  const [signer] = await ethers.getSigners();
  console.log("Account:", signer.address);
  console.log("Account balance:", ethers.utils.formatEther(await signer.getBalance()), "HBAR");
  console.log("Strategy address:", STRATEGY_ADDRESS);
  console.log("");

  // Connect to the strategy contract
  const strategy = await ethers.getContractAt(
    "SaucerSwapLariRewardsCLMStrategy",
    STRATEGY_ADDRESS,
    signer
  );

  // Check if strategy is paused (should be paused before reversePanic)
  try {
    const isPaused = await strategy.paused();
    if (!isPaused) {
      console.log("⚠️  Strategy is not paused! reversePanic should be called after panic.");
      console.log("   If you want to unpause without restoring liquidity, use unpause() instead.");
      return;
    }
    console.log("✅ Strategy is paused (as expected)");
  } catch (error) {
    console.log("⚠️  Could not check pause status:", error.message);
  }

  // Check if pool is calm (required by onlyCalmPeriods modifier)
  try {
    const isCalm = await strategy.isCalm();
    if (!isCalm) {
      console.log("❌ Pool is not in calm state! reversePanic requires calm periods.");
      console.log("   Please wait for the pool to be calm before calling reversePanic.");
      return;
    }
    console.log("✅ Pool is in calm state");
  } catch (error) {
    console.log("⚠️  Could not check calm status:", error.message);
    console.log("   Proceeding anyway...");
  }

  // Get strategy balances before reversePanic
  try {
    const [bal0, bal1] = await strategy.balances();
    console.log("\nStrategy balances before reversePanic:");
    console.log("  Token0:", bal0.toString());
    console.log("  Token1:", bal1.toString());
    
    if (bal0.isZero() && bal1.isZero()) {
      console.log("⚠️  Warning: Strategy has no token balances. reversePanic will not add liquidity.");
    }
  } catch (error) {
    console.log("⚠️  Could not fetch balances:", error.message);
  }

  // Get mint fee and calculate required HBAR
  let mintFee;
  let hbarRequired;
  try {
    mintFee = await strategy.getMintFee();
    // reversePanic may add liquidity to both main and alt positions, so we need 2x mint fee
    // Also add 50% buffer for safety
    hbarRequired = mintFee.mul(2).mul(150).div(100);
    console.log("\nMint fee (per position):", ethers.utils.formatEther(mintFee), "HBAR");
    console.log("HBAR required (2 positions + buffer):", ethers.utils.formatEther(hbarRequired), "HBAR");
  } catch (error) {
    console.log("⚠️  Could not fetch mint fee:", error.message);
    // Use a default value if getMintFee fails
    hbarRequired = ethers.utils.parseEther("0.2");
    console.log("   Using default:", ethers.utils.formatEther(hbarRequired), "HBAR");
  }

  // Call reversePanic function
  console.log("\n🔄 Calling reversePanic()...");
  try {
    // Send some HBAR with the transaction as well (in case strategy needs more)
    const txValue = hbarRequired.mul(10).div(100); // 10% of required as additional buffer
    
    const tx = await strategy.reversePanic({
      value: (hbarRequired * 10**10).toString(),
      gasLimit: 5000000, // Higher gas limit for reversePanic operations
    });

    console.log("Transaction hash:", tx.hash);
    console.log("Waiting for confirmation...");

    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      console.log("✅ Reverse panic successful!");
      console.log("   Transaction:", receipt.transactionHash);
      console.log("   Gas used:", receipt.gasUsed.toString());
      
      // Verify strategy is unpaused
      try {
        const isPaused = await strategy.paused();
        console.log("   Strategy paused:", isPaused);
        if (!isPaused) {
          console.log("   ✅ Strategy successfully unpaused");
        }
      } catch (error) {
        console.log("   Could not verify pause status");
      }

      // Get strategy balances after reversePanic
      try {
        const [bal0, bal1] = await strategy.balances();
        console.log("\nStrategy balances after reversePanic:");
        console.log("  Token0:", bal0.toString());
        console.log("  Token1:", bal1.toString());
        
        // Check pool balances
        const poolInfo = await strategy.balancesOfPool();
        console.log("\nPool position balances:");
        console.log("  Main Position - Token0:", poolInfo.mainAmount0.toString());
        console.log("  Main Position - Token1:", poolInfo.mainAmount1.toString());
        console.log("  Alt Position - Token0:", poolInfo.altAmount0.toString());
        console.log("  Alt Position - Token1:", poolInfo.altAmount1.toString());
        console.log("  Total Pool - Token0:", poolInfo.token0Bal.toString());
        console.log("  Total Pool - Token1:", poolInfo.token1Bal.toString());
      } catch (error) {
        console.log("   Could not fetch balances after reversePanic");
      }
    } else {
      console.log("❌ Reverse panic transaction failed!");
      console.log("   Transaction:", receipt.transactionHash);
    }
  } catch (error) {
    console.error("❌ Error calling reversePanic():", error.message);
    if (error.reason) {
      console.error("   Reason:", error.reason);
    }
    if (error.data) {
      console.error("   Data:", error.data);
    }
    
    // Provide helpful error messages
    if (error.message.includes("NotCalm") || error.message.includes("calm")) {
      console.error("\n💡 Tip: reversePanic requires the pool to be in a calm state.");
      console.error("   Wait for the pool to stabilize and try again.");
    } else if (error.message.includes("HBAR") || error.message.includes("mint fee")) {
      console.error("\n💡 Tip: Ensure the strategy has sufficient HBAR for mint fees.");
      console.error("   The script attempts to fund the strategy, but you may need to send more.");
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

