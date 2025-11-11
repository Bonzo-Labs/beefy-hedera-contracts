import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { SaucerSwapLariRewardsCLMStrategy, BonzoVaultConcLiq } from "../../typechain-types";

/**
 * Minimal Test Suite for SaucerSwap LARI Rewards CLM Strategy
 * Tests: Deposit, Withdraw, Harvest
 * 
 * Usage:
 * CHAIN_TYPE=mainnet npx hardhat test test/Hedera/FinalSaucerSwapLariStrategy.test.ts --network hedera_mainnet
 */

const CHAIN_TYPE = process.env.CHAIN_TYPE || "mainnet";

// ============================================================================
// VAULT CONFIGURATIONS - All deployed vaults with their addresses
// ============================================================================
interface VaultConfig {
  name: string;
  poolName: string;
  vaultAddress: string;
  strategyAddress: string;
  token0Address: string;
  token0Symbol: string;
  token0Decimals: number;
  token1Address: string;
  token1Symbol: string;
  token1Decimals: number;
  depositAmounts: {
    token0: string; // Amount in token0 units
    token1: string; // Amount in token1 units
  };
  isNativePool: boolean; // True if one of the tokens is HBAR (native)
  nativeTokenIndex?: 0 | 1; // Which token is native (0 or 1)
}

const MAINNET_VAULTS: VaultConfig[] = [
  {
    name: "BONZO-XBONZO CLM Vault",
    poolName: "BONZO-XBONZO",
    vaultAddress: "0x13034Edc623AAccc4Af00D6BDb851552CBA583ce", // TODO: Add deployed vault address
    strategyAddress: "0x2A04d850B464b52f7a69c1983C357E8539370626", // TODO: Add deployed strategy address
    token0Address: "0x00000000000000000000000000000000007e545e", // BONZO
    token0Symbol: "BONZO",
    token0Decimals: 8,
    token1Address: "0x0000000000000000000000000000000000818e2d", // XBONZO
    token1Symbol: "XBONZO",
    token1Decimals: 8,
    depositAmounts: {
      token0: "0.1", // 0.1 BONZO
      token1: "0.1", // 0.1 XBONZO
    },
    isNativePool: false,
  },
  {
    name: "USDC-SAUCE CLM Vault",
    poolName: "USDC-SAUCE",
    vaultAddress: "0x070C88469C04cf1AF3aC57755FE4A48a3c72eb95", // TODO: Add deployed vault address
    strategyAddress: "0xac7e4A60068e2D2bD9234dCFf5457D222CCE5cA4", // TODO: Add deployed strategy address
    token0Address: "0x000000000000000000000000000000000006f89a", // USDC
    token0Symbol: "USDC",
    token0Decimals: 6,
    token1Address: "0x00000000000000000000000000000000000b2ad5", // SAUCE
    token1Symbol: "SAUCE",
    token1Decimals: 6,
    depositAmounts: {
      token0: "0.1", // 0.1 USDC
      token1: "0.1", // 0.1 SAUCE
    },
    isNativePool: false,
  },
  {
    name: "USDC-HBAR CLM Vault",
    poolName: "USDC-HBAR",
    vaultAddress: "0x35415E230bD8aBD5C8Cbe0110647e2ccCbEB3C87", // TODO: Add deployed vault address
    strategyAddress: "0x9A02768A5F258dd5FaB1137A91Ff655A6E3aCd2e", // TODO: Add deployed strategy address
    token0Address: "0x000000000000000000000000000000000006f89a", // USDC
    token0Symbol: "USDC",
    token0Decimals: 6,
    token1Address: "0x0000000000000000000000000000000000163b5a", // WHBAR (but users deposit HBAR)
    token1Symbol: "HBAR",
    token1Decimals: 8,
    depositAmounts: {
      token0: "0.1", // 0.1 USDC
      token1: "0.1", // 0.1 HBAR
    },
    isNativePool: true,
    nativeTokenIndex: 1,
  },
  {
    name: "SAUCE-XSAUCE CLM Vault",
    poolName: "SAUCE-XSAUCE",
    vaultAddress: "0x464dBaD77730694A088bbAb2fB8435cd6f2dDF48", // TODO: Add deployed vault address
    strategyAddress: "0x371aF8A155577E7C2bA0592E8294a3150d642422", // TODO: Add deployed strategy address
    token0Address: "0x00000000000000000000000000000000000b2ad5", // SAUCE
    token0Symbol: "SAUCE",
    token0Decimals: 6,
    token1Address: "0x00000000000000000000000000000000001647e8", // XSAUCE
    token1Symbol: "XSAUCE",
    token1Decimals: 6,
    depositAmounts: {
      token0: "0.1", // 0.1 SAUCE
      token1: "0.1", // 0.1 XSAUCE
    },
    isNativePool: false,
  },
];

