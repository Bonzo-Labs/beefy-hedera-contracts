const hardhat = require("hardhat");
const { ethers } = hardhat;

/**
 * Test script for moveTicks() with the new swap-based rebalance.
 *
 * Usage:
 * STRATEGY_ADDRESS=0x... HBAR_AMOUNT=1.5 npx hardhat run scripts/strategy/testMoveTicksWithSwap.js --network hedera_testnet
 *
 * Note: The caller must be an authorized rebalancer on the strategy.
 */

const STRATEGY_ADDRESS = "0x157EB9ba35d70560D44394206D4a03885C33c6d5";
const HBAR_AMOUNT = process.env.HBAR_AMOUNT || "1.5";

function fmtUnits(v, d) {
  return ethers.utils.formatUnits(v, d);
}

async function snapshot(strategy, token0, token1, decimals0, decimals1) {
  const [tvl0, tvl1] = await strategy.balances();
  const idle0 = await token0.balanceOf(strategy.address);
  const idle1 = await token1.balanceOf(strategy.address);
  const price = await strategy.price(); // 1e18 token1 per token0 (human units)

  // value(token0) expressed in token1 human units:
  // idle0Human = idle0 / 10^dec0 * 1e18
  const idle0Human = idle0.mul(ethers.constants.WeiPerEther).div(ethers.BigNumber.from(10).pow(decimals0));
  const idle1Human = idle1.mul(ethers.constants.WeiPerEther).div(ethers.BigNumber.from(10).pow(decimals1));
  const idle0ValueIn1Human = idle0Human.mul(price).div(ethers.constants.WeiPerEther);

  return {
    tvl0,
    tvl1,
    idle0,
    idle1,
    price,
    idle0Human,
    idle1Human,
    idle0ValueIn1Human,
  };
}

async function main() {
  const [user] = await ethers.getSigners();
  console.log("User:", user.address);
  console.log("Balance:", ethers.utils.formatEther(await user.getBalance()), "HBAR\n");

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
  console.log("Decimals0/1:", decimals0, decimals1, "\n");

  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║             BEFORE MOVETICKS (WITH SWAP REBALANCE)             ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const before = await snapshot(strategy, token0, token1, decimals0, decimals1);
  console.log("\nPool price (token1 per token0, 1e18):", before.price.toString());

  console.log("\nStrategy TVL:");
  console.log("  Token0:", fmtUnits(before.tvl0, decimals0));
  console.log("  Token1:", fmtUnits(before.tvl1, decimals1));

  console.log("\nStrategy idle balance:");
  console.log("  Token0:", fmtUnits(before.idle0, decimals0));
  console.log("  Token1:", fmtUnits(before.idle1, decimals1));

  console.log("\nIdle value comparison (token1 human units, 1e18):");
  console.log("  token0 value in token1:", before.idle0ValueIn1Human.toString());
  console.log("  token1 balance:", before.idle1Human.toString());

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                        CALLING MOVETICKS                       ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const hbarValue = ethers.utils.parseEther(HBAR_AMOUNT);
  console.log("\nSending HBAR:", HBAR_AMOUNT, "HBAR");
  console.log("Gas Limit: 5000000");
  console.log("\nCalling moveTicks...");

  const tx = await strategy.moveTicks({
    gasLimit: 5000000,
    value: hbarValue,
  });
  console.log("Transaction:", tx.hash);
  const receipt = await tx.wait();
  console.log("✅ moveTicks successful! Block:", receipt.blockNumber);
  console.log("Gas Used:", receipt.gasUsed.toString());

  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║              AFTER MOVETICKS (WITH SWAP REBALANCE)             ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const after = await snapshot(strategy, token0, token1, decimals0, decimals1);

  console.log("\nStrategy TVL:");
  console.log("  Token0:", fmtUnits(after.tvl0, decimals0));
  console.log("  Token1:", fmtUnits(after.tvl1, decimals1));

  console.log("\nStrategy idle balance:");
  console.log("  Token0:", fmtUnits(after.idle0, decimals0));
  console.log("  Token1:", fmtUnits(after.idle1, decimals1));

  console.log("\nIdle value comparison (token1 human units, 1e18):");
  console.log("  token0 value in token1:", after.idle0ValueIn1Human.toString());
  console.log("  token1 balance:", after.idle1Human.toString());

  console.log("\n🎉 Done.");
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
