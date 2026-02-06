const hardhat = require("hardhat");
const { ethers } = hardhat;

/**
 * Quick test script for moveTicks functionality
 * Tests the rebalancing/tick movement of the CLM strategy
 *
 * Usage:
 * STRATEGY_ADDRESS=0x... npx hardhat run scripts/strategy/testMoveTicks.js --network hedera_testnet
 *
 * Note: The caller must have the REBALANCER_ROLE on the strategy
 */

const STRATEGY_ADDRESS = "0xDC74aC010A60357A89008d5eBDBaF144Cf5BD8C6";
const HBAR_AMOUNT = "1.5"; // Default  HBAR

async function main() {
  if (!STRATEGY_ADDRESS) {
    throw new Error("STRATEGY_ADDRESS required");
  }

  const [user] = await ethers.getSigners();
  console.log("User:", user.address);
  console.log("Balance:", ethers.utils.formatEther(await user.getBalance()), "HBAR\n");

  // Connect to contracts
  const strategy = await ethers.getContractAt("SaucerSwapLariRewardsCLMStrategy", STRATEGY_ADDRESS);

  const token0Address = await strategy.lpToken0();
  const token1Address = await strategy.lpToken1();
  const token0 = await ethers.getContractAt("IERC20Metadata", token0Address);
  const token1 = await ethers.getContractAt("IERC20Metadata", token1Address);

  const decimals0 = await token0.decimals();
  const decimals1 = await token1.decimals();

  console.log("Strategy:", strategy.address);
  console.log("Token0:", token0Address);
  console.log("Token1:", token1Address);

  // Check if user has rebalancer role
  try {
    const REBALANCER_ROLE = await strategy.REBALANCER_ROLE();
    const hasRole = await strategy.hasRole(REBALANCER_ROLE, user.address);
    console.log("Has REBALANCER_ROLE:", hasRole);

    if (!hasRole) {
      console.log("⚠️  WARNING: User does not have REBALANCER_ROLE");
      console.log("   Transaction will likely fail unless user is admin");
    }
  } catch (e) {
    console.log("⚠️  Could not check rebalancer role");
  }

  // 1. Check state BEFORE moveTicks
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                  BEFORE MOVETICKS                              ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const [tvl0Before, tvl1Before] = await strategy.balances();
  console.log("\nStrategy TVL:");
  console.log("  Token0:", ethers.utils.formatUnits(tvl0Before, decimals0));
  console.log("  Token1:", ethers.utils.formatUnits(tvl1Before, decimals1));

  const strategyBal0Before = await token0.balanceOf(strategy.address);
  const strategyBal1Before = await token1.balanceOf(strategy.address);

  console.log("\nStrategy idle balance:");
  console.log("  Token0:", ethers.utils.formatUnits(strategyBal0Before, decimals0));
  console.log("  Token1:", ethers.utils.formatUnits(strategyBal1Before, decimals1));

  // Get current position info
  try {
    const positionMain = await strategy.positionMain();
    const positionAlt = await strategy.positionAlt();

    console.log("\nCurrent Positions:");
    console.log("  Main Position:");
    console.log("    - Tick Lower:", positionMain.tickLower);
    console.log("    - Tick Upper:", positionMain.tickUpper);
    console.log("    - Liquidity:", positionMain.liquidity.toString());
    console.log("  Alt Position:");
    console.log("    - Tick Lower:", positionAlt.tickLower);
    console.log("    - Tick Upper:", positionAlt.tickUpper);
    console.log("    - Liquidity:", positionAlt.liquidity.toString());
  } catch (e) {
    console.log("⚠️  Could not fetch position info");
  }

  // Get pool current tick
  try {
    const pool = await strategy.pool();
    const poolContract = await ethers.getContractAt("ISaucerSwapPool", pool);
    const slot0 = await poolContract.slot0();
    console.log("\nPool Current Tick:", slot0.tick);
  } catch (e) {
    console.log("⚠️  Could not fetch pool tick");
  }

  // 2. Call moveTicks
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                    CALLING MOVETICKS                           ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const hbarValue = ethers.utils.parseEther(HBAR_AMOUNT);
  console.log("\nSending HBAR:", HBAR_AMOUNT, "HBAR");
  console.log("Gas Limit: 5000000");

  console.log("\nCalling moveTicks...");
  try {
    const moveTicksTx = await strategy.moveTicks({
      gasLimit: 5000000,
      value: hbarValue,
    });

    console.log("Transaction:", moveTicksTx.hash);
    const receipt = await moveTicksTx.wait();
    console.log("✅ moveTicks successful! Block:", receipt.blockNumber);
    console.log("Gas Used:", receipt.gasUsed.toString());

    // Check for events
    console.log("\n📊 Transaction Events:");
    if (receipt.events && receipt.events.length > 0) {
      for (const event of receipt.events) {
        if (event.event) {
          console.log(`  - ${event.event}`);
        }
      }
    } else {
      console.log("  No events emitted");
    }
  } catch (error) {
    console.error("❌ moveTicks failed!");
    console.error("Error:", error.message);

    // Try to provide helpful error messages
    if (error.message.includes("calm")) {
      console.error("\n⚠️  Possible reason: Not in calm period (may have been called too recently)");
    } else if (error.message.includes("rebalancer") || error.message.includes("role")) {
      console.error("\n⚠️  Possible reason: Caller does not have REBALANCER_ROLE");
    }

    throw error;
  }

  // 3. Check state AFTER moveTicks
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                  AFTER MOVETICKS                               ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const [tvl0After, tvl1After] = await strategy.balances();
  console.log("\nStrategy TVL:");
  console.log("  Token0:", ethers.utils.formatUnits(tvl0After, decimals0));
  console.log("  Token1:", ethers.utils.formatUnits(tvl1After, decimals1));

  const strategyBal0After = await token0.balanceOf(strategy.address);
  const strategyBal1After = await token1.balanceOf(strategy.address);

  console.log("\nStrategy idle balance:");
  console.log("  Token0:", ethers.utils.formatUnits(strategyBal0After, decimals0));
  console.log("  Token1:", ethers.utils.formatUnits(strategyBal1After, decimals1));

  // Get new position info
  try {
    const positionMain = await strategy.positionMain();
    const positionAlt = await strategy.positionAlt();

    console.log("\nNew Positions:");
    console.log("  Main Position:");
    console.log("    - Tick Lower:", positionMain.tickLower);
    console.log("    - Tick Upper:", positionMain.tickUpper);
    console.log("    - Liquidity:", positionMain.liquidity.toString());
    console.log("  Alt Position:");
    console.log("    - Tick Lower:", positionAlt.tickLower);
    console.log("    - Tick Upper:", positionAlt.tickUpper);
    console.log("    - Liquidity:", positionAlt.liquidity.toString());
  } catch (e) {
    console.log("⚠️  Could not fetch position info");
  }

  // 4. Summary
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                       SUMMARY                                  ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const tvlChange0 = tvl0After.sub(tvl0Before);
  const tvlChange1 = tvl1After.sub(tvl1Before);

  console.log("\nTVL Changes:");
  console.log("  Token0:", ethers.utils.formatUnits(tvlChange0, decimals0));
  console.log("  Token1:", ethers.utils.formatUnits(tvlChange1, decimals1));

  const idleChange0 = strategyBal0After.sub(strategyBal0Before);
  const idleChange1 = strategyBal1After.sub(strategyBal1Before);

  console.log("\nIdle Balance Changes:");
  console.log("  Token0:", ethers.utils.formatUnits(idleChange0, decimals0));
  console.log("  Token1:", ethers.utils.formatUnits(idleChange1, decimals1));

  console.log("\n🎉 Test complete!");
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
