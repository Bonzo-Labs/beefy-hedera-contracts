const hardhat = require("hardhat");
const { ethers } = hardhat;

/**
 * Quick test script for deposit/withdraw functionality
 * Tests the leftover calculation fix
 *
 * Usage:
 * STRATEGY_ADDRESS=0x... VAULT_ADDRESS=0x... npx hardhat run scripts/strategy/testDepositWithdraw.js --network hedera_testnet
 */

const STRATEGY_ADDRESS = "0x5dDf9A4aF6A43962f49CD8cca3179306DF36BD9e";
const VAULT_ADDRESS = "0x24d7C6a067503fab120A18485D40CC6eCe9C8A93";
const AMOUNT_0 = "0.4"; // Default 0.1 tokens
const AMOUNT_1 = "0.1"; // Default 0.1 tokens

async function main() {
  if (!STRATEGY_ADDRESS || !VAULT_ADDRESS) {
    throw new Error("STRATEGY_ADDRESS and VAULT_ADDRESS required");
  }

  const [user] = await ethers.getSigners();
  console.log("User:", user.address);
  console.log("Balance:", ethers.utils.formatEther(await user.getBalance()), "HBAR\n");

  // Connect to contracts
  const strategy = await ethers.getContractAt("SaucerSwapLariRewardsCLMStrategy", STRATEGY_ADDRESS);
  const vault = await ethers.getContractAt("BonzoVaultConcLiq", VAULT_ADDRESS);
  
  const token0Address = await strategy.lpToken0();
  const token1Address = await strategy.lpToken1();
  const token0 = await ethers.getContractAt("IERC20Metadata", token0Address);
  const token1 = await ethers.getContractAt("IERC20Metadata", token1Address);
  
  const decimals0 = await token0.decimals();
  const decimals1 = await token1.decimals();
  
  console.log("Strategy:", strategy.address);
  console.log("Vault:", vault.address);
  console.log("Token0:", token0Address);
  console.log("Token1:", token1Address);

  // 1. Check strategy balance BEFORE
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                  BEFORE DEPOSIT                                ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  const strategyBal0Before = await token0.balanceOf(strategy.address);
  const strategyBal1Before = await token1.balanceOf(strategy.address);
  
  console.log("\nStrategy idle balance:");
  console.log("  Token0:", ethers.utils.formatUnits(strategyBal0Before, decimals0));
  console.log("  Token1:", ethers.utils.formatUnits(strategyBal1Before, decimals1));

  const vaultSharesBefore = await vault.balanceOf(user.address);
  console.log("Vault shares before deposit:", ethers.utils.formatEther(vaultSharesBefore));
  
  // 2. Deposit
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                    DEPOSITING                                  ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  const depositAmount0 = ethers.utils.parseUnits(AMOUNT_0, decimals0);
  const depositAmount1 = ethers.utils.parseUnits(AMOUNT_1, decimals1);
  
  console.log("\nDeposit amounts:");
  console.log("  Token0:", AMOUNT_0);
  console.log("  Token1:", AMOUNT_1);
  
  // Check user balance
  const userBal0 = await token0.balanceOf(user.address);
  const userBal1 = await token1.balanceOf(user.address);
  
  console.log("\nUser balance:");
  console.log("  Token0:", ethers.utils.formatUnits(userBal0, decimals0));
  console.log("  Token1:", ethers.utils.formatUnits(userBal1, decimals1));
  
  if (userBal0.lt(depositAmount0) || userBal1.lt(depositAmount1)) {
    throw new Error("Insufficient user balance");
  }
  
  // Approve
  console.log("\nApproving tokens...");
  //check allowance and approve if needed
  const allowance0 = await token0.allowance(user.address, vault.address);
  const allowance1 = await token1.allowance(user.address, vault.address);
  if (allowance0.lt(depositAmount0)) {
    await token0.approve(vault.address, depositAmount0*10, { gasLimit: 1000000 });
  }
  if (allowance1.lt(depositAmount1)) {
    await token1.approve(vault.address, depositAmount1*10, { gasLimit: 1000000 });
  }
  console.log("✅ Approved");
  
  const hbarRequired = await vault.estimateDepositHBARRequired();
  console.log("HBAR required:", hbarRequired.toString());
  //add 25% buffer
  const hbarRequiredWithBuffer = hbarRequired.mul(125).div(100);
  if(hbarRequiredWithBuffer.lt(hbarRequired)) {
   throw new Error("HBAR required with buffer is less than hbar required");
  }
  console.log("HBAR required with buffer:", hbarRequiredWithBuffer.toString());
  // Deposit
  console.log("\nDepositing...");
  const depositTx = await vault.deposit(
    depositAmount0,
    depositAmount1,
    0, // minShares
    { gasLimit: 5000000, value: hbarRequiredWithBuffer.mul(10**10) }
  );
  
  console.log("Transaction:", depositTx.hash);
  const receipt = await depositTx.wait();
  console.log("✅ Deposit successful! Block:", receipt.blockNumber);
  
  // Check Deposit event
  const depositEvent = receipt.events?.find(e => e.event === "Deposit");
  if (depositEvent) {
    const emittedAmount0 = depositEvent.args.amount0;
    const emittedAmount1 = depositEvent.args.amount1;
    
    console.log("\n📊 Deposit Event:");
    console.log("  Emitted Amount0:", ethers.utils.formatUnits(emittedAmount0, decimals0));
    console.log("  Emitted Amount1:", ethers.utils.formatUnits(emittedAmount1, decimals1));
    console.log("  Expected Amount0:", AMOUNT_0);
    console.log("  Expected Amount1:", AMOUNT_1);
    
    // Verify event shows user's deposit, not total strategy balance
    if (emittedAmount0.gt(depositAmount0.mul(2))) {
      console.log("❌ WARNING: Event shows much more than deposited!");
      console.log("  This suggests the bug is NOT fixed!");
    } else {
      console.log("✅ Event amount looks correct");
    }
  }
  
  // 3. Check strategy balance AFTER
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                  AFTER DEPOSIT                                 ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  const strategyBal0After = await token0.balanceOf(strategy.address);
  const strategyBal1After = await token1.balanceOf(strategy.address);
  
  console.log("\nStrategy idle balance:");
  console.log("  Token0:", ethers.utils.formatUnits(strategyBal0After, decimals0));
  console.log("  Token1:", ethers.utils.formatUnits(strategyBal1After, decimals1));
  
  // const leftover0 = await strategy.leftover0();
  // const leftover1 = await strategy.leftover1();
  
  // console.log("\nReported leftovers:");
  // console.log("  Leftover0:", ethers.utils.formatUnits(leftover0, decimals0));
  // console.log("  Leftover1:", ethers.utils.formatUnits(leftover1, decimals1));

  const vaultSharesAfter = await vault.balanceOf(user.address);
  console.log("Vault shares after deposit:", ethers.utils.formatEther(vaultSharesAfter));
  
  // 4. Verify the fix
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                  FIX VERIFICATION                              ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  // Check if pre-existing balance was protected
  console.log("\nChecking if pre-existing balance protected:");
  console.log("  Before:", ethers.utils.formatUnits(strategyBal0Before, decimals0));
  console.log("  After:", ethers.utils.formatUnits(strategyBal0After, decimals0));
  
  if (strategyBal0Before.gt(0)) {
    if (strategyBal0After.gte(strategyBal0Before.div(2))) {
      console.log("✅ Pre-existing balance largely retained (fix working!)");
    } else {
      console.log("❌ Pre-existing balance significantly reduced (bug not fixed?)");
    }
  }
  
  // // Check if leftover is reasonable
  // if (leftover0.gt(depositAmount0)) {
  //   console.log("❌ WARNING: Leftover0 exceeds deposit amount!");
  //   console.log("  This suggests entire balance is being returned!");
  // } else {
  //   console.log("✅ Leftover0 is reasonable (≤ deposit amount)");
  // }
  
  // if (leftover1.gt(depositAmount1)) {
  //   console.log("❌ WARNING: Leftover1 exceeds deposit amount!");
  // } else {
  //   console.log("✅ Leftover1 is reasonable (≤ deposit amount)");
  // }
  
  // 5. Test withdraw
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                    WITHDRAWING                                 ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  const shares = await vault.balanceOf(user.address);
  console.log("\nUser shares:", ethers.utils.formatEther(shares));
  
  if (shares.eq(0)) {
    console.log("⚠️  No shares to withdraw");
  } else {
    const withdrawShares = shares; // shares.div(2);
    console.log("Withdrawing all shares:", ethers.utils.formatEther(withdrawShares));
    
    const userBal0BeforeWithdraw = await token0.balanceOf(user.address);
    const userBal1BeforeWithdraw = await token1.balanceOf(user.address);
    
    const withdrawTx = await vault.withdraw(
      withdrawShares,
      0,
      0,
      { gasLimit: 5000000, value: hbarRequiredWithBuffer.mul(10**10) }
    );
    
    await withdrawTx.wait();
    console.log("✅ Withdraw successful!");
    
    const userBal0AfterWithdraw = await token0.balanceOf(user.address);
    const userBal1AfterWithdraw = await token1.balanceOf(user.address);
    
    const received0 = userBal0AfterWithdraw.sub(userBal0BeforeWithdraw);
    const received1 = userBal1AfterWithdraw.sub(userBal1BeforeWithdraw);
    
    console.log("\nUser received:");
    console.log("  Token0:", ethers.utils.formatUnits(received0, decimals0));
    console.log("  Token1:", ethers.utils.formatUnits(received1, decimals1));
  }
  
  // Summary
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                       SUMMARY                                  ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  const [tvl0, tvl1] = await strategy.balances();
  const totalSupply = await vault.totalSupply();
  
  console.log("\nStrategy TVL:");
  console.log("  Token0:", ethers.utils.formatUnits(tvl0, decimals0));
  console.log("  Token1:", ethers.utils.formatUnits(tvl1, decimals1));
  console.log("\nVault Total Supply:", ethers.utils.formatEther(totalSupply));
  console.log("\n🎉 Test complete!");
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });

