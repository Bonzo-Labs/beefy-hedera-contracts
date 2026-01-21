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
const STRATEGIES = [
  // {
  //   name: "BONZO-XBONZO",
  //   vaultAddress: "0xcfba07324bd207C3ED41416a9a36f8184F9a2134",
  //   strategyAddress: "0x3Dab58797e057878d3cD8f78F28C6967104FcD0c",
  //   positionWidth: 2,
  //   maxTickDev: 20,
  // },
  // {
  //   name: "SAUCE-XSAUCE",
  //   vaultAddress: "0x8AEE31dFF6264074a1a3929432070E1605F6b783",
  //   strategyAddress: "0xE9Ab1D3C3d086A8efA0f153f107B096BEaBDee6f",
  //   positionWidth: 2,
  //   maxTickDev: 20,
  // },
  {
    name: "USDC-HBAR",
    vaultAddress: "0x724F19f52A3E0e9D2881587C997db93f9613B2C7",
    strategyAddress: "0x157EB9ba35d70560D44394206D4a03885C33c6d5",
    positionWidth: 70,
    maxTickDev: 30,
  },
  // {
  //   name: "USDC-SAUCE",
  //   vaultAddress: "0x0171baa37fC9f56c98bD56FEB32bC28342944C6e",
  //   strategyAddress: "0xDC74aC010A60357A89008d5eBDBaF144Cf5BD8C6",
  //   positionWidth: 36,
  //   maxTickDev: 60,
  // },
];

const TRY_ANYWAY = false; // Attempt setPositionWidth even when not calm (may revert)

const strategyAbi = [
  "function owner() view returns (address)",
  "function pool() view returns (address)",
  "function isCalm() view returns (bool)",
  "function positionWidth() view returns (int24)",
  "function maxTickDeviation() view returns (int56)",
  "function setPositionWidth(int24 _positionWidth)",
  "function setDeviation(int56 _maxDeviation)",
  "function getMintFee() view returns (uint256)",
];

const vaultAbi = ["function strategy() view returns (address)"];

const univ3PoolAbi = ["function tickSpacing() view returns (int24)"];

