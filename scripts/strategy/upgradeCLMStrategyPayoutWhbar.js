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
 * is appended. Validated with upgrades.validateUpgrade(master source -> this source) on 2026-10-21. The live
 * mainnet implementation (0x0832BBe8...) is byte-for-byte the master build linked with MAINNET_LIBS; its runtime
 * code hash is pinned in VALIDATED_CURRENT_IMPL_CODEHASH. The live proxy is not in .openzeppelin, so this script
 * refuses to upgrade any implementation whose code hash differs from the one the layout comparison was done against,
 * then validates the new implementation standalone. The proxy is registered with forceImport only once it points at
 * the new implementation (owner path: right after the upgrade; non-owner path: in VERIFY_ONLY).
 *
 * Who signs: the ProxyAdmin owner and the strategy owner are the same account (0x512c307B... on mainnet).
 *   - If the configured signer is that account, the script does everything.
 *   - Otherwise it deploys the implementation (anyone may pay) and prints the two transactions the owner must send.
 *
 * Usage:
 *   CHAIN_TYPE=mainnet PROXY_ADDRESS=0x157EB9ba35d70560D44394206D4a03885C33c6d5 DRY_RUN=1 \
 *     npx hardhat run scripts/strategy/upgradeCLMStrategyPayoutWhbar.js --network hedera_mainnet
 *   CHAIN_TYPE=mainnet PROXY_ADDRESS=0x... npx hardhat run scripts/strategy/upgradeCLMStrategyPayoutWhbar.js --network hedera_mainnet
 *   CHAIN_TYPE=mainnet PROXY_ADDRESS=0x... NEW_IMPL=0x... VERIFY_ONLY=1 npx hardhat run ... (after the owner sent the transactions)
 *
 * Env:
 *   PROXY_ADDRESS   strategy proxy to upgrade (required)
 *   DRY_RUN=1       read state, check the current implementation, validate and estimate gas; no transactions
 *   VERIFY_ONLY=1   check post-upgrade state against NEW_IMPL and PAYOUT_WHBAR, then register the proxy locally
 *   NEW_IMPL        implementation address printed by the deploy run (required with VERIFY_ONLY)
 *   PAYOUT_WHBAR    "false" to skip enabling the flag (default: enable); VERIFY_ONLY asserts this exact state
 *   EXPECTED_NATIVE_TOKEN  token nativeToken must equal (default: mainnet WHBAR)
 *   CURRENT_IMPL_CODEHASH  override the pinned code hash of the implementation the layout was validated against
 *   DEPLOY_GAS_LIMIT       override the estimated implementation deployment gas limit
 *   CLM_LIB / LARI_LIB     library addresses to link (default: the libraries the live mainnet implementation uses)
 */

const ethers = hardhat.ethers;
const CHAIN_TYPE = process.env.CHAIN_TYPE;
const PROXY_ADDRESS = process.env.PROXY_ADDRESS;
const DRY_RUN = ["1", "true"].includes(String(process.env.DRY_RUN));
const VERIFY_ONLY = ["1", "true"].includes(String(process.env.VERIFY_ONLY));
const ENABLE_FLAG = (process.env.PAYOUT_WHBAR || "true").toLowerCase() !== "false";
const NEW_IMPL = process.env.NEW_IMPL;

// Libraries linked by the live mainnet implementation (0.0.10219279 / 0.0.10219280). Stateless, safe to reuse.
const MAINNET_LIBS = {
  SaucerSwapCLMLib: "0xb1d06ec3e222779fae857ce89e39ca5eddbdbf26",
  SaucerSwapLariLib: "0x27d7a34af229538fe3241ae0d6c7100fc26817c9",
};
const MAINNET_WHBAR = "0x0000000000000000000000000000000000163B5a";

// keccak256 of the runtime code at 0x0832bbe80c0ebc0be32a1d1d8b07b6ef428496d5 (mainnet), the implementation the
// master -> this-branch storage layout comparison was validated against on 2026-10-21.
const VALIDATED_CURRENT_IMPL_CODEHASH = {
  mainnet: "0x615323eddb24d6f409ad9da8909de559a5a6358cba4f8c3c8408028a9fd50ad5",
};

// Hedera caps a transaction at 15M gas and charges at least 80% of the limit, so keep the buffer modest.
const HEDERA_MAX_TX_GAS = 15_000_000;
const DEPLOY_GAS_BUFFER_PCT = 25;

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

async function codeHashAt(address) {
  return ethers.utils.keccak256(await ethers.provider.getCode(address));
}

/** Runtime bytecode of the local build with the given libraries linked, so on-chain code can be compared to it. */
async function linkedRuntimeBytecode(libs) {
  const artifact = await hardhat.artifacts.readArtifact("SaucerSwapLariRewardsCLMStrategy");
  let hex = artifact.deployedBytecode.slice(2);
  for (const refsByName of Object.values(artifact.deployedLinkReferences)) {
    for (const [name, refs] of Object.entries(refsByName)) {
      if (!libs[name]) throw new Error(`No address for linked library ${name}`);
      const addr = libs[name].slice(2).toLowerCase();
      for (const { start, length } of refs) hex = hex.slice(0, start * 2) + addr + hex.slice((start + length) * 2);
    }
  }
  return "0x" + hex;
}

