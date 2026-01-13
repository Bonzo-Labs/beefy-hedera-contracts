const hardhat = require("hardhat");
const { ethers } = hardhat;

/**
 * Quick test script for deposit/withdraw functionality
 * for BonzoSAUCELevergedLiqStaking via BonzoVaultV7.
 *
 * Usage:
 * STRATEGY_ADDRESS=0x... VAULT_ADDRESS=0x... AMOUNT=0.1 DO_DEPOSIT=true DO_WITHDRAW=true \
 *   npx hardhat run scripts/strategy/testDepositWithdrawSAUCELeveraged.js --network hedera_testnet
 *
 * Notes:
 * - Deposits are done through the vault (strategy only accepts calls from the vault).
 * - xSAUCE is typically 6 decimals on Hedera (this script reads `strategy.wantTokenDecimals()`).
 */

const DEFAULT_STRATEGY_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_VAULT_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_AMOUNT = "0.1";

function fmtUnits(bn, decimals) {
  return ethers.utils.formatUnits(bn, decimals);
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

async function main() {
  const STRATEGY_ADDRESS = process.env.STRATEGY_ADDRESS || DEFAULT_STRATEGY_ADDRESS;
  const VAULT_ADDRESS = process.env.VAULT_ADDRESS || DEFAULT_VAULT_ADDRESS;
  const AMOUNT = process.env.AMOUNT || DEFAULT_AMOUNT;
  const DO_DEPOSIT = envBool("DO_DEPOSIT", false);
  const DO_WITHDRAW = envBool("DO_WITHDRAW", true);

  if (!STRATEGY_ADDRESS || STRATEGY_ADDRESS === ethers.constants.AddressZero) {
    throw new Error("STRATEGY_ADDRESS is required");
  }
  if (!VAULT_ADDRESS || VAULT_ADDRESS === ethers.constants.AddressZero) {
    throw new Error("VAULT_ADDRESS is required");
  }

  const [user] = await ethers.getSigners();
  console.log("User:", user.address);
  console.log("HBAR balance:", ethers.utils.formatEther(await user.getBalance()), "\n");

  const strategy = await ethers.getContractAt("BonzoSAUCELevergedLiqStaking", STRATEGY_ADDRESS);
  const vault = await ethers.getContractAt("BonzoVaultV7", VAULT_ADDRESS);

  // Token addresses
  const wantAddress = await strategy.want();
  const aTokenAddress = await strategy.aToken();
  const debtTokenAddress = await strategy.debtToken();

  // Token contracts
  const want = await ethers.getContractAt("IERC20Upgradeable", wantAddress);
  const aToken = await ethers.getContractAt("IERC20Upgradeable", aTokenAddress);
  const debtToken = await ethers.getContractAt("IERC20Upgradeable", debtTokenAddress);

  const wantDecimals = Number(await strategy.wantTokenDecimals());

  console.log("Strategy:", strategy.address);
  console.log("Vault:", vault.address);
  console.log("Want (xSAUCE):", wantAddress, `decimals=${wantDecimals}`);
  console.log("aToken:", aTokenAddress);
  console.log("debtToken:", debtTokenAddress, "\n");

  // Sanity: check wiring
  const vaultStrategy = await vault.strategy();
  const stratVault = await strategy.vault();
  console.log("Vault.strategy():", vaultStrategy);
  console.log("Strategy.vault():", stratVault, "\n");

  // BEFORE
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║                         BEFORE                                 ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const userWantBefore = await want.balanceOf(user.address);
  const userSharesBefore = await vault.balanceOf(user.address);
  const vaultWantBefore = await want.balanceOf(vault.address);

  const stratWantBefore = await want.balanceOf(strategy.address);
  const stratATokenBefore = await aToken.balanceOf(strategy.address);
  const stratDebtBefore = await debtToken.balanceOf(strategy.address);
  const stratBalanceBefore = await strategy.balanceOf();

  console.log("User want:", fmtUnits(userWantBefore, wantDecimals));
  console.log("User shares:", ethers.utils.formatEther(userSharesBefore));
  console.log("Vault want:", fmtUnits(vaultWantBefore, wantDecimals));
  console.log("Strategy.balanceOf():", fmtUnits(stratBalanceBefore, wantDecimals));
  console.log("Strategy want:", fmtUnits(stratWantBefore, wantDecimals));
  console.log("Strategy aToken:", fmtUnits(stratATokenBefore, wantDecimals));
  console.log("Strategy debtToken (raw):", stratDebtBefore.toString(), "\n");

  // DEPOSIT
  if (DO_DEPOSIT) {
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║                        DEPOSIT                                 ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");

    const depositAmount = ethers.utils.parseUnits(AMOUNT, wantDecimals);
    console.log("Deposit amount:", AMOUNT, `(raw=${depositAmount.toString()})`);

    if (userWantBefore.lt(depositAmount)) {
      throw new Error(
        `Insufficient want balance. Have ${userWantBefore.toString()} need ${depositAmount.toString()}`
      );
    }

    const allowance = await want.allowance(user.address, vault.address);
    if (allowance.lt(depositAmount)) {
      console.log("Approving vault...");
      const approveTx = await want.approve(vault.address, depositAmount.mul(10), { gasLimit: 1_000_000 });
      await approveTx.wait();
      console.log("✅ Approved\n");
    }

    console.log("Depositing...");
    const depositTx = await vault.deposit(depositAmount, { gasLimit: 6_000_000 });
    const depositReceipt = await depositTx.wait();
    console.log("✅ Deposit tx:", depositReceipt.transactionHash);

    const vaultDepositEvent = depositReceipt.events?.find((e) => e.event === "Deposit");
    if (vaultDepositEvent?.args) {
      console.log("Vault Deposit event:");
      console.log("  user:", vaultDepositEvent.args.user);
      console.log("  token:", vaultDepositEvent.args.token);
      console.log("  amount:", fmtUnits(vaultDepositEvent.args.amount, wantDecimals));
      console.log("  shares:", ethers.utils.formatEther(vaultDepositEvent.args.shares));
    }
    console.log("");

    // AFTER DEPOSIT
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║                      AFTER DEPOSIT                             ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");

    const userWantAfterDep = await want.balanceOf(user.address);
    const userSharesAfterDep = await vault.balanceOf(user.address);
    const vaultWantAfterDep = await want.balanceOf(vault.address);

    const stratWantAfterDep = await want.balanceOf(strategy.address);
    const stratATokenAfterDep = await aToken.balanceOf(strategy.address);
    const stratDebtAfterDep = await debtToken.balanceOf(strategy.address);
    const stratBalanceAfterDep = await strategy.balanceOf();

    console.log("User want:", fmtUnits(userWantAfterDep, wantDecimals));
    console.log("User shares:", ethers.utils.formatEther(userSharesAfterDep));
    console.log("Vault want:", fmtUnits(vaultWantAfterDep, wantDecimals));
    console.log("Strategy.balanceOf():", fmtUnits(stratBalanceAfterDep, wantDecimals));
    console.log("Strategy want:", fmtUnits(stratWantAfterDep, wantDecimals));
    console.log("Strategy aToken:", fmtUnits(stratATokenAfterDep, wantDecimals));
    console.log("Strategy debtToken (raw):", stratDebtAfterDep.toString(), "\n");
  }

  // WITHDRAW
  if (DO_WITHDRAW) {
    console.log("╔════════════════════════════════════════════════════════════════╗");
    console.log("║                        WITHDRAW                                ║");
    console.log("╚════════════════════════════════════════════════════════════════╝");

    const shares = await vault.balanceOf(user.address);
    console.log("User shares:", ethers.utils.formatEther(shares));
    if (shares.eq(0)) {
      console.log("⚠️  No shares to withdraw; done.");
    } else {
      const withdrawShares = shares.div(2);
      const toWithdraw = withdrawShares.eq(0) ? shares : withdrawShares;
      console.log("Withdrawing shares:", ethers.utils.formatEther(toWithdraw));

      const userWantBeforeW = await want.balanceOf(user.address);
      const w = await vault.withdraw(toWithdraw, { gasLimit: 6_000_000 });
      const wr = await w.wait();
      console.log("✅ Withdraw tx:", wr.transactionHash);

      const userWantAfterW = await want.balanceOf(user.address);
      console.log("User received (want):", fmtUnits(userWantAfterW.sub(userWantBeforeW), wantDecimals), "\n");
    }
  }

  // SUMMARY
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                         SUMMARY                                ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  const finalUserWant = await want.balanceOf(user.address);
  const finalUserShares = await vault.balanceOf(user.address);
  const finalStratBalance = await strategy.balanceOf();
  console.log("Final user want:", fmtUnits(finalUserWant, wantDecimals));
  console.log("Final user shares:", ethers.utils.formatEther(finalUserShares));
  console.log("Final strategy.balanceOf():", fmtUnits(finalStratBalance, wantDecimals));
  console.log("\n🎉 Done");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

