/*
  CLM Strategy Simulator
  - Runs with Hardhat runtime: npx hardhat run scripts/simulateCLM.js --network hedera_mainnet
  - Simulates Bonzo/Beefy CLM vaults and their strategies against live SaucerSwap pools
  - Uses the deployed Hedera mainnet vault set (Bonzo-XBONZO, Sauce-XSAUCE, USDC-HBAR, USDC-SAUCE)
  - Optional environment overrides:
      POSITION_WIDTH   use this width multiplier instead of the strategy value
      TWAP_INTERVAL    use this TWAP interval (seconds) instead of the strategy value
      MAX_TICK_DEV     use this tick deviation threshold instead of the strategy value
*/

const hardhat = require("hardhat");
const { ethers, artifacts } = hardhat;
// Static Hedera token metadata to avoid on-chain ERC20 queries
const DEFAULT_DECIMALS = 8;
const TOKEN_METADATA = {
  "0x000000000000000000000000000000000006f89a": { symbol: "USDC", decimals: 6 },
  "0x00000000000000000000000000000000000b2ad5": { symbol: "SAUCE", decimals: 6 },
  "0x00000000000000000000000000000000001647e8": { symbol: "XSAUCE", decimals: 6 },
  "0x00000000000000000000000000000000007e545e": { symbol: "BONZO", decimals: 8 },
  "0x0000000000000000000000000000000000818e2d": { symbol: "XBONZO", decimals: 8 },
  "0x0000000000000000000000000000000000163b5a": { symbol: "WHBAR", decimals: 8 },
};

function parseOptionalInt(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const DEFAULTS = {
  POSITION_WIDTH: parseOptionalInt(process.env.POSITION_WIDTH) ?? 10,
  TWAP_INTERVAL: parseOptionalInt(process.env.TWAP_INTERVAL) ?? 120,
  MAX_TICK_DEV: parseOptionalInt(process.env.MAX_TICK_DEV) ?? 10,
};

const CLM_VAULTS = [
  {
    name: "BONZO-XBONZO",
    vaultAddress: "0x36d6c6bAD8cdCE5e58e1d1874A84F5c79B5ACA57",
    strategyAddress: "0xc4e5FCb9FBb10f183d6c884585114575ea2bC881",
    positionWidth: 8,
    maxTickDev: 8,
  },
  {
    name: "SAUCE-XSAUCE",
    vaultAddress: "0xD997f0121885cD9487ad0513fCF85d672d52FFad",
    strategyAddress: "0xc27FCfb8bE2b594BDbA97DbA9d0b1Aa4665e100c",
    positionWidth: 6,
    maxTickDev: 6,
  },
  {
    name: "USDC-HBAR",
    vaultAddress: "0x8AE6416623eDEC4b6050C24935f4670671ef31Cf",
    strategyAddress: "0x6017f4c1fe6ba9bd1979c91cd21fc5f52d88b8fc",
    positionWidth: 9,
    maxTickDev: 9,
  },
  {
    name: "USDC-SAUCE",
    vaultAddress: "0x5b1DFeaF4e79Eb6B2FF1Ea053E5592D0f61506b1",
    strategyAddress: "0x0B165c2276e46b94ff62a6551B3befB7cB3f8d00",
    positionWidth: 9,
    maxTickDev: 9,
  },
];

function loadTargets() {
  return CLM_VAULTS.map(entry => ({
    name: entry.name,
    address: ethers.utils.getAddress(entry.vaultAddress),
    strategy: ethers.utils.getAddress(entry.strategyAddress),
    positionWidth: entry.positionWidth,
    maxTickDev: entry.maxTickDev,
  }));
}

// ---------- BigInt math helpers (mirror contract math) ----------
const ONE_E18 = 10n ** 18n;
const Q96 = 2n ** 96n;

function mulDiv(a, b, denom) {
  return (a * b) / denom;
}

function bnToBigInt(value) {
  if (typeof value === "bigint") return value;
  return BigInt(value.toString());
}

function asNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}