async function estimateDeployGas(signer, Factory) {
  if (process.env.DEPLOY_GAS_LIMIT) return ethers.BigNumber.from(process.env.DEPLOY_GAS_LIMIT);
  const estimate = await signer.estimateGas(Factory.getDeployTransaction());
  const limit = estimate.mul(100 + DEPLOY_GAS_BUFFER_PCT).div(100);
  if (limit.gt(HEDERA_MAX_TX_GAS)) throw new Error(`Deployment needs ${limit} gas, above Hedera's ${HEDERA_MAX_TX_GAS} per-transaction cap`);
  console.log(`Implementation deploy gas: estimate ${estimate}, limit ${limit} (+${DEPLOY_GAS_BUFFER_PCT}%)`);
  return limit;
}

async function registerProxy(Factory) {
  console.log("Registering proxy in .openzeppelin with forceImport...");
  await upgrades.forceImport(PROXY_ADDRESS, Factory, { kind: "transparent" });
  console.log("✅ Proxy registered");
}

async function main() {
  if (!PROXY_ADDRESS || !ethers.utils.isAddress(PROXY_ADDRESS)) throw new Error("PROXY_ADDRESS env var is required");
  if (CHAIN_TYPE !== "mainnet" && CHAIN_TYPE !== "testnet") throw new Error("CHAIN_TYPE must be mainnet or testnet");
  if (VERIFY_ONLY && (!NEW_IMPL || !ethers.utils.isAddress(NEW_IMPL))) throw new Error("NEW_IMPL env var (the deployed implementation) is required with VERIFY_ONLY");
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

  const libs = {
    SaucerSwapCLMLib: process.env.CLM_LIB || (CHAIN_TYPE === "mainnet" ? MAINNET_LIBS.SaucerSwapCLMLib : null),
    SaucerSwapLariLib: process.env.LARI_LIB || (CHAIN_TYPE === "mainnet" ? MAINNET_LIBS.SaucerSwapLariLib : null),
  };
  if (!libs.SaucerSwapCLMLib || !libs.SaucerSwapLariLib) throw new Error("Set CLM_LIB and LARI_LIB for this chain");
  console.log("Linking libraries:", libs);
  const Factory = await ethers.getContractFactory("SaucerSwapLariRewardsCLMStrategy", { libraries: libs });

  const expectedNativeToken = process.env.EXPECTED_NATIVE_TOKEN || (CHAIN_TYPE === "mainnet" ? MAINNET_WHBAR : null);

  if (VERIFY_ONLY) {
    const flag = await strategy.payoutWhbar();
    const internalNative = await strategy.nativeToken();
    console.log("payoutWhbar:", flag, "| nativeToken:", internalNative, "| native():", before.nativeReported);

    if (!same(currentImpl, NEW_IMPL)) throw new Error(`Proxy points at ${currentImpl}, expected NEW_IMPL ${NEW_IMPL}: the owner has not upgraded yet`);
    const liveHash = await codeHashAt(currentImpl);
    const localHash = ethers.utils.keccak256(await linkedRuntimeBytecode(libs));
    if (liveHash !== localHash) throw new Error(`Live implementation code hash ${liveHash} does not match this build ${localHash}`);
    console.log("✅ Proxy points at NEW_IMPL and its code matches this build");

    if (flag !== ENABLE_FLAG) throw new Error(`payoutWhbar is ${flag}, expected ${ENABLE_FLAG}: the owner has not sent the setPayoutWhbar transaction`);
    if (flag && before.nativeReported !== ethers.constants.AddressZero) throw new Error("native() should be address(0) while payoutWhbar is set");
    if (!flag && !same(before.nativeReported, internalNative)) throw new Error("native() should equal nativeToken while payoutWhbar is unset");
    if (!expectedNativeToken) throw new Error("Set EXPECTED_NATIVE_TOKEN for this chain");
    if (!same(internalNative, expectedNativeToken)) throw new Error(`nativeToken is ${internalNative}, expected ${expectedNativeToken}`);
    if (!same(internalNative, before.lpToken0) && !same(internalNative, before.lpToken1)) throw new Error("nativeToken is not an LP token of this pool");
    console.log("✅ payoutWhbar, native() and nativeToken are as expected");

    await registerProxy(Factory);
    console.log("✅ Verified");
    return;
  }

  console.log("\nChecking the current implementation is the one the storage layout was validated against...");
  const expectedCurrentHash = process.env.CURRENT_IMPL_CODEHASH || VALIDATED_CURRENT_IMPL_CODEHASH[CHAIN_TYPE];
  if (!expectedCurrentHash) throw new Error("No validated code hash for this chain: run upgrades.validateUpgrade against the live implementation and set CURRENT_IMPL_CODEHASH");
  const currentHash = await codeHashAt(currentImpl);
  if (currentHash !== expectedCurrentHash) {
    throw new Error(`Current implementation code hash ${currentHash} differs from the validated ${expectedCurrentHash}. ` +
      "Re-run upgrades.validateUpgrade(<live source>, <this source>) and update the pinned hash before upgrading.");
  }
  console.log("✅ Current implementation matches the validated code hash");

  console.log("\nValidating new implementation (standalone upgrade-safety checks)...");
  await upgrades.validateImplementation(Factory, { unsafeAllowLinkedLibraries: true, kind: "transparent" });
  console.log("✅ Implementation passes upgrade-safety checks");

  const deployGasLimit = await estimateDeployGas(signer, Factory);

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
    txOverrides: { gasLimit: deployGasLimit },
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
    console.log(`\nAfter both confirm, run again with VERIFY_ONLY=1 NEW_IMPL=${newImpl}.`);
    console.log("Verify mode checks the upgrade and then registers the proxy in .openzeppelin; nothing is imported until then.");
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

  await registerProxy(Factory);

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