function ensureInt(value, name) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer`);
  }
  return n;
}

function loadStrategies() {
  return STRATEGIES.map(entry => ({
    name: entry.name,
    // Support both vaultAddress and strategyAddress
    address: ethers.utils.getAddress(entry.vaultAddress || entry.strategyAddress),
    isVault: !!entry.vaultAddress,
    positionWidth: entry.positionWidth,
    maxTickDeviation: entry.maxTickDeviation,
  }));
}

async function main() {
  if (!Array.isArray(STRATEGIES) || STRATEGIES.length === 0) {
    throw new Error("Configure STRATEGIES array in the script");
  }

  const signer = await ethers.getSigner();
  console.log("Signer:", signer.address);

  const targets = loadStrategies();

  for (const target of targets) {
    const newWidth = ensureInt(target.positionWidth, "positionWidth");
    const newDeviation = ensureInt(target.maxTickDeviation, "maxTickDeviation");
    // const newWidth = null;

    // Explicitly check for null/undefined to prevent any transactions
    if (newWidth === undefined && newDeviation === undefined) {
      console.warn(`\n=== ${target.name} (${target.address}) ===`);
      console.warn("Skipping: both positionWidth and maxTickDeviation are null/undefined");
      continue;
    }

    // Additional safety: ensure we never proceed if ensureInt returned undefined due to null
    if (target.positionWidth === null && newWidth !== undefined) {
      throw new Error(`Internal error: positionWidth was null but ensureInt returned non-undefined value`);
    }
    if (target.maxTickDeviation === null && newDeviation !== undefined) {
      throw new Error(`Internal error: maxTickDeviation was null but ensureInt returned non-undefined value`);
    }

    console.log(`\n=== ${target.name} (${target.address}) ===`);

    // If it's a vault address, get the strategy address from it
    let strategyAddress = target.address;
    if (target.isVault) {
      try {
        const vault = await ethers.getContractAt(vaultAbi, target.address, signer);
        strategyAddress = await vault.strategy();
        console.log(`Vault -> Strategy: ${strategyAddress}`);
      } catch (e) {
        console.error(`Failed to get strategy from vault: ${e.message}`);
        continue;
      }
    }

    const strategy = await ethers.getContractAt(strategyAbi, strategyAddress, signer);

    let owner, poolAddr, currWidth, currDeviation;
    try {
      [owner, poolAddr, currWidth] = await Promise.all([strategy.owner(), strategy.pool(), strategy.positionWidth()]);
    } catch (e) {
      console.error(`Failed to read basic strategy info: ${e.message}`);
      continue;
    }

    try {
      currDeviation = await strategy.maxTickDeviation();
    } catch (e) {
      console.warn(`Could not read maxTickDeviation(): ${e.message}`);
      currDeviation = null;
    }

    console.log("Owner:", owner);
    console.log("Pool:", poolAddr);
    console.log("Current positionWidth:", currWidth.toString());
    if (currDeviation !== null) {
      console.log("Current maxTickDeviation:", currDeviation.toString());
    } else {
      console.log("Current maxTickDeviation: unavailable");
    }

    let tickSpacing;
    try {
      const pool = await ethers.getContractAt(univ3PoolAbi, poolAddr);
      tickSpacing = await pool.tickSpacing();
      console.log("Pool tickSpacing:", tickSpacing.toString());
    } catch (e) {
      console.warn("Could not read pool.tickSpacing():", e.message);
    }

    if (newDeviation !== undefined && newDeviation !== null) {
      // Double-check: never send transaction if value was null
      if (target.maxTickDeviation === null) {
        throw new Error("Safety check failed: maxTickDeviation is null, transaction should not be sent");
      }

      let desiredDeviation = newDeviation;
      if (tickSpacing !== undefined) {
        const maxAllowed = Number(tickSpacing) * 4 - 1; // must be < 4 * tickSpacing
        if (desiredDeviation >= Number(tickSpacing) * 4) {
          console.warn(`Requested deviation ${desiredDeviation} >= 4*tickSpacing; clamping to ${maxAllowed}`);
          desiredDeviation = maxAllowed;
        }
      }

      if (currDeviation === null || desiredDeviation.toString() !== currDeviation.toString()) {
        console.log("Setting maxTickDeviation to:", desiredDeviation);
        let tx = await strategy.setDeviation(desiredDeviation, { gasLimit: 1_000_000 });
        const receipt = await tx.wait();
        if (receipt.status !== 1) throw new Error("setDeviation failed");
        console.log("setDeviation tx:", receipt.transactionHash);
      } else {
        console.log("maxTickDeviation already set; skipping");
      }
    }

    if (newWidth !== undefined && newWidth !== null) {
      // Double-check: never send transaction if value was null
      if (target.positionWidth === null) {
        throw new Error("Safety check failed: positionWidth is null, transaction should not be sent");
      }

      let isCalm = null;
      try {
        isCalm = await strategy.isCalm();
        console.log("isCalm:", isCalm);
      } catch (e) {
        console.warn(`Could not read isCalm(): ${e.message}`);
      }

      if (isCalm === false && !TRY_ANYWAY) {
        console.warn("Not calm; skipping setPositionWidth. Set TRY_ANYWAY=true to attempt (may revert).");
      } else {
        if (newWidth.toString() !== currWidth.toString()) {
          console.log("Setting positionWidth to:", newWidth);
          const hbarRequired = await strategy.getMintFee();
          console.log("HBAR required for mint fee (wei):", hbarRequired.toString());
          const fundTx = await signer.sendTransaction({
            to: strategyAddress,
            value: BigNumber.from((2 * hbarRequired * 10 ** 10).toString()),
          });
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
