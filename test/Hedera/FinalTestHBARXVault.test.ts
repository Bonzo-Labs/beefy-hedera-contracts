import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
  BonzoVaultV7,
  BonzoHBARXLevergedLiqStaking,
  IERC20Upgradeable,
} from "../../typechain-types";

// Mainnet addresses
const addresses = require("../../scripts/deployed-addresses-mainnet.json");
const HBARX_TOKEN_ADDRESS = "0x00000000000000000000000000000000000cba44";
const HBAR_TOKEN_ADDRESS = "0x0000000000000000000000000000000000163b5a";
const AHBARX_TOKEN_ADDRESS = "0x40EBC87627Fe4689567C47c8C9C84EDC4Cf29132";
const DEBT_TOKEN_ADDRESS = "0xCD5A1FF3AD6EDd7e85ae6De3854f3915dD8c9103";
const LENDING_POOL_ADDRESS = "0x236897c518996163E7b313aD21D1C9fCC7BA1afc";
const REWARDS_CONTROLLER_ADDRESS = "0x0f3950d2fCbf62a2D79880E4fc251E4CB6625FBC";
const UNIROUTER_ADDRESS = "0x00000000000000000000000000000000003c437a";
const STAKING_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000158d97";
const WHBAR_GATEWAY_ADDRESS = "0xa7e46f496b088A8f8ee35B74D7E58d6Ce648Ae64";

const VAULT_FACTORY_ADDRESS = addresses.vaultFactory;
const FEE_CONFIG_ADDRESS = addresses.beefyFeeConfig;
const BEEFY_FEE_RECIPIENT = addresses.beefyFeeRecipient;
const STRATEGY_OWNER = addresses.strategyOwner;
const VAULT_OWNER = addresses.vaultOwner;
const KEEPER = addresses.keeper;

// Control flag: set to true to deploy new contracts, false to use existing ones
// Can be overridden via environment variable: DEPLOY_NEW_CONTRACTS=false
// Defaults to true (deploy new contracts) if not set
const deployNewContract = false;

// Existing deployed contract addresses (used when deployNewContract is false)
const EXISTING_VAULT_ADDRESS = "0x88C5fC29ff52E21AF226651E5Fb37BA1ACa4E0e0";
const EXISTING_STRATEGY_ADDRESS = "0xb0Fd3D85DD58B8e051A6DB7f91815e05dB1ad79C";

describe("Final HBARX Vault Test Suite", function () {
  this.timeout(1000000);

  let vault: BonzoVaultV7;
  let strategy: BonzoHBARXLevergedLiqStaking;
  let want: IERC20Upgradeable;
  let deployer: SignerWithAddress;
  let vaultAddress: string;

  before(async () => {
    [deployer] = await ethers.getSigners();
    
    console.log("\n========================================");
    console.log("🚀 Starting HBARX Vault Test Setup");
    console.log("========================================");
    console.log("👤 Test Account:", deployer.address);
    console.log("🔧 Deploy New Contracts:", deployNewContract);
    console.log("\n📋 Contract Addresses:");
    console.log("  - Vault Factory:", VAULT_FACTORY_ADDRESS);
    console.log("  - Fee Config:", FEE_CONFIG_ADDRESS);
    console.log("  - Fee Recipient:", BEEFY_FEE_RECIPIENT);
    console.log("  - Strategy Owner:", STRATEGY_OWNER);
    console.log("  - Vault Owner:", VAULT_OWNER);
    console.log("  - Keeper:", KEEPER);
    console.log("  - Staking Contract:", STAKING_CONTRACT_ADDRESS);

    if (deployNewContract) {
      console.log("\n🔨 Deploying New Contracts...");
      
      // Deploy strategy
      console.log("\n🔨 Deploying Strategy...");
      const BonzoHBARXLevergedLiqStaking = await ethers.getContractFactory("BonzoHBARXLevergedLiqStaking");
      strategy = (await BonzoHBARXLevergedLiqStaking.deploy({ gasLimit: 5000000 })) as BonzoHBARXLevergedLiqStaking;
      await strategy.deployed();
      console.log("✅ Strategy Deployed:", strategy.address);

      // Deploy vault via factory
      console.log("\n🔨 Creating Vault via Factory...");
      const vaultFactory = await ethers.getContractAt("BonzoVaultV7Factory", VAULT_FACTORY_ADDRESS);
      const tx = await vaultFactory.cloneVault({ gasLimit: 4000000 });
      const receipt = await tx.wait();
      const proxyCreatedEvent = receipt.events?.find((e: any) => e.event === "ProxyCreated");
      vaultAddress = proxyCreatedEvent?.args?.proxy;
      vault = (await ethers.getContractAt("BonzoVaultV7", vaultAddress)) as BonzoVaultV7;
      console.log("✅ Vault Created:", vaultAddress);

      // Initialize strategy
      console.log("\n⚙️  Initializing Strategy...");
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const commonAddresses = {
        vault: vaultAddress,
        keeper: KEEPER,
        strategist: STRATEGY_OWNER,
        unirouter: UNIROUTER_ADDRESS,
        beefyFeeRecipient: BEEFY_FEE_RECIPIENT,
        beefyFeeConfig: FEE_CONFIG_ADDRESS,
      };

      await strategy.initialize(
        HBARX_TOKEN_ADDRESS,
        HBAR_TOKEN_ADDRESS,
        AHBARX_TOKEN_ADDRESS,
        DEBT_TOKEN_ADDRESS,
        LENDING_POOL_ADDRESS,
        REWARDS_CONTROLLER_ADDRESS,
        STAKING_CONTRACT_ADDRESS,
        3000, // maxBorrowable (30%)
        400,   // slippageTolerance (4%)
        false, // isRewardsAvailable
        false,  // isBonzoDeployer
        commonAddresses,
        { gasLimit: 3000000 }
      );
      console.log("✅ Strategy Initialized");

      // Initialize vault
      console.log("\n⚙️  Initializing Vault...");
      await vault.initialize(
        strategy.address,
        "Beefy HBARX Bonzo Leveraged Final Test",
        "bvHBARX-BONZO-LEV-FINAL",
        0, // Performance fee
        true, // isHederaToken
        { gasLimit: 4000000 }
      );
      console.log("✅ Vault Initialized");
    } else {
      console.log("\n🔗 Using Existing Deployed Contracts...");
      console.log("  - Vault Address:", EXISTING_VAULT_ADDRESS);
      console.log("  - Strategy Address:", EXISTING_STRATEGY_ADDRESS);
      
      vault = (await ethers.getContractAt("BonzoVaultV7", EXISTING_VAULT_ADDRESS)) as BonzoVaultV7;
      strategy = (await ethers.getContractAt("BonzoHBARXLevergedLiqStaking", EXISTING_STRATEGY_ADDRESS)) as BonzoHBARXLevergedLiqStaking;
      vaultAddress = EXISTING_VAULT_ADDRESS;
      
      console.log("✅ Connected to existing contracts");
    }

    // Get want token
    want = (await ethers.getContractAt("IERC20Upgradeable", HBARX_TOKEN_ADDRESS)) as IERC20Upgradeable;

    console.log("\n========================================");
    console.log("✅ Setup Complete - Ready for Tests");
    console.log("========================================\n");
  });

  after(async () => {
    console.log("\n========================================");
    console.log("📊 Final Strategy Balances");
    console.log("========================================");
    
    const aToken = await ethers.getContractAt("IERC20Upgradeable", AHBARX_TOKEN_ADDRESS);
    const debtToken = await ethers.getContractAt("IERC20Upgradeable", DEBT_TOKEN_ADDRESS);
    
    console.log("  - aToken Balance:", (await aToken.balanceOf(strategy.address)).toString());
    console.log("  - Debt Token Balance:", (await debtToken.balanceOf(strategy.address)).toString());
    console.log("========================================\n");
  });

  describe.skip("💰 Deposit Functionality", () => {
    it("should successfully deposit HBARX into vault", async function () {
      console.log("\n📥 Testing Deposit...");
      console.log("────────────────────────────────────────");

      const userBalance = await want.balanceOf(deployer.address);
      console.log("👤 User HBARX Balance:", userBalance.toString());

      if (userBalance.eq(0)) {
        console.log("⚠️  No HBARX tokens available - skipping test");
        this.skip();
        return;
      }

      const depositAmount = "300000000"; // 3 HBARX (8 decimals)
      console.log("💵 Deposit Amount:", depositAmount);

      // Approve vault
      console.log("\n📝 Approving vault...");
      const allowance = await want.allowance(deployer.address, vault.address);
      if (allowance.lt(depositAmount)) {
        const approveTx = await want.approve(vault.address, depositAmount, { gasLimit: 1000000 });
        await approveTx.wait();
        console.log("✅ Vault approved");
      }

      // Get initial balances
      const initialVaultShares = await vault.balanceOf(deployer.address);
      const initialStrategyBalance = await strategy.balanceOf();
      console.log("\n📊 Before Deposit:");
      console.log("  - User Shares:", initialVaultShares.toString());
      console.log("  - Strategy Balance:", initialStrategyBalance.toString());

      // Perform deposit
      console.log("\n🔄 Executing deposit...");
      const depositTx = await vault.deposit(depositAmount, { gasLimit: 6000000 });
      const depositReceipt = await depositTx.wait();
      console.log("✅ Deposit successful! TX:", depositReceipt.transactionHash);

      // Get final balances
      const finalVaultShares = await vault.balanceOf(deployer.address);
      const finalStrategyBalance = await strategy.balanceOf();
      console.log("\n📊 After Deposit:");
      console.log("  - User Shares:", finalVaultShares.toString());
      console.log("  - Strategy Balance:", finalStrategyBalance.toString());

      // Assertions
      expect(finalVaultShares).to.be.gt(initialVaultShares);
      expect(finalStrategyBalance).to.be.gt(initialStrategyBalance);
      
      console.log("\n✅ Deposit test passed!");
      console.log("────────────────────────────────────────");
    });
  });

  describe("💸 Withdrawal Functionality", () => {
    it("should successfully withdraw HBARX from vault", async function () {
      console.log("\n📤 Testing Withdrawal...");
      console.log("────────────────────────────────────────");

      let userShares = await vault.balanceOf(deployer.address);
      console.log("👤 User Vault Shares:", userShares.toString());

      // If no shares, make a deposit first
      if (userShares.eq(0)) {
        console.log("\n⚠️  No shares available - making deposit first...");
        const userBalance = await want.balanceOf(deployer.address);
        
        if (userBalance.eq(0)) {
          console.log("❌ No HBARX tokens available - skipping test");
          this.skip();
          return;
        }

        const depositAmount = "1000000000";
        const allowance = await want.allowance(deployer.address, vault.address);
        if (allowance.lt(depositAmount)) {
          await (await want.approve(vault.address, depositAmount, { gasLimit: 1000000 })).wait();
        }
        await (await vault.deposit(depositAmount, { gasLimit: 5000000 })).wait();
        userShares = await vault.balanceOf(deployer.address);
        console.log("✅ Deposit complete. User Shares:", userShares.toString());
      }

      // Get initial balances
      const initialWantBalance = await want.balanceOf(deployer.address);
      const initialStrategyBalance = await strategy.balanceOf();
      console.log("\n📊 Before Withdrawal:");
      console.log("  - User HBARX Balance:", initialWantBalance.toString());
      console.log("  - User Shares:", userShares.toString());
      console.log("  - Strategy Balance:", initialStrategyBalance.toString());

      // Perform withdrawal
      console.log("\n🔄 Executing withdrawal of 50% of shares...");
      const withdrawTx = await vault.withdraw(userShares.div(2), { gasLimit: 6000000 });
      const withdrawReceipt = await withdrawTx.wait();
      console.log("✅ Withdrawal successful! TX:", withdrawReceipt.transactionHash);

      // Get final balances
      const finalWantBalance = await want.balanceOf(deployer.address);
      const finalVaultShares = await vault.balanceOf(deployer.address);
      const finalStrategyBalance = await strategy.balanceOf();
      console.log("\n📊 After Withdrawal:");
      console.log("  - User HBARX Balance:", finalWantBalance.toString());
      console.log("  - User Shares:", finalVaultShares.toString());
      console.log("  - Strategy Balance:", finalStrategyBalance.toString());

      // Assertions
      expect(finalWantBalance).to.be.gt(initialWantBalance);
      expect(finalStrategyBalance).to.be.lt(initialStrategyBalance);

      //withdraw remaining shares
      const initialWantBalanceAfter = await want.balanceOf(deployer.address);
      const initialStrategyBalanceAfter = await strategy.balanceOf();
      console.log("\n📊 Before Final Withdrawal:");
      console.log("  - User HBARX Balance:", initialWantBalanceAfter.toString());
      console.log("  - User Shares:", userShares.toString());
      console.log("  - Strategy Balance:", initialStrategyBalanceAfter.toString());

      console.log("\n🔄 Executing withdrawal of remaining shares...");
      const remainingShares = await vault.balanceOf(deployer.address);
      const withdrawTxRemaining = await vault.withdraw(remainingShares, { gasLimit: 6000000 });
      const withdrawReceiptRemaining = await withdrawTxRemaining.wait();
      console.log("✅ Withdrawal successful! TX:", withdrawReceiptRemaining.transactionHash);

      const finalWantBalanceAfter = await want.balanceOf(deployer.address);
      const finalStrategyBalanceAfter = await strategy.balanceOf();
      const finalVaultSharesAfter = await vault.balanceOf(deployer.address);
      console.log("\n📊 After Final Withdrawal:");
      console.log("  - User HBARX Balance:", finalWantBalanceAfter.toString());
      console.log("  - User Shares:", finalVaultSharesAfter.toString());
      console.log("  - Strategy Balance:", finalStrategyBalanceAfter.toString());

      // Assertions
      expect(finalWantBalanceAfter).to.be.gt(initialWantBalanceAfter);
      expect(finalVaultSharesAfter).to.be.eq(0);
      expect(finalStrategyBalanceAfter).to.be.lt(initialStrategyBalanceAfter);

      console.log("\n✅ Withdrawal test passed!");
      console.log("────────────────────────────────────────");
    });
  });

  describe("🌾 Harvest Functionality", () => {
    it("should successfully harvest rewards", async function () {
      console.log("\n🌾 Testing Harvest...");
      console.log("────────────────────────────────────────");

      // Get initial state
      const initialBalance = await strategy.balanceOf();
      const initialLastHarvest = await strategy.lastHarvest();
      console.log("\n📊 Before Harvest:");
      console.log("  - Strategy Balance:", initialBalance.toString());
      console.log("  - Last Harvest Timestamp:", initialLastHarvest.toString());

      // Call harvest
      console.log("\n🔄 Executing harvest...");
      const harvestTx = await strategy["harvest()"]({ gasLimit: 5000000 });
      const harvestReceipt = await harvestTx.wait();
      console.log("✅ Harvest successful! TX:", harvestReceipt.transactionHash);

      // Get final state
      const finalBalance = await strategy.balanceOf();
      const finalLastHarvest = await strategy.lastHarvest();
      console.log("\n📊 After Harvest:");
      console.log("  - Strategy Balance:", finalBalance.toString());
      console.log("  - Last Harvest Timestamp:", finalLastHarvest.toString());

      // Assertions
      expect(harvestReceipt.status).to.be.eq(1);
      expect(finalLastHarvest).to.be.gte(initialLastHarvest);
      
      console.log("\n✅ Harvest test passed!");
      console.log("────────────────────────────────────────");
    });
  });

  describe.skip("📊 Strategy Info", () => {
    it("should display strategy configuration", async function () {
      console.log("\n⚙️  Strategy Configuration:");
      console.log("────────────────────────────────────────");

      const maxBorrowable = await strategy.maxBorrowable();
      const slippageTolerance = await strategy.slippageTolerance();
      const maxLoops = await strategy.maxLoops();
      const wantToken = await strategy.want();
      const borrowToken = await strategy.borrowToken();

      console.log("  - Max Borrowable:", maxBorrowable.toString(), "(basis points)");
      console.log("  - Slippage Tolerance:", slippageTolerance.toString(), "(basis points)");
      console.log("  - Max Loops:", maxLoops.toString());
      console.log("  - Want Token:", wantToken);
      console.log("  - Borrow Token:", borrowToken);

      expect(maxBorrowable).to.be.eq(3000);
      expect(slippageTolerance).to.be.eq(200);
      
      console.log("\n✅ Configuration verified!");
      console.log("────────────────────────────────────────");
    });
  });
});