function adjustPriceForDecimals(priceX18, decimals0, decimals1) {
  if (decimals0 === decimals1) return priceX18;
  const diff = BigInt(Math.abs(decimals0 - decimals1));
  if (diff === 0n) return priceX18;
  const factor = 10n ** diff;
  return decimals0 > decimals1 ? priceX18 * factor : priceX18 / factor;
}

function toSignedNumber(value, bits) {
  const unsigned = asNumber(value);
  const max = Math.pow(2, bits);
  const half = max / 2;
  return unsigned >= half ? unsigned - max : unsigned;
}

// Uniswap V3 TickMath.getSqrtRatioAtTick (ported verbatim to BigInt)
function getSqrtRatioAtTick(tick) {
  const MIN_TICK = -887272;
  const MAX_TICK = 887272;
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error("Tick out of range");

  let absTick = tick < 0 ? BigInt(-tick) : BigInt(tick);

  let ratio = (absTick & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = (1n << 256n) / ratio; // invert for positive ticks

  // Q128.128 -> Q128.96, rounded up like Solidity
  const shifted = ratio >> 32n;
  const hasRemainder = (ratio & ((1n << 32n) - 1n)) !== 0n;
  const sqrtPriceX96 = shifted + (hasRemainder ? 1n : 0n);
  return sqrtPriceX96;
}

function priceX18FromSqrtPriceX96(sqrtPriceX96, decimals0, decimals1) {
  // scaled = sqrtPriceX96 * 1e18 / 2^96
  const scaled = mulDiv(BigInt(sqrtPriceX96.toString()), ONE_E18, Q96);
  // priceX18 = scaled^2 / 1e18
  const price = mulDiv(scaled, scaled, ONE_E18);
  return adjustPriceForDecimals(price, decimals0, decimals1);
}

function priceX18AtTick(tick, decimals0, decimals1) {
  const sqrt = getSqrtRatioAtTick(tick);
  return priceX18FromSqrtPriceX96(sqrt, decimals0, decimals1);
}

// Tick rounding like TickUtils.floor and baseTicks
function floorTick(tick, tickSpacing) {
  const t = Number(tick);
  const s = Number(tickSpacing);
  let compressed = Math.trunc(t / s);
  if (t < 0 && t % s !== 0) compressed--;
  return compressed * s;
}

function baseTicks(currentTick, baseThreshold, tickSpacing) {
  const tickFloor = floorTick(currentTick, tickSpacing);
  const lower = tickFloor - baseThreshold;
  const upper = tickFloor + baseThreshold;
  return [lower, upper];
}

function setMainTick(currentTick, tickSpacing, width) {
  return baseTicks(currentTick, width, tickSpacing);
}

function setAltTick(currentTick, tickSpacing, width, bal0 = 0n, bal1 = 0n, poolPriceX18 = 0n) {
  // amount0 in terms of token1: amount0 * price
  const amount0Val = bal0 > 0n ? (bal0 * poolPriceX18) / ONE_E18 : 0n;
  const [lowerW, upperW] = baseTicks(currentTick, width, tickSpacing);
  const [lowerD, upperD] = baseTicks(currentTick, tickSpacing, tickSpacing); // distance=spacing

  if (amount0Val < bal1) {
    // more token1 -> skew to token0 side (below price)
    return [lowerW, lowerD];
  } else if (bal1 < amount0Val) {
    // more token0 -> skew to token1 side (above price)
    return [upperD, upperW];
  } else {
    // default/equal -> token0 side (above price)
    return [upperD, upperW];
  }
}

function formatFixed(x, decimals = 18, digits = 6) {
  const n = BigInt(x.toString());
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  let frac = (n % base).toString().padStart(decimals, "0");
  if (digits < decimals) frac = frac.slice(0, digits);
  // trim trailing zeros
  frac = frac.replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : `${whole}`;
}

async function getTwapTick(pool, intervalSec) {
  try {
    const secondsAgos = [intervalSec, 0];
    const res = await pool.observe(secondsAgos);
    const tickCumulatives = res.tickCumulatives || res[0];
    const delta = tickCumulatives[1].sub(tickCumulatives[0]);
    // ethers BigNumber supports negative toNumber when within JS safe range
    return Math.trunc(delta.toNumber() / intervalSec);
  } catch (e) {
    return null;
  }
}

async function simulateVault(target) {
  const vault = await getReadOnlyContract(target.address, "BonzoVaultConcLiq");

  const [vaultName, vaultSymbol, shareDecimals, totalSupplyBN, strategyAddr] = await Promise.all([
    vault.name(),
    vault.symbol(),
    vault.decimals ? vault.decimals() : Promise.resolve(18),
    vault.totalSupply(),
    vault.strategy(),
  ]);

  if (target.strategy && target.strategy.toLowerCase() !== strategyAddr.toLowerCase()) {
    console.warn(
      `Warning: expected strategy ${target.strategy} for ${target.name}, but vault points to ${strategyAddr}`
    );
  }

  const strategy = await getReadOnlyContract(strategyAddr, "SaucerSwapLariRewardsCLMStrategy");

  const [
    poolAddress,
    token0Address,
    token1Address,
    positionWidthBN,
    maxTickDeviationBN,
    twapIntervalBN,
    leftover0BN,
    leftover1BN,
    totalLocked0BN,
    totalLocked1BN,
  ] = await Promise.all([
    strategy.pool(),
    strategy.lpToken0(),
    strategy.lpToken1(),
    strategy.positionWidth(),
    strategy.maxTickDeviation(),
    strategy.twapInterval(),
    strategy.leftover0(),
    strategy.leftover1(),
    strategy.totalLocked0(),
    strategy.totalLocked1(),
  ]);

  let strategyIsCalm = null;
  try {
    strategyIsCalm = await strategy.isCalm();
  } catch (_) {
    strategyIsCalm = null;
  }

  const [positionMainRaw, positionAltRaw, balancesOfThisRaw, poolBalancesRaw, totalBalancesRaw] = await Promise.all([
    strategy.positionMain(),
    strategy.positionAlt(),
    strategy.balancesOfThis(),
    strategy.balancesOfPool(),
    strategy.balances(),
  ]);

  const pool = await getReadOnlyContract(
    poolAddress,
    "contracts/BIFI/interfaces/saucerswap/IUniswapV3Pool.sol:IUniswapV3Pool"
  );

  const [tickSpacingRaw, feeRaw, slot0] = await Promise.all([pool.tickSpacing(), pool.fee(), pool.slot0()]);

  const token0MetaBase = TOKEN_METADATA[token0Address.toLowerCase()] ?? {
    symbol: token0Address,
    decimals: DEFAULT_DECIMALS,
  };
  const token1MetaBase = TOKEN_METADATA[token1Address.toLowerCase()] ?? {
    symbol: token1Address,
    decimals: DEFAULT_DECIMALS,
  };
  const token0 = { address: token0Address, symbol: token0MetaBase.symbol, decimals: token0MetaBase.decimals };
  const token1 = { address: token1Address, symbol: token1MetaBase.symbol, decimals: token1MetaBase.decimals };

  const sqrtPriceX96Raw = slot0.sqrtPriceX96 ?? slot0[0];
  const tickRaw = slot0.tick ?? slot0[1];
  const sqrtPriceX96 = BigInt(sqrtPriceX96Raw.toString());
  const currentTick = toSignedNumber(tickRaw, 24);
  const priceX18 = priceX18FromSqrtPriceX96(sqrtPriceX96, token0.decimals, token1.decimals);

  const tickSpacing = typeof tickSpacingRaw === "number" ? tickSpacingRaw : tickSpacingRaw.toNumber();
  const fee = typeof feeRaw === "number" ? feeRaw : feeRaw.toNumber();

  const actualConfig = {
    positionWidth: asNumber(positionWidthBN),
    maxTickDeviation: toSignedNumber(maxTickDeviationBN, 56),
    twapInterval: asNumber(twapIntervalBN),
  };

  const simulationConfig = {
    positionWidth: target.positionWidth ?? DEFAULTS.POSITION_WIDTH ?? actualConfig.positionWidth,
    maxTickDeviation: target.maxTickDev ?? DEFAULTS.MAX_TICK_DEV ?? actualConfig.maxTickDeviation,
    twapInterval: DEFAULTS.TWAP_INTERVAL ?? actualConfig.twapInterval,
  };

  const actualWidthTicks = actualConfig.positionWidth * tickSpacing;
  const simulatedWidthTicks = simulationConfig.positionWidth * tickSpacing;

  const twapTick =
    simulationConfig.twapInterval && simulationConfig.twapInterval > 0
      ? await getTwapTick(pool, simulationConfig.twapInterval)
      : null;
  const deviation = twapTick === null ? null : Math.abs(currentTick - twapTick);
  const twapCalm = deviation === null ? "N/A" : deviation <= simulationConfig.maxTickDeviation ? "yes" : "no";

  const mainTickLower = toSignedNumber(positionMainRaw.tickLower ?? positionMainRaw[0], 24);
  const mainTickUpper = toSignedNumber(positionMainRaw.tickUpper ?? positionMainRaw[1], 24);
  const altTickLower = toSignedNumber(positionAltRaw.tickLower ?? positionAltRaw[0], 24);
  const altTickUpper = toSignedNumber(positionAltRaw.tickUpper ?? positionAltRaw[1], 24);

  const [suggestedMainLower, suggestedMainUpper] = setMainTick(currentTick, tickSpacing, simulatedWidthTicks);

  const contractToken0Bal = bnToBigInt(balancesOfThisRaw.token0Bal ?? balancesOfThisRaw[0]);
  const contractToken1Bal = bnToBigInt(balancesOfThisRaw.token1Bal ?? balancesOfThisRaw[1]);

  const [suggestedAltLower, suggestedAltUpper] = setAltTick(
    currentTick,
    tickSpacing,
    simulatedWidthTicks,
    contractToken0Bal,
    contractToken1Bal,
    priceX18
  );

  const positions = {
    main: {
      current: {
        tickLower: mainTickLower,
        tickUpper: mainTickUpper,
        lowerPriceX18: priceX18AtTick(mainTickLower, token0.decimals, token1.decimals),
        upperPriceX18: priceX18AtTick(mainTickUpper, token0.decimals, token1.decimals),
      },
      suggested: {
        tickLower: suggestedMainLower,
        tickUpper: suggestedMainUpper,
        lowerPriceX18: priceX18AtTick(suggestedMainLower, token0.decimals, token1.decimals),
        upperPriceX18: priceX18AtTick(suggestedMainUpper, token0.decimals, token1.decimals),
      },
    },
    alt: {
      current: {
        tickLower: altTickLower,
        tickUpper: altTickUpper,
        lowerPriceX18: priceX18AtTick(altTickLower, token0.decimals, token1.decimals),
        upperPriceX18: priceX18AtTick(altTickUpper, token0.decimals, token1.decimals),
      },
      suggested: {
        tickLower: suggestedAltLower,
        tickUpper: suggestedAltUpper,
        lowerPriceX18: priceX18AtTick(suggestedAltLower, token0.decimals, token1.decimals),
        upperPriceX18: priceX18AtTick(suggestedAltUpper, token0.decimals, token1.decimals),
      },
    },
  };

  const poolBalances = {
    token0: bnToBigInt(poolBalancesRaw.token0Bal ?? poolBalancesRaw[0]),
    token1: bnToBigInt(poolBalancesRaw.token1Bal ?? poolBalancesRaw[1]),
    mainAmount0: bnToBigInt(poolBalancesRaw.mainAmount0 ?? poolBalancesRaw[2]),
    mainAmount1: bnToBigInt(poolBalancesRaw.mainAmount1 ?? poolBalancesRaw[3]),
    altAmount0: bnToBigInt(poolBalancesRaw.altAmount0 ?? poolBalancesRaw[4]),
    altAmount1: bnToBigInt(poolBalancesRaw.altAmount1 ?? poolBalancesRaw[5]),
  };

  const balances = {
    strategy: {
      token0: bnToBigInt(totalBalancesRaw[0]),
      token1: bnToBigInt(totalBalancesRaw[1]),
    },
    contract: {
      token0: contractToken0Bal,
      token1: contractToken1Bal,
    },
    pool: poolBalances,
    leftover: {
      token0: bnToBigInt(leftover0BN),
      token1: bnToBigInt(leftover1BN),
    },
    locked: {
      token0: bnToBigInt(totalLocked0BN),
      token1: bnToBigInt(totalLocked1BN),
    },
  };

  return {
    vault: {
      address: target.address,
      name: vaultName,
      symbol: vaultSymbol,
      decimals: typeof shareDecimals === "number" ? shareDecimals : Number(shareDecimals),
      totalSupply: bnToBigInt(totalSupplyBN),
    },
    strategy: {
      address: strategyAddr,
      pool: poolAddress,
      isCalm: strategyIsCalm,
    },
    config: {
      actual: { ...actualConfig, widthTicks: actualWidthTicks },
      simulation: { ...simulationConfig, widthTicks: simulatedWidthTicks },
    },
    tokens: { token0, token1 },
    pool: {
      address: poolAddress,
      tickSpacing,
      fee,
      sqrtPriceX96,
      currentTick,
      priceX18,
      twap: {
        interval: simulationConfig.twapInterval,
        tick: twapTick,
        deviation,
        isCalm: twapCalm,
      },
    },
    positions,
    balances,
  };
}

function printResult(target, result) {
  const { vault, strategy, config, tokens, pool, positions, balances } = result;
  const header = `${target.name}  ${vault.address}`;
  console.log("\n" + header);
  console.log("-".repeat(header.length));

  console.log(
    `Vault token: ${vault.symbol} (${vault.name}) | totalSupply: ${formatFixed(
      vault.totalSupply,
      vault.decimals,
      6
    )} shares`
  );
  console.log(`Strategy: ${strategy.address}`);
  console.log(`Pool: ${pool.address}`);
  console.log(
    `Tokens: ${tokens.token0.symbol} (${tokens.token0.address}) / ${tokens.token1.symbol} (${tokens.token1.address})`
  );
  const feePercent = (pool.fee / 1e4).toFixed(4);
  console.log(
    `Fee tier: ${feePercent}% | tickSpacing: ${pool.tickSpacing} | on-chain width multiplier: ${config.actual.positionWidth} (${config.actual.widthTicks} ticks each side)`
  );

  if (
    config.simulation.positionWidth !== config.actual.positionWidth ||
    config.simulation.twapInterval !== config.actual.twapInterval ||
    config.simulation.maxTickDeviation !== config.actual.maxTickDeviation
  ) {
    console.log(
      `Simulation overrides -> width=${config.simulation.positionWidth} (${config.simulation.widthTicks} ticks each side), twap=${config.simulation.twapInterval}s, maxDev=${config.simulation.maxTickDeviation}`
    );
  } else {
    console.log(
      `Strategy config -> width=${config.actual.positionWidth}, twap=${config.actual.twapInterval}s, maxDev=${config.actual.maxTickDeviation}`
    );
  }

  console.log(
    `Tick: ${pool.currentTick} | price (${tokens.token1.symbol}/${tokens.token0.symbol}): ${formatFixed(
      pool.priceX18,
      18,
      8
    )}`
  );

  const twapInfo =
    pool.twap.tick === null
      ? "TWAP unavailable"
      : `twap(${pool.twap.interval}s): ${pool.twap.tick} | deviation: ${pool.twap.deviation}`;
  console.log(`${twapInfo} | calm<=${config.simulation.maxTickDeviation}: ${pool.twap.isCalm}`);
  if (strategy.isCalm !== null) {
    console.log(`On-chain calm check: ${strategy.isCalm ? "yes" : "no"}`);
  }

  console.log(
    `Main current ticks: [${positions.main.current.tickLower}, ${
      positions.main.current.tickUpper
    }] -> prices: [${formatFixed(positions.main.current.lowerPriceX18, 18, 6)}, ${formatFixed(
      positions.main.current.upperPriceX18,
      18,
      6
    )}]`
  );
  console.log(
    `Main target  ticks: [${positions.main.suggested.tickLower}, ${
      positions.main.suggested.tickUpper
    }] -> prices: [${formatFixed(positions.main.suggested.lowerPriceX18, 18, 6)}, ${formatFixed(
      positions.main.suggested.upperPriceX18,
      18,
      6
    )}]`
  );
  console.log(
    `Alt  current ticks: [${positions.alt.current.tickLower}, ${
      positions.alt.current.tickUpper
    }] -> prices: [${formatFixed(positions.alt.current.lowerPriceX18, 18, 6)}, ${formatFixed(
      positions.alt.current.upperPriceX18,
      18,
      6
    )}]`
  );
  console.log(
    `Alt  target  ticks: [${positions.alt.suggested.tickLower}, ${
      positions.alt.suggested.tickUpper
    }] -> prices: [${formatFixed(positions.alt.suggested.lowerPriceX18, 18, 6)}, ${formatFixed(
      positions.alt.suggested.upperPriceX18,
      18,
      6
    )}]`
  );

  console.log(
    `Strategy available: ${tokens.token0.symbol} ${formatFixed(
      balances.strategy.token0,
      tokens.token0.decimals,
      6
    )} | ${tokens.token1.symbol} ${formatFixed(balances.strategy.token1, tokens.token1.decimals, 6)}`
  );
  console.log(
    `   Contract balances: ${tokens.token0.symbol} ${formatFixed(
      balances.contract.token0,
      tokens.token0.decimals,
      6
    )} | ${tokens.token1.symbol} ${formatFixed(balances.contract.token1, tokens.token1.decimals, 6)}`
  );
  console.log(
    `   Main position: ${tokens.token0.symbol} ${formatFixed(balances.pool.mainAmount0, tokens.token0.decimals, 6)} | ${
      tokens.token1.symbol
    } ${formatFixed(balances.pool.mainAmount1, tokens.token1.decimals, 6)}`
  );
  console.log(
    `   Alt position : ${tokens.token0.symbol} ${formatFixed(balances.pool.altAmount0, tokens.token0.decimals, 6)} | ${
      tokens.token1.symbol
    } ${formatFixed(balances.pool.altAmount1, tokens.token1.decimals, 6)}`
  );

  if (balances.leftover.token0 > 0n || balances.leftover.token1 > 0n) {
    console.log(
      `   Leftover: ${tokens.token0.symbol} ${formatFixed(balances.leftover.token0, tokens.token0.decimals, 6)} | ${
        tokens.token1.symbol
      } ${formatFixed(balances.leftover.token1, tokens.token1.decimals, 6)}`
    );
  }

  if (balances.locked.token0 > 0n || balances.locked.token1 > 0n) {
    console.log(
      `   Timelocked: ${tokens.token0.symbol} ${formatFixed(balances.locked.token0, tokens.token0.decimals, 6)} | ${
        tokens.token1.symbol
      } ${formatFixed(balances.locked.token1, tokens.token1.decimals, 6)}`
    );
  }
}

async function main() {
  await hardhat.run("compile");
  const targets = loadTargets();

  console.log("CLM Simulation - network:", hardhat.network.name);

  for (const target of targets) {
    try {
      const result = await simulateVault(target);
      printResult(target, result);
    } catch (e) {
      console.error(`\n${target.name}  ${target.address}`);
      console.error("Failed to simulate vault:", e.message);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });

async function getReadOnlyContract(address, artifactName) {
  const artifact = await artifacts.readArtifact(artifactName);
  let signer = undefined;
  try {
    const signers = await ethers.getSigners();
    signer = signers && signers.length > 0 ? signers[0] : undefined;
  } catch (_) {
    signer = undefined;
  }
  const signerOrProvider = signer || ethers.provider;
  return new ethers.Contract(address, artifact.abi, signerOrProvider);
}
