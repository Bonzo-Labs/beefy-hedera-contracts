const hardhat = require("hardhat");

/**
 * Script to manage BonzoHBARXLeveragedLiqStaking strategy
 * Handles both panic and unpause operations
 * 
 * Usage:
 * 1. Set OPERATION to either "panic" or "unpause" below
 * 2. Set STRATEGY_ADDRESS
 * 3. Run: npx hardhat run scripts/manage/manageBonzoHBARXLeveraged.js --network hedera_mainnet
 */

const ethers = hardhat.ethers;

// ========== CONFIGURATION ==========
const OPERATION = "both"; // Options: "panic", "unpause", or "both"
const STRATEGY_ADDRESS = "0x8d447Ef3532B625a71CA656CB07e7502b982B795"; // Set your strategy address here
// ===================================

async function main() {
  if (!STRATEGY_ADDRESS) {
    throw new Error("STRATEGY_ADDRESS is required. Set it in the script.");
  }

  if (OPERATION !== "panic" && OPERATION !== "unpause" && OPERATION !== "both") {
    throw new Error('OPERATION must be "panic", "unpause", or "both"');
  }

  const [signer] = await ethers.getSigners();
  console.log("Account:", signer.address);
  console.log("Account balance:", ethers.utils.formatEther(await signer.getBalance()), "HBAR");
  console.log("Strategy address:", STRATEGY_ADDRESS);
  console.log("Operation:", OPERATION.toUpperCase());
  console.log("");

  // Connect to the strategy contract
  const strategy = await ethers.getContractAt(
    "BonzoHBARXLevergedLiqStaking",
    STRATEGY_ADDRESS,
    signer
  );

  if (OPERATION === "panic") {
    await executePanic(strategy, STRATEGY_ADDRESS);
  } else if (OPERATION === "unpause") {
    await executeUnpause(strategy, STRATEGY_ADDRESS);
  } else if (OPERATION === "both") {
    console.log("📋 Executing BOTH operations: Panic → Unpause\n");
    console.log("=" .repeat(60));
    console.log("STEP 1: PANIC");
    console.log("=" .repeat(60) + "\n");
    await executePanic(strategy, STRATEGY_ADDRESS);
    
    console.log("\n" + "=" .repeat(60));
    console.log("STEP 2: UNPAUSE");
    console.log("=" .repeat(60) + "\n");
    
    // Small delay between operations
    console.log("⏳ Waiting 3 seconds before unpause...\n");
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    await executeUnpause(strategy, STRATEGY_ADDRESS);
    
    console.log("\n" + "=" .repeat(60));
    console.log("✅ BOTH OPERATIONS COMPLETED");
    console.log("=" .repeat(60));
  }
}

async function executePanic(strategy, strategyAddress) {
  // Check if already paused
  try {
    const isPaused = await strategy.paused();
    if (isPaused) {
      console.log("⚠️  Strategy is already paused!");
      return;
    }
    console.log("✅ Strategy is not paused");
  } catch (error) {
    console.log("⚠️  Could not check pause status:", error.message);
  }

  // Show balances before panic
  await showBalances(strategy, strategyAddress, "BEFORE PANIC");

  // Execute panic
  console.log("⚠️  Calling panic()...");
  console.log("This will:");
  console.log("  1. Claim rewards (if available)");
  console.log("  2. Unwind all yield loops");
  console.log("  3. Pause the strategy");
  console.log("");
  
  try {
    const tx = await strategy.panic({
      gasLimit: 10000000,
    });

    console.log("Transaction hash:", tx.hash);
    console.log("Waiting for confirmation...");

    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      console.log("✅ Panic successful!");
      console.log("   Transaction:", receipt.transactionHash);
      console.log("   Gas used:", receipt.gasUsed.toString());
      
      const isPaused = await strategy.paused();
      console.log("   Strategy paused:", isPaused);
      
      await showBalances(strategy, strategyAddress, "AFTER PANIC");
    } else {
      console.log("❌ Panic transaction failed!");
    }
  } catch (error) {
    console.error("❌ Error calling panic():", error.message);
    if (error.reason) console.error("   Reason:", error.reason);
    throw error;
  }
}

async function executeUnpause(strategy, strategyAddress) {
  // Check if paused
  try {
    const isPaused = await strategy.paused();
    if (!isPaused) {
      console.log("⚠️  Strategy is not paused!");
      return;
    }
    console.log("✅ Strategy is paused");
  } catch (error) {
    console.log("⚠️  Could not check pause status:", error.message);
  }

  // Show balances before unpause
  await showBalances(strategy, strategyAddress, "BEFORE UNPAUSE");

  // Execute unpause
  try {
    const tx = await strategy.unpause({
      gasLimit: 10000000,
    });

    console.log("Transaction hash:", tx.hash);
    console.log("Waiting for confirmation...");

    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      console.log("✅ Unpause successful!");
      console.log("   Transaction:", receipt.transactionHash);
      console.log("   Gas used:", receipt.gasUsed.toString());
      
      const isPaused = await strategy.paused();
      console.log("   Strategy paused:", isPaused);
      
      await showBalances(strategy, strategyAddress, "AFTER UNPAUSE");
    } else {
      console.log("❌ Unpause transaction failed!");
    }
  } catch (error) {
    console.error("❌ Error calling unpause():", error.message);
    if (error.reason) console.error("   Reason:", error.reason);
    throw error;
  }
}

async function showBalances(strategy, strategyAddress, label) {
  try {
    console.log(`\n${label}:`);
    
    const totalPosition = await strategy.balanceOf();
    const wantBalance = await strategy.balanceOfWant();
    const poolBalance = await strategy.balanceOfPool();
    
    console.log("  Total Position:", ethers.utils.formatUnits(totalPosition, 8), "HBARX");
    console.log("  Want Balance:", ethers.utils.formatUnits(wantBalance, 8), "HBARX");
    console.log("  Pool Balance:", ethers.utils.formatUnits(poolBalance, 8), "aHBARX");
    
    // Get debt balance
    try {
      const debtToken = await strategy.debtToken();
      const debtContract = await ethers.getContractAt("IERC20", debtToken);
      const debtBalance = await debtContract.balanceOf(strategyAddress);
      console.log("  Debt Balance:", ethers.utils.formatUnits(debtBalance, 8), "HBAR");
      
      if (debtBalance.gt(0)) {
        console.log("  ⚠️  Strategy has debt");
      }
    } catch (error) {
      console.log("  Could not fetch debt");
    }
    console.log("");
  } catch (error) {
    console.log("⚠️  Could not fetch balances:", error.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

