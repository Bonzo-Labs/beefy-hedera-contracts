const { BigNumber } = require("ethers");
const hardhat = require("hardhat");

/**
 * Update positionWidth and max tick deviation on SaucerSwapLariRewardsCLMStrategy
 *
 * Usage:
 * npx hardhat run scripts/strategy/updateDeviationAndPositionWidth.js --network hedera_testnet
 */

const ethers = hardhat.ethers;

// =====================
// Configure here
// =====================
const STRATEGY_ADDRESSES = [
  "0x84b6978e0D5Dd3ed0e484cD3c4aE77e2B9E4CBb2",
];

// Desired values. Leave as undefined to skip that setting.
const NEW_POSITION_WIDTH = 8; // int24
const NEW_MAX_TICK_DEVIATION = 8; // int56. Will be clamped to (< 4 * tickSpacing)
const TRY_ANYWAY = false; // Attempt setPositionWidth even when not calm (may revert)

const strategyAbi = [
  "function owner() view returns (address)",
  "function pool() view returns (address)",
  "function isCalm() view returns (bool)",
  "function positionWidth() view returns (int24)",
  "function maxTickDeviation() view returns (int56)",
  "function setPositionWidth(int24 _positionWidth)",
  "function setDeviation(int56 _maxDeviation)",
  "function getMintFee() view returns (uint256)"
];

const univ3PoolAbi = [
  "function tickSpacing() view returns (int24)"
];

function ensureInt(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer`);
  }
  return n;
}

async function main() {
  if (!Array.isArray(STRATEGY_ADDRESSES) || STRATEGY_ADDRESSES.length === 0) {
    throw new Error("Configure STRATEGY_ADDRESSES in the script");
  }

  const newWidth = ensureInt(NEW_POSITION_WIDTH, "NEW_POSITION_WIDTH");
  const newDeviation = ensureInt(NEW_MAX_TICK_DEVIATION, "NEW_MAX_TICK_DEVIATION");
  if (newWidth === undefined && newDeviation === undefined) {
    throw new Error("Set NEW_POSITION_WIDTH and/or NEW_MAX_TICK_DEVIATION in the script");
  }

  const signer = await ethers.getSigner();
  console.log("Signer:", signer.address);

  for (const strategyAddress of STRATEGY_ADDRESSES) {
    console.log("\n=== Strategy:", strategyAddress, "===");
    const strategy = await ethers.getContractAt(strategyAbi, strategyAddress, signer);

    const [owner, poolAddr, currWidth, currDeviation] = await Promise.all([
      strategy.owner(),
      strategy.pool(),
      strategy.positionWidth(),
      strategy.maxTickDeviation(),
    ]);

    console.log("Owner:", owner);
    console.log("Pool:", poolAddr);
    console.log("Current positionWidth:", currWidth.toString());
    console.log("Current maxTickDeviation:", currDeviation.toString());

    let tickSpacing;
    try {
      const pool = await ethers.getContractAt(univ3PoolAbi, poolAddr);
      tickSpacing = await pool.tickSpacing();
      console.log("Pool tickSpacing:", tickSpacing.toString());
    } catch (e) {
      console.warn("Could not read pool.tickSpacing():", e.message);
    }

    if (newDeviation !== undefined) {
      let desiredDeviation = newDeviation;
      if (tickSpacing !== undefined) {
        const maxAllowed = Number(tickSpacing) * 4 - 1; // must be < 4 * tickSpacing
        if (desiredDeviation >= Number(tickSpacing) * 4) {
          console.warn(`Requested deviation ${desiredDeviation} >= 4*tickSpacing; clamping to ${maxAllowed}`);
          desiredDeviation = maxAllowed;
        }
      }

      if (desiredDeviation.toString() !== currDeviation.toString()) {
        console.log("Setting maxTickDeviation to:", desiredDeviation);
        let tx = await strategy.setDeviation(desiredDeviation, { gasLimit: 1_000_000 });
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error("setDeviation failed");
        console.log("setDeviation tx:", receipt.transactionHash);
      } else {
        console.log("maxTickDeviation already set; skipping");
      }
    }

    if (newWidth !== undefined) {
      const isCalm = await strategy.isCalm();
      console.log("isCalm:", isCalm);
      if (!isCalm && !TRY_ANYWAY) {
        console.warn("Not calm; skipping setPositionWidth. Set TRY_ANYWAY=true to attempt (may revert).");
      } else {
        if (newWidth.toString() !== currWidth.toString()) {
            console.log("Setting positionWidth to:", newWidth);
            const hbarRequired = await strategy.getMintFee();
            console.log("HBAR required for mint fee (wei):", hbarRequired.toString());
            const fundTx = await signer.sendTransaction({ to: strategy.address, value: BigNumber.from((2*hbarRequired*10**10).toString()) });
            const fundRcpt = await fundTx.wait();
            if (fundRcpt.status !== 1) throw new Error("Funding strategy with HBAR failed");
            console.log("Funded strategy with HBAR, tx:", fundRcpt.transactionHash);
            let tx = await strategy.setPositionWidth(newWidth, { gasLimit: 2_500_000 });
            const receipt = await tx.wait();
            if (receipt.status !== 1) throw new Error("setPositionWidth failed");
            console.log("setPositionWidth tx:", receipt.transactionHash);
        } else {
          console.log("positionWidth already set; skipping");
        }
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });


