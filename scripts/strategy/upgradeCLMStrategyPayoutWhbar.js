const hardhat = require("hardhat");
const { upgrades } = require("hardhat");

/**
 * Upgrade a SaucerSwapLariRewardsCLMStrategy proxy and enable payoutWhbar.
 *
 * Why: BonzoVaultConcLiq clone vaults can no longer receive the WHBAR contract's 2300-gas HBAR push
 * (Hedera v0.77, mainnet 2026-09-29), so every withdraw on WHBAR vaults reverts with WHBARUnwrapFailed.
 * With payoutWhbar set, strategy.native() reports address(0) and the vault pays users WHBAR tokens instead.
 * The strategy's internal native token (nativeToken) is untouched: mint fees, fee routing and LARI swaps keep working.
 *
 * Storage layout: `native` is renamed to `nativeToken` (annotated @custom:oz-renamed-from) and `payoutWhbar`
 * is appended. Validated with upgrades.validateUpgrade(HEAD source -> new source) on 2026-10-21, and the live
 * implementation 0x0832BBe8... was byte-for-byte HEAD source. The live proxy is not in .openzeppelin, so this
 * script validates the implementation standalone, and registers the proxy with forceImport after the upgrade.
 *
 * Who signs: the ProxyAdmin owner and the strategy owner are the same account (0x512c307B... on mainnet).
 *   - If the configured signer is that account, the script does everything.
 *   - Otherwise it deploys the implementation (anyone may pay) and prints the two transactions the owner must send.
 *
 * Usage:
 *   CHAIN_TYPE=mainnet PROXY_ADDRESS=0x157EB9ba35d70560D44394206D4a03885C33c6d5 DRY_RUN=1 \
 *     npx hardhat run scripts/strategy/upgradeCLMStrategyPayoutWhbar.js --network hedera_mainnet
 *   CHAIN_TYPE=mainnet PROXY_ADDRESS=0x... npx hardhat run scripts/strategy/upgradeCLMStrategyPayoutWhbar.js --network hedera_mainnet
 *   CHAIN_TYPE=mainnet PROXY_ADDRESS=0x... VERIFY_ONLY=1 npx hardhat run ... (after the owner sent the transactions)
 *
 * Env:
 *   PROXY_ADDRESS   strategy proxy to upgrade (required)
 *   DRY_RUN=1       read state and validate only, no transactions
 *   VERIFY_ONLY=1   just read and check post-upgrade state
 *   PAYOUT_WHBAR    "false" to skip enabling the flag (default: enable)
 *   CLM_LIB / LARI_LIB  library addresses to link (default: the libraries the live mainnet implementation uses)
 */

const ethers = hardhat.ethers;
const CHAIN_TYPE = process.env.CHAIN_TYPE;
const PROXY_ADDRESS = process.env.PROXY_ADDRESS;
const DRY_RUN = ["1", "true"].includes(String(process.env.DRY_RUN));
const VERIFY_ONLY = ["1", "true"].includes(String(process.env.VERIFY_ONLY));
const ENABLE_FLAG = (process.env.PAYOUT_WHBAR || "true").toLowerCase() !== "false";

// Libraries linked by the live mainnet implementation (0.0.10219279 / 0.0.10219280). Stateless, safe to reuse.
const MAINNET_LIBS = {
  SaucerSwapCLMLib: "0xb1d06ec3e222779fae857ce89e39ca5eddbdbf26",
  SaucerSwapLariLib: "0x27d7a34af229538fe3241ae0d6c7100fc26817c9",
};

const PROXY_ADMIN_ABI = [
  "function owner() view returns (address)",
  "function upgrade(address proxy, address implementation)",
  "function getProxyImplementation(address proxy) view returns (address)",
];

async function readState(strategy) {
  return {
    pool: await strategy.pool(),
    vault: await strategy.vault(),
    lpToken0: await strategy.lpToken0(),
    lpToken1: await strategy.lpToken1(),
    nativeReported: await strategy.native(),
    owner: await strategy.owner(),
    positionWidth: (await strategy.positionWidth()).toString(),
    lockDuration: (await strategy.lockDuration()).toString(),
    rewardTokensLength: (await strategy.getRewardTokensLength()).toString(),
  };
}

