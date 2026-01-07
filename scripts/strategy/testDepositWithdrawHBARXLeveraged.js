const hardhat = require("hardhat");
const { ethers } = hardhat;

/**
 * Quick test script for deposit/withdraw functionality
 * for BonzoHBARXLevergedLiqStaking via BonzoVaultV7.
 *
 * Usage:
 * STRATEGY_ADDRESS=0x... VAULT_ADDRESS=0x... AMOUNT=0.1 \
 *   npx hardhat run scripts/strategy/testDepositWithdrawHBARXLeveraged.js --network hedera_testnet
 *
 * Notes:
 * - Deposits are done through the vault (strategy only accepts calls from the vault).
 * - HBARX is typically 8 decimals on Hedera (this script attempts to read decimals; falls back to 8).
 */

const DEFAULT_STRATEGY_ADDRESS = "0x919A4D841d5d16d46983a0f1a385E908e57cB035";
const DEFAULT_VAULT_ADDRESS = "0xEC213164c69BCa9326392Ce9b31872d0D58Da498";
const DEFAULT_AMOUNT = "7.1";

function fmtUnits(bn, decimals) {
  return ethers.utils.formatUnits(bn, decimals);
}

async function main() {
  const STRATEGY_ADDRESS =  DEFAULT_STRATEGY_ADDRESS;
  const VAULT_ADDRESS =  DEFAULT_VAULT_ADDRESS;
  const AMOUNT = DEFAULT_AMOUNT;

  const [user] = await ethers.getSigners();
  console.log("User:", user.address);
  console.log("HBAR balance:", ethers.utils.formatEther(await user.getBalance()), "\n");

  const strategy = await ethers.getContractAt("BonzoHBARXLevergedLiqStaking", STRATEGY_ADDRESS);
  const vault = await ethers.getContractAt("BonzoVaultV7", VAULT_ADDRESS);

  // Token addresses
  const wantAddress = await strategy.want();
  const aTokenAddress = await strategy.aToken();
  const debtTokenAddress = await strategy.debtToken();

  // Token contracts
  const want = await ethers.getContractAt("IERC20Upgradeable", wantAddress);
  const aToken = await ethers.getContractAt("IERC20Upgradeable", aTokenAddress);
  const debtToken = await ethers.getContractAt("IERC20Upgradeable", debtTokenAddress);

  // decimals are explicitly tracked by the strategy (HBARX is typically 8 on Hedera)
  const wantDecimals = Number(await strategy.wantTokenDecimals());

  console.log("Strategy:", strategy.address);
  console.log("Vault:", vault.address);
  console.log("Want (HBARX):", wantAddress, `decimals=${wantDecimals}`);
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

//   // DEPOSIT
//   console.log("╔════════════════════════════════════════════════════════════════╗");
//   console.log("║                        DEPOSIT                                 ║");
//   console.log("╚════════════════════════════════════════════════════════════════╝");

//   const depositAmount = ethers.utils.parseUnits(AMOUNT, wantDecimals);
//   console.log("Deposit amount:", AMOUNT, `(raw=${depositAmount.toString()})`);

//   if (userWantBefore.lt(depositAmount)) {
//     throw new Error(`Insufficient want balance. Have ${userWantBefore.toString()} need ${depositAmount.toString()}`);
//   }

//   const allowance = await want.allowance(user.address, vault.address);
//   if (allowance.lt(depositAmount)) {
//     console.log("Approving vault...");
//     const approveTx = await want.approve(vault.address, depositAmount.mul(10), { gasLimit: 1_000_000 });
//     await approveTx.wait();
//     console.log("✅ Approved\n");
//   }

//   console.log("Depositing...");
//   const depositTx = await vault.deposit(depositAmount, { gasLimit: 6_000_000 });
//   const depositReceipt = await depositTx.wait();
//   console.log("✅ Deposit tx:", depositReceipt.transactionHash);

//   const vaultDepositEvent = depositReceipt.events?.find((e) => e.event === "Deposit");
//   if (vaultDepositEvent?.args) {
//     console.log("Vault Deposit event:");
//     console.log("  user:", vaultDepositEvent.args.user);
//     console.log("  token:", vaultDepositEvent.args.token);
//     console.log("  amount:", fmtUnits(vaultDepositEvent.args.amount, wantDecimals));
//     console.log("  shares:", ethers.utils.formatEther(vaultDepositEvent.args.shares));
//   }
//   console.log("");

//   // AFTER DEPOSIT
//   console.log("╔════════════════════════════════════════════════════════════════╗");
//   console.log("║                      AFTER DEPOSIT                             ║");
//   console.log("╚════════════════════════════════════════════════════════════════╝");

//   const userWantAfterDep = await want.balanceOf(user.address);
//   const userSharesAfterDep = await vault.balanceOf(user.address);
//   const vaultWantAfterDep = await want.balanceOf(vault.address);

//   const stratWantAfterDep = await want.balanceOf(strategy.address);
//   const stratATokenAfterDep = await aToken.balanceOf(strategy.address);
//   const stratDebtAfterDep = await debtToken.balanceOf(strategy.address);
//   const stratBalanceAfterDep = await strategy.balanceOf();

//   console.log("User want:", fmtUnits(userWantAfterDep, wantDecimals));
//   console.log("User shares:", ethers.utils.formatEther(userSharesAfterDep));
//   console.log("Vault want:", fmtUnits(vaultWantAfterDep, wantDecimals));
//   console.log("Strategy.balanceOf():", fmtUnits(stratBalanceAfterDep, wantDecimals));
//   console.log("Strategy want:", fmtUnits(stratWantAfterDep, wantDecimals));
//   console.log("Strategy aToken:", fmtUnits(stratATokenAfterDep, wantDecimals));
//   console.log("Strategy debtToken (raw):", stratDebtAfterDep.toString(), "\n");

  // WITHDRAW (50%)
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║                       WITHDRAW 50%                             ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");

  const shares = await vault.balanceOf(user.address);
  console.log("User shares:", ethers.utils.formatEther(shares));
  if (shares.eq(0)) {
    console.log("⚠️  No shares to withdraw; done.");
    return;
  }

  const halfShares = shares//.div(2);
  console.log("Withdrawing shares:", ethers.utils.formatEther(halfShares));

  const userWantBeforeW1 = await want.balanceOf(user.address);
  const w1 = await vault.withdraw(halfShares, { gasLimit: 6_000_000 });
  const w1r = await w1.wait();
  console.log("✅ Withdraw tx:", w1r.transactionHash);

  const userWantAfterW1 = await want.balanceOf(user.address);
  console.log("User received (want):", fmtUnits(userWantAfterW1.sub(userWantBeforeW1), wantDecimals), "\n");

//   // WITHDRAW REMAINING
//   console.log("╔════════════════════════════════════════════════════════════════╗");
//   console.log("║                   WITHDRAW REMAINING                           ║");
//   console.log("╚════════════════════════════════════════════════════════════════╝");

//   const remainingShares = await vault.balanceOf(user.address);
//   console.log("Remaining shares:", ethers.utils.formatEther(remainingShares));
//   if (remainingShares.gt(0)) {
//     const userWantBeforeW2 = await want.balanceOf(user.address);
//     const w2 = await vault.withdraw(remainingShares, { gasLimit: 6_000_000 });
//     const w2r = await w2.wait();
//     console.log("✅ Withdraw tx:", w2r.transactionHash);
//     const userWantAfterW2 = await want.balanceOf(user.address);
//     console.log("User received (want):", fmtUnits(userWantAfterW2.sub(userWantBeforeW2), wantDecimals));
//   }

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