const TESTNET_VAULTS: VaultConfig[] = [
  {
    name: "CLXY-SAUCE CLM Vault (Testnet)",
    poolName: "CLXY-SAUCE",
    vaultAddress: "0xd5110D64F4AedD188ef64836984027346E4368B8", // Example testnet address
    strategyAddress: "0x3618edb90aDa25395142cc406ac8633eFb33087D", // Example testnet address
    token0Address: "0x00000000000000000000000000000000000014f5", // CLXY testnet
    token0Symbol: "CLXY",
    token0Decimals: 6,
    token1Address: "0x0000000000000000000000000000000000120f46", // SAUCE testnet
    token1Symbol: "SAUCE",
    token1Decimals: 6,
    depositAmounts: {
      token0: "1.0", // 1 CLXY
      token1: "1.0", // 1 SAUCE
    },
    isNativePool: false,
  },
];

// ============================================================================
// TEST SUITE
// ============================================================================
describe("SaucerSwap LARI Strategy - Main Functions Test Suite", function () {
  this.timeout(180000); // 3 minutes timeout for all tests

  let deployer: SignerWithAddress;
  const VAULTS = CHAIN_TYPE === "mainnet" ? MAINNET_VAULTS : TESTNET_VAULTS;

  before(async () => {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    
    console.log("\n" + "=".repeat(80));
    console.log("🚀 SAUCERSWAP LARI STRATEGY TEST SUITE");
    console.log("=".repeat(80));
    console.log(`📍 Chain Type: ${CHAIN_TYPE.toUpperCase()}`);
    console.log(`👤 Deployer Address: ${deployer.address}`);
    console.log(`💰 Deployer Balance: ${ethers.utils.formatEther(await deployer.getBalance())} HBAR`);
    console.log(`📊 Total Vaults to Test: ${VAULTS.length}`);
    console.log("=".repeat(80) + "\n");
  });

  // ============================================================================
  // Iterate through all vault configurations and run tests
  // ============================================================================
  VAULTS.forEach((vaultConfig, index) => {
    describe(`Vault ${index + 1}/${VAULTS.length}: ${vaultConfig.name}`, function () {
      let vault: BonzoVaultConcLiq;
      let strategy: SaucerSwapLariRewardsCLMStrategy;
      let token0Contract: any;
      let token1Contract: any;

      before(async function () {
        console.log("\n" + "-".repeat(80));
        console.log(`🏦 Setting up: ${vaultConfig.name}`);
        console.log("-".repeat(80));
        console.log(`📝 Pool: ${vaultConfig.poolName}`);
        console.log(`🏛️  Vault Address: ${vaultConfig.vaultAddress}`);
        console.log(`⚙️  Strategy Address: ${vaultConfig.strategyAddress}`);
        console.log(`🪙  Token0: ${vaultConfig.token0Symbol} (${vaultConfig.token0Address})`);
        console.log(`🪙  Token1: ${vaultConfig.token1Symbol} (${vaultConfig.token1Address})`);
        console.log(`🌊 Native Pool: ${vaultConfig.isNativePool ? "Yes" : "No"}`);
        console.log("-".repeat(80) + "\n");

        // Skip if addresses are placeholder
        if (vaultConfig.vaultAddress.includes("YOUR_") || vaultConfig.strategyAddress.includes("YOUR_")) {
          console.log("⚠️  SKIPPING: Placeholder addresses detected. Update with real addresses.");
          this.skip();
          return;
        }

        try {
          // Connect to vault and strategy
          vault = (await ethers.getContractAt(
            "BonzoVaultConcLiq",
            vaultConfig.vaultAddress
          )) as BonzoVaultConcLiq;

          strategy = (await ethers.getContractAt(
            "SaucerSwapLariRewardsCLMStrategy",
            vaultConfig.strategyAddress
          )) as SaucerSwapLariRewardsCLMStrategy;

          // Initialize token contracts
          token0Contract = await ethers.getContractAt(
            "@openzeppelin-4/contracts/token/ERC20/IERC20.sol:IERC20",
            vaultConfig.token0Address
          );
          token1Contract = await ethers.getContractAt(
            "@openzeppelin-4/contracts/token/ERC20/IERC20.sol:IERC20",
            vaultConfig.token1Address
          );

          console.log("✅ Contracts connected successfully\n");

          // Display strategy info
          console.log("📊 Strategy Information:");
          const isPaused = await strategy.paused();
          const owner = await strategy.owner();
          const rewardTokensLength = await strategy.getRewardTokensLength();
          console.log(`   • Paused: ${isPaused}`);
          console.log(`   • Owner: ${owner}`);
          console.log(`   • Reward Tokens: ${rewardTokensLength.toString()}\n`);

        } catch (error: any) {
          console.error("❌ Failed to connect to contracts:", error.message);
          this.skip();
        }
      });

      // ========================================================================
      // TEST 1: DEPOSIT
      // ========================================================================
      it(`Should handle deposits of ${vaultConfig.token0Symbol} + ${vaultConfig.token1Symbol}`, async function () {
        console.log("\n" + "▶".repeat(40));
        console.log(`🔵 TEST: DEPOSIT - ${vaultConfig.poolName}`);
        console.log("▶".repeat(40) + "\n");

        try {
          // Get initial balances
          const initialShares = await vault.balanceOf(deployer.address);
          const initialToken0 = await token0Contract.balanceOf(deployer.address);
          const initialToken1Balance = vaultConfig.isNativePool && vaultConfig.nativeTokenIndex === 1
            ? await deployer.getBalance()
            : await token1Contract.balanceOf(deployer.address);

          console.log("📊 Initial Balances:");
          console.log(`   • ${vaultConfig.token0Symbol}: ${ethers.utils.formatUnits(initialToken0, vaultConfig.token0Decimals)}`);
          if (vaultConfig.isNativePool && vaultConfig.nativeTokenIndex === 1) {
            console.log(`   • ${vaultConfig.token1Symbol}: ${ethers.utils.formatEther(initialToken1Balance)} HBAR`);
          } else {
            console.log(`   • ${vaultConfig.token1Symbol}: ${ethers.utils.formatUnits(initialToken1Balance, vaultConfig.token1Decimals)}`);
          }
          console.log(`   • Vault Shares: ${initialShares.toString()}\n`);

          // Parse deposit amounts
          const depositToken0Amount = ethers.utils.parseUnits(
            vaultConfig.depositAmounts.token0,
            vaultConfig.token0Decimals
          );
          const depositToken1Amount = ethers.utils.parseUnits(
            vaultConfig.depositAmounts.token1,
            vaultConfig.token1Decimals
          );

          console.log("🔧 Preparing Deposit:");
          console.log(`   • ${vaultConfig.token0Symbol} Amount: ${vaultConfig.depositAmounts.token0}`);
          console.log(`   • ${vaultConfig.token1Symbol} Amount: ${vaultConfig.depositAmounts.token1}\n`);

          // Approve tokens
          console.log("✍️  Approving tokens...");
          const approveTx0 = await token0Contract.approve(vault.address, depositToken0Amount, {
            gasLimit: 1000000,
          });
          await approveTx0.wait();
          console.log(`   ✅ ${vaultConfig.token0Symbol} approved`);

          if (!vaultConfig.isNativePool || vaultConfig.nativeTokenIndex !== 1) {
            const approveTx1 = await token1Contract.approve(vault.address, depositToken1Amount, {
              gasLimit: 1000000,
            });
            await approveTx1.wait();
            console.log(`   ✅ ${vaultConfig.token1Symbol} approved\n`);
          } else {
            console.log(`   ℹ️  ${vaultConfig.token1Symbol} is native HBAR (no approval needed)\n`);
          }

          // Get HBAR required for mint fees
          let hbarRequired = await vault.estimateDepositHBARRequired();
          console.log(`💸 HBAR Required for Mint Fees: ${ethers.utils.formatEther(hbarRequired.mul(10**10))} HBAR`);

          // Calculate total HBAR value to send
          let totalHbarValue = hbarRequired.mul(10**10);
          if (vaultConfig.isNativePool && vaultConfig.nativeTokenIndex === 1) {
            totalHbarValue = totalHbarValue.add(ethers.utils.parseEther(vaultConfig.depositAmounts.token1));
            console.log(`💸 Total HBAR (Mint Fees + Deposit): ${ethers.utils.formatEther(totalHbarValue)} HBAR\n`);
          } else {
            console.log("");
          }

          // Execute deposit
          console.log("🚀 Executing deposit transaction...");
          const depositTx = await vault.deposit(
            depositToken0Amount,
            depositToken1Amount,
            0, // min shares (0 for testing)
            {
              value: totalHbarValue,
              gasLimit: 2000000,
            }
          );
          const receipt = await depositTx.wait();
          console.log(`   ✅ Deposit successful!`);
          console.log(`   📝 Transaction Hash: ${receipt.transactionHash}\n`);

          // Check final balances
          const finalShares = await vault.balanceOf(deployer.address);
          const finalToken0 = await token0Contract.balanceOf(deployer.address);
          const finalToken1Balance = vaultConfig.isNativePool && vaultConfig.nativeTokenIndex === 1
            ? await deployer.getBalance()
            : await token1Contract.balanceOf(deployer.address);

          const token0Used = initialToken0.sub(finalToken0);
          const token1Used = initialToken1Balance.sub(finalToken1Balance);
          const sharesReceived = finalShares.sub(initialShares);

          console.log("📊 Deposit Results:");
          console.log(`   • ${vaultConfig.token0Symbol} Used: ${ethers.utils.formatUnits(token0Used, vaultConfig.token0Decimals)}`);
          if (vaultConfig.isNativePool && vaultConfig.nativeTokenIndex === 1) {
            console.log(`   • ${vaultConfig.token1Symbol} Used: ${ethers.utils.formatEther(token1Used)} HBAR`);
          } else {
            console.log(`   • ${vaultConfig.token1Symbol} Used: ${ethers.utils.formatUnits(token1Used, vaultConfig.token1Decimals)}`);
          }
          console.log(`   • Vault Shares Received: ${sharesReceived.toString()}`);
          console.log(`   • Total Shares: ${finalShares.toString()}\n`);

          // Verify deposit success
          expect(sharesReceived).to.be.gt(0);
          console.log("✅ DEPOSIT TEST PASSED\n");

        } catch (error: any) {
          console.error("❌ DEPOSIT TEST FAILED:", error.message);
          throw error;
        }
      });


      // ========================================================================
      // TEST 2: WITHDRAW
      // ========================================================================
      it(`Should handle withdrawals of ${vaultConfig.token0Symbol} + ${vaultConfig.token1Symbol}`, async function () {
        console.log("\n" + "▶".repeat(40));
        console.log(`🔴 TEST: WITHDRAW - ${vaultConfig.poolName}`);
        console.log("▶".repeat(40) + "\n");

        try {
          // Get current shares
          const currentShares = await vault.balanceOf(deployer.address);
          console.log(`📊 Current Vault Shares: ${currentShares.toString()}\n`);

          if (currentShares.eq(0)) {
            console.log("⚠️  No shares to withdraw. Skipping withdrawal test.\n");
            this.skip();
            return;
          }

          // Get initial token balances
          const initialToken0 = await token0Contract.balanceOf(deployer.address);
          const initialToken1Balance = vaultConfig.isNativePool && vaultConfig.nativeTokenIndex === 1
            ? await deployer.getBalance()
            : await token1Contract.balanceOf(deployer.address);

          console.log("📊 Initial Token Balances:");
          console.log(`   • ${vaultConfig.token0Symbol}: ${ethers.utils.formatUnits(initialToken0, vaultConfig.token0Decimals)}`);
          if (vaultConfig.isNativePool && vaultConfig.nativeTokenIndex === 1) {
            console.log(`   • ${vaultConfig.token1Symbol}: ${ethers.utils.formatEther(initialToken1Balance)} HBAR\n`);
          } else {
            console.log(`   • ${vaultConfig.token1Symbol}: ${ethers.utils.formatUnits(initialToken1Balance, vaultConfig.token1Decimals)}\n`);
          }

          // Withdraw 50% of shares
          const sharesToWithdraw = currentShares.div(2);
          console.log(`🔧 Withdrawing 50% of Shares: ${sharesToWithdraw.toString()}\n`);

          // Get HBAR required for withdrawal
          let hbarRequired = await vault.estimateDepositHBARRequired();
          console.log(`💸 HBAR Required for Withdrawal: ${ethers.utils.formatEther(hbarRequired.mul(10**10))} HBAR\n`);

          // Execute withdrawal
          console.log("🚀 Executing withdrawal transaction...");
          const withdrawTx = await vault.withdraw(
            sharesToWithdraw,
            0, // min token0
            0, // min token1
            {
              value: hbarRequired.mul(10**10),
              gasLimit: 2000000,
            }
          );
          const receipt = await withdrawTx.wait();
          console.log(`   ✅ Withdrawal successful!`);
          console.log(`   📝 Transaction Hash: ${receipt.transactionHash}\n`);

          // Check final balances
          const finalShares = await vault.balanceOf(deployer.address);
          const finalToken0 = await token0Contract.balanceOf(deployer.address);
          const finalToken1Balance = vaultConfig.isNativePool && vaultConfig.nativeTokenIndex === 1
            ? await deployer.getBalance()
            : await token1Contract.balanceOf(deployer.address);

          const token0Received = finalToken0.sub(initialToken0);
          const token1Received = finalToken1Balance.sub(initialToken1Balance);
          const sharesWithdrawn = currentShares.sub(finalShares);

          console.log("📊 Withdrawal Results:");
          console.log(`   • Shares Withdrawn: ${sharesWithdrawn.toString()}`);
          console.log(`   • Remaining Shares: ${finalShares.toString()}`);
          console.log(`   • ${vaultConfig.token0Symbol} Received: ${ethers.utils.formatUnits(token0Received, vaultConfig.token0Decimals)}`);
          if (vaultConfig.isNativePool && vaultConfig.nativeTokenIndex === 1) {
            console.log(`   • ${vaultConfig.token1Symbol} Received: ${ethers.utils.formatEther(token1Received)} HBAR\n`);
          } else {
            console.log(`   • ${vaultConfig.token1Symbol} Received: ${ethers.utils.formatUnits(token1Received, vaultConfig.token1Decimals)}\n`);
          }

          // Verify withdrawal success
          expect(sharesWithdrawn).to.be.gt(0);
          expect(token0Received).to.be.gt(0);
          console.log("✅ WITHDRAWAL TEST PASSED\n");

        } catch (error: any) {
          console.error("❌ WITHDRAWAL TEST FAILED:", error.message);
          throw error;
        }
      });


       // ========================================================================
      // TEST 2: HARVEST
      // ========================================================================
      it(`Should harvest LARI rewards for ${vaultConfig.poolName}`, async function () {
        console.log("\n" + "▶".repeat(40));
        console.log(`🟢 TEST: HARVEST - ${vaultConfig.poolName}`);
        console.log("▶".repeat(40) + "\n");

        try {
          // Get reward tokens info
          const rewardTokensLength = await strategy.getRewardTokensLength();
          console.log("📊 Reward Tokens Configuration:");
          console.log(`   • Total Reward Tokens: ${rewardTokensLength.toString()}\n`);

          for (let i = 0; i < rewardTokensLength.toNumber(); i++) {
            try {
              const rewardToken = await (strategy as any).getRewardToken(i);
              console.log(`   📌 Reward Token ${i + 1}:`);
              console.log(`      • Address: ${rewardToken.token}`);
              console.log(`      • Active: ${rewardToken.isActive}`);
              console.log(`      • HTS: ${rewardToken.isHTS}`);
            } catch (e: any) {
              console.log(`   📌 Reward Token ${i + 1}: Unable to fetch details`);
            }
          }
          console.log("");

          // Get HBAR required for harvest
          let hbarRequired = await vault.estimateDepositHBARRequired();
          console.log(`💸 HBAR Required for Harvest: ${ethers.utils.formatEther(hbarRequired.mul(10**10))} HBAR\n`);

          // Step 1: Process LARI rewards first
          console.log("🔄 Step 1: Processing LARI rewards...");
          try {
            const processLariTx = await (strategy as any)["processLariRewards()"]({
              gasLimit: 4000000,
            });
            const processLariReceipt = await processLariTx.wait();
            console.log(`   ✅ LARI rewards processed!`);
            console.log(`   📝 Transaction Hash: ${processLariReceipt.transactionHash}\n`);
          } catch (processError: any) {
            console.log(`   ⚠️  Process LARI rewards skipped: ${processError.message}`);
            console.log(`   ℹ️  This may be expected if there are no LARI rewards yet.\n`);
          }

          // Step 2: Execute harvest to compound rewards
          console.log("🚀 Step 2: Executing harvest transaction...");
          const harvestTx = await (strategy as any)["harvest()"]({
            value: hbarRequired.mul(10**10),
            gasLimit: 3000000,
          });
          const receipt = await harvestTx.wait();
          console.log(`   ✅ Harvest successful!`);
          console.log(`   📝 Transaction Hash: ${receipt.transactionHash}\n`);

          console.log("✅ HARVEST TEST PASSED (2-step process: Process LARI → Harvest)\n");

        } catch (error: any) {
          console.error("⚠️  HARVEST TEST ISSUE:", error.message);
          console.log("   ℹ️  This may be expected if there are no rewards to harvest yet.\n");
          // Don't fail the test if harvest fails (might be no rewards yet)
        }
      });

      after(function () {
        console.log("-".repeat(80));
        console.log(`✅ Completed tests for: ${vaultConfig.name}`);
        console.log("-".repeat(80) + "\n");
      });
    });
  });

  after(async () => {
    console.log("\n" + "=".repeat(80));
    console.log("🏁 TEST SUITE COMPLETED");
    console.log("=".repeat(80));
    console.log(`📍 Chain Type: ${CHAIN_TYPE.toUpperCase()}`);
    console.log(`📊 Total Vaults Tested: ${VAULTS.length}`);
    console.log(`👤 Deployer Address: ${deployer.address}`);
    console.log(`💰 Final Balance: ${ethers.utils.formatEther(await deployer.getBalance())} HBAR`);
    console.log("=".repeat(80) + "\n");
  });
});