function same(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

async function main() {
  if (!PROXY_ADDRESS || !ethers.utils.isAddress(PROXY_ADDRESS)) throw new Error("PROXY_ADDRESS env var is required");
  if (CHAIN_TYPE !== "mainnet" && CHAIN_TYPE !== "testnet") throw new Error("CHAIN_TYPE must be mainnet or testnet");
  await hardhat.run("compile");

  const signer = await ethers.getSigner();
  console.log("Signer:", signer.address, "| chain:", CHAIN_TYPE, "| dry run:", DRY_RUN, "| verify only:", VERIFY_ONLY);
  console.log("Proxy:", PROXY_ADDRESS);

  const currentImpl = await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);
  const adminAddress = await upgrades.erc1967.getAdminAddress(PROXY_ADDRESS);
  const proxyAdmin = new ethers.Contract(adminAddress, PROXY_ADMIN_ABI, signer);
  const adminOwner = await proxyAdmin.owner();
  console.log("Current implementation:", currentImpl);
  console.log("ProxyAdmin:", adminAddress, "| owner:", adminOwner);

  const strategy = await ethers.getContractAt("SaucerSwapLariRewardsCLMStrategy", PROXY_ADDRESS);
  const before = await readState(strategy);
  console.log("State:", before);

  if (VERIFY_ONLY) {
    const flag = await strategy.payoutWhbar();
    const internalNative = await strategy.nativeToken();
    console.log("payoutWhbar:", flag, "| nativeToken:", internalNative, "| native():", before.nativeReported);
    if (flag && before.nativeReported !== ethers.constants.AddressZero) throw new Error("native() should be address(0)");
    if (!same(internalNative, before.lpToken0) && !same(internalNative, before.lpToken1)) console.warn("⚠️  nativeToken is not an LP token of this pool");
    console.log("✅ Verified");
    return;
  }

  const libs = {
    SaucerSwapCLMLib: process.env.CLM_LIB || (CHAIN_TYPE === "mainnet" ? MAINNET_LIBS.SaucerSwapCLMLib : null),
    SaucerSwapLariLib: process.env.LARI_LIB || (CHAIN_TYPE === "mainnet" ? MAINNET_LIBS.SaucerSwapLariLib : null),
  };
  if (!libs.SaucerSwapCLMLib || !libs.SaucerSwapLariLib) throw new Error("Set CLM_LIB and LARI_LIB for this chain");
  console.log("Linking libraries:", libs);

  const Factory = await ethers.getContractFactory("SaucerSwapLariRewardsCLMStrategy", { libraries: libs });

  console.log("\nValidating new implementation (standalone upgrade-safety checks)...");
  await upgrades.validateImplementation(Factory, { unsafeAllowLinkedLibraries: true, kind: "transparent" });
  console.log("✅ Implementation passes upgrade-safety checks");

  const signerIsOwner = same(signer.address, adminOwner) && same(signer.address, before.owner);
  console.log(signerIsOwner ? "Signer is ProxyAdmin owner and strategy owner." : `Signer is NOT the owner (${adminOwner}); will prepare transactions for the owner.`);

  if (DRY_RUN) {
    console.log("\nDry run complete. No transactions sent.");
    return;
  }

  console.log("\nDeploying new implementation...");
  const newImpl = await upgrades.deployImplementation(Factory, {
    unsafeAllowLinkedLibraries: true,
    kind: "transparent",
    txOverrides: { gasLimit: 4000000 },
  });
  console.log("✅ New implementation:", newImpl);

  const upgradeData = proxyAdmin.interface.encodeFunctionData("upgrade", [PROXY_ADDRESS, newImpl]);
  const flagData = strategy.interface.encodeFunctionData("setPayoutWhbar", [true]);

  if (!signerIsOwner) {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  OWNER ACTION REQUIRED — send these from", adminOwner);
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log("1) Upgrade proxy");
    console.log("   to:  ", adminAddress, "(ProxyAdmin)");
    console.log("   data:", upgradeData);
    console.log("   gas:  ~1,000,000");
    if (ENABLE_FLAG) {
      console.log("2) Enable WHBAR payout");
      console.log("   to:  ", PROXY_ADDRESS, "(strategy)");
      console.log("   data:", flagData);
      console.log("   gas:  ~300,000");
    }
    console.log("\nAfter both confirm, run again with VERIFY_ONLY=1.");
    console.log("Then register the proxy locally: upgrades.forceImport(PROXY_ADDRESS, Factory, {kind:'transparent'}) — or just run this script's verify mode, it does that.");
    await upgrades.forceImport(PROXY_ADDRESS, Factory, { kind: "transparent" }).catch(() => {});
    return;
  }

  console.log("\nUpgrading proxy via ProxyAdmin...");
  await (await proxyAdmin.upgrade(PROXY_ADDRESS, newImpl, { gasLimit: 1000000 })).wait();
  const liveImpl = await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS);
  if (!same(liveImpl, newImpl)) throw new Error(`Upgrade did not take effect: ${liveImpl}`);
  console.log("✅ Proxy now points to", liveImpl);

  if (ENABLE_FLAG) {
    console.log("Enabling payoutWhbar...");
    await (await strategy.setPayoutWhbar(true, { gasLimit: 300000 })).wait();
    console.log("✅ payoutWhbar enabled");
  }

  await upgrades.forceImport(PROXY_ADDRESS, Factory, { kind: "transparent" }).catch(e => console.warn("forceImport skipped:", e.message));

  const after = await readState(strategy);
  const internalNative = await strategy.nativeToken();
  console.log("State after:", { ...after, nativeToken: internalNative, payoutWhbar: await strategy.payoutWhbar() });
  const preserved = ["pool", "vault", "lpToken0", "lpToken1", "owner", "positionWidth", "lockDuration", "rewardTokensLength"].every(k => same(before[k], after[k]))
    && same(before.nativeReported, internalNative);
  if (!preserved) throw new Error("State verification failed, inspect before/after above");
  if (ENABLE_FLAG && after.nativeReported !== ethers.constants.AddressZero) throw new Error("native() should report address(0)");
  console.log("✅ State preserved. Vault now pays WHBAR on withdraw:", ENABLE_FLAG);
  console.log("Next: do a small withdraw from the vault, and tell the frontend payouts are WHBAR.");
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("\n❌ FAILED:", e);
    process.exit(1);
  });
