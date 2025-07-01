import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BeefyVaultV7Hedera, BonzoSAUCELevergedLiqStaking, IERC20Upgradeable } from "../../typechain-types";
//*******************SET CHAIN TYPE HERE*******************
const CHAIN_TYPE = process.env.CHAIN_TYPE;
//*******************SET CHAIN TYPE HERE*******************

let addresses,
  XSAUCE_TOKEN_ADDRESS: string,
  SAUCE_TOKEN_ADDRESS: string,
  AXSAUCE_TOKEN_ADDRESS: string,
  DEBT_TOKEN_ADDRESS: string,
  LENDING_POOL_ADDRESS: string,
  REWARDS_CONTROLLER_ADDRESS: string,
  STAKING_POOL_ADDRESS: string,
  UNIROUTER_ADDRESS: string;
let nonManagerPK: string;

if (CHAIN_TYPE === "testnet") {
  addresses = require("../../scripts/deployed-addresses.json");
  XSAUCE_TOKEN_ADDRESS = "0x00000000000000000000000000000000001647e8"; // xSAUCE token
  SAUCE_TOKEN_ADDRESS = "0x00000000000000000000000000000000000b2ad5"; // SAUCE token
  AXSAUCE_TOKEN_ADDRESS = "0xEc9CEF1167b4673726B1e5f5A978150e63cDf23b"; // axSAUCE token
  DEBT_TOKEN_ADDRESS = "0x736c5dbB8ADC643f04c1e13a9C25f28d3D4f0503"; // debtSAUCE token
  LENDING_POOL_ADDRESS = "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62"; // Bonzo lending pool
  REWARDS_CONTROLLER_ADDRESS = "0x40f1f4247972952ab1D276Cf552070d2E9880DA6"; // Bonzo rewards controller
  STAKING_POOL_ADDRESS = "0x00000000000000000000000000000000001647e7"; // SaucerSwap staking pool
  UNIROUTER_ADDRESS = "0x00000000000000000000000000000000000026e7"; // Router address
  nonManagerPK = process.env.NON_MANAGER_PK!;
} else if (CHAIN_TYPE === "mainnet") {
  addresses = require("../../scripts/deployed-addresses-mainnet.json");
  XSAUCE_TOKEN_ADDRESS = "0x00000000000000000000000000000000001647e8"; // xSAUCE token mainnet
  SAUCE_TOKEN_ADDRESS = "0x00000000000000000000000000000000000b2ad5"; // SAUCE token mainnet
  AXSAUCE_TOKEN_ADDRESS = "0xEc9CEF1167b4673726B1e5f5A978150e63cDf23b"; // axSAUCE token mainnet
  DEBT_TOKEN_ADDRESS = "0x736c5dbB8ADC643f04c1e13a9C25f28d3D4f0503"; // debtSAUCE token mainnet
  LENDING_POOL_ADDRESS = "0x236897c518996163E7b313aD21D1C9fCC7BA1afc"; // Bonzo lending pool mainnet
  REWARDS_CONTROLLER_ADDRESS = "0x0f3950d2fCbf62a2D79880E4fc251E4CB6625FBC"; // Bonzo rewards controller mainnet
  STAKING_POOL_ADDRESS = "0x00000000000000000000000000000000001647e7"; // SaucerSwap staking pool mainnet
  UNIROUTER_ADDRESS = "0x00000000000000000000000000000000003c437a"; // Router address mainnet
  nonManagerPK = process.env.NON_MANAGER_PK_MAINNET!;
}

// Using deployed addresses from deployed-addresses.json and specific Hedera contract addresses
const VAULT_FACTORY_ADDRESS = addresses.vaultFactory;
const FEE_CONFIG_ADDRESS = addresses.beefyFeeConfig;
const BEEFY_FEE_RECIPIENT = addresses.beefyFeeRecipient;
const STRATEGY_OWNER = addresses.strategyOwner;
const VAULT_OWNER = addresses.vaultOwner;
const KEEPER = addresses.keeper;

describe("BeefyBonzoSauceXSauceVault", function () {
  // Set timeout to 60 seconds for all tests in this suite
  this.timeout(1000000);

  let vault: BeefyVaultV7Hedera | any;
  let strategy: BonzoSAUCELevergedLiqStaking | any;
  let want: IERC20Upgradeable | any;
  let deployer: SignerWithAddress | any;
  let vaultAddress: string;
  let deployNewContract = false; // Set to false to use existing deployed contracts

  before(async () => {
    [deployer] = await ethers.getSigners();
    console.log("Testing with account:", deployer.address);

    if (deployNewContract) {
      // Step 1: Deploy the strategy
      console.log("Deploying BonzoSAUCELevergedLiqStaking...");
      const BonzoSAUCELevergedLiqStaking = await ethers.getContractFactory("BonzoSAUCELevergedLiqStaking");
      strategy = await BonzoSAUCELevergedLiqStaking.deploy();
      await strategy.deployed();
      console.log("BonzoSAUCELevergedLiqStaking deployed to:", strategy.address);

      // Step 2: Connect to the vault factory
      const vaultFactory = await ethers.getContractAt("BeefyVaultV7FactoryHedera", VAULT_FACTORY_ADDRESS);
      console.log("Connected to vault factory at:", VAULT_FACTORY_ADDRESS);

      // Step 3: Create a new vault using the factory
      console.log("Creating new vault...");
      const tx = await vaultFactory.cloneVault();
      const receipt = await tx.wait();

      // Get the new vault address from the ProxyCreated event
      const proxyCreatedEvent = receipt.events?.find((e: any) => e.event === "ProxyCreated");
      vaultAddress = proxyCreatedEvent?.args?.proxy;
      console.log("New vault deployed to:", vaultAddress);

      // Step 4: Connect to the newly created vault
      vault = await ethers.getContractAt("BeefyVaultV7Hedera", vaultAddress);

      // Step 5: Initialize the strategy
      console.log("Initializing strategy...");
      const commonAddresses = {
        vault: vaultAddress,
        keeper: KEEPER,
        strategist: STRATEGY_OWNER,
        unirouter: UNIROUTER_ADDRESS,
        beefyFeeRecipient: BEEFY_FEE_RECIPIENT,
        beefyFeeConfig: FEE_CONFIG_ADDRESS,
      };

      await strategy.initialize(
        XSAUCE_TOKEN_ADDRESS,
        SAUCE_TOKEN_ADDRESS,
        AXSAUCE_TOKEN_ADDRESS,
        DEBT_TOKEN_ADDRESS,
        LENDING_POOL_ADDRESS,
        REWARDS_CONTROLLER_ADDRESS,
        STAKING_POOL_ADDRESS,
        4000, // maxBorrowable (40%)
        50, // slippageTolerance (0.5%)
        false, // isRewardsAvailable
        true, // isBonzoDeployer
        commonAddresses,
        { gasLimit: 3000000 }
      );
      console.log("Strategy initialized");

      // Step 6: Initialize the vault
      console.log("Initializing vault...");
      const isHederaToken = true; // Set to true for HTS tokens
      await vault.initialize(
        strategy.address,
        "Beefy SAUCE Bonzo Leveraged",
        "bvSAUCE-BONZO-LEV",
        0, // Performance fee - set to 0 initially
        isHederaToken,
        { gasLimit: 3000000 }
      );
      console.log("Vault initialized");
    } else {
      // Use already deployed contract
      const VAULT_ADDRESS = "0x3599b6eB756ca419Da093fb5E9b5F0a7B3e04caa";
      const STRATEGY_ADDRESS = "0x749C817dC2B4E5f6E49f7978f43A21f7D45c7bB0";
      vault = await ethers.getContractAt("BeefyVaultV7Hedera", VAULT_ADDRESS);
      strategy = await ethers.getContractAt("BonzoSAUCELevergedLiqStaking", STRATEGY_ADDRESS);
      vaultAddress = VAULT_ADDRESS;
      console.log("Using existing deployed contracts:");
      console.log("Vault address:", VAULT_ADDRESS);
      console.log("Strategy address:", STRATEGY_ADDRESS);
    }
    want = await ethers.getContractAt("IERC20Upgradeable", XSAUCE_TOKEN_ADDRESS);

    const aToken = await ethers.getContractAt("IERC20Upgradeable", AXSAUCE_TOKEN_ADDRESS);
    const debtToken = await ethers.getContractAt("IERC20Upgradeable", DEBT_TOKEN_ADDRESS);

    const strategyATokenBalance = await aToken.balanceOf(strategy.address);
    const strategyDebtTokenBalance = await debtToken.balanceOf(strategy.address);

    console.log("Strategy aToken balance:", strategyATokenBalance.toString());
    console.log("Strategy debt token balance:", strategyDebtTokenBalance.toString());
  });

  after(async () => {
    const aToken = await ethers.getContractAt("IERC20Upgradeable", AXSAUCE_TOKEN_ADDRESS);
    const debtToken = await ethers.getContractAt("IERC20Upgradeable", DEBT_TOKEN_ADDRESS);

    const strategyATokenBalance = await aToken.balanceOf(strategy.address);
    const strategyDebtTokenBalance = await debtToken.balanceOf(strategy.address);
    console.log("Strategy aToken balance:", strategyATokenBalance.toString());
    console.log("Strategy debt token balance:", strategyDebtTokenBalance.toString());

    const lendingPool = await ethers.getContractAt(
      "contracts/BIFI/interfaces/bonzo/ILendingPool.sol:ILendingPool",
      LENDING_POOL_ADDRESS
    );
    const userAccountData = await lendingPool.getUserAccountData(strategy.address);
    console.log("User Account Data:", {
      totalCollateralBase: userAccountData.totalCollateralETH.toString(),
      totalDebtBase: userAccountData.totalDebtETH.toString(),
      availableBorrowsBase: userAccountData.availableBorrowsETH.toString(),
      currentLiquidationThreshold: userAccountData.currentLiquidationThreshold.toString(),
      ltv: userAccountData.ltv.toString(),
      healthFactor: userAccountData.healthFactor.toString(),
    });
  });

  describe("Strategy Initialization", () => {
    it.skip("should have correct initial parameters", async function () {
      const maxBorrowable = await strategy.getMaxBorrowable();
      const slippageTolerance = await strategy.slippageTolerance();
      const maxLoops = await strategy.getMaxLoops();
      const isRewardsAvailable = await strategy.isRewardsAvailable();
      const isBonzoDeployer = await strategy.isBonzoDeployer();
      const wantToken = await strategy.want();
      const borrowTokenAddr = await strategy.borrowToken();
      const aTokenAddr = await strategy.aToken();
      const debtTokenAddr = await strategy.debtToken();
      const lendingPoolAddr = await strategy.getLendingPool();
      const rewardsControllerAddr = await strategy.getRewardsController();
      const stakingPoolAddr = await strategy.stakingPool();

      console.log("Max borrowable:", maxBorrowable.toString());
      console.log("Slippage tolerance:", slippageTolerance.toString());
      console.log("Max loops:", maxLoops.toString());
      console.log("Is rewards available:", isRewardsAvailable);
      console.log("Is Bonzo deployer:", isBonzoDeployer);
      console.log("Want token:", wantToken);
      console.log("Borrow token:", borrowTokenAddr);
      console.log("aToken:", aTokenAddr);
      console.log("Debt token:", debtTokenAddr);
      console.log("Lending pool:", lendingPoolAddr);
      console.log("Rewards controller:", rewardsControllerAddr);
      console.log("Staking pool:", stakingPoolAddr);

      expect(maxBorrowable).to.be.eq(4000); // 40%
      expect(slippageTolerance).to.be.eq(50); // 0.5%
      expect(maxLoops).to.be.eq(2);
      expect(isRewardsAvailable).to.be.eq(false);
      expect(isBonzoDeployer).to.be.eq(true);
      expect(wantToken).to.be.eq(XSAUCE_TOKEN_ADDRESS);
      // expect(borrowTokenAddr).to.be.eq(SAUCE_TOKEN_ADDRESS);
      expect(aTokenAddr).to.be.eq(AXSAUCE_TOKEN_ADDRESS);
      expect(debtTokenAddr).to.be.eq(DEBT_TOKEN_ADDRESS);
      expect(lendingPoolAddr).to.be.eq(LENDING_POOL_ADDRESS);
      expect(rewardsControllerAddr).to.be.eq(REWARDS_CONTROLLER_ADDRESS);
      expect(stakingPoolAddr).to.be.eq(STAKING_POOL_ADDRESS);
    });

    it.skip("should have correct metadata", async function () {
      const name = await strategy.name();
      const symbol = await strategy.symbol();
      const version = await strategy.version();
      const description = await strategy.description();
      const category = await strategy.category();
      const riskLevel = await strategy.riskLevel();

      console.log("Strategy name:", name);
      console.log("Strategy symbol:", symbol);
      console.log("Strategy version:", version);
      console.log("Strategy description:", description);
      console.log("Strategy category:", category);
      console.log("Strategy risk level:", riskLevel.toString());

      expect(name).to.be.eq("Strategy Bonzo SAUCE Leveraged Liquidity Staking");
      expect(symbol).to.be.eq("strategy-bonzo-sauce-leveraged");
      expect(version).to.be.eq("1.0");
      expect(description).to.be.eq("Strategy for Bonzo SAUCE Leveraged Liquidity Staking");
      expect(category).to.be.eq("Leveraged Staking");
      expect(riskLevel).to.be.eq(3);
    });
  });

  describe("Deposit and Withdraw", () => {
    it("should handle deposit", async function () {
      console.log("Testing deposit functionality...");

      // Skip this test if we don't have xSAUCE tokens to test with
      const userBalance = await want.balanceOf(deployer.address);
      console.log("Initial user balance:", userBalance.toString());
      if (userBalance.eq(0)) {
        console.log("Skipping deposit test - no xSAUCE tokens available");
        this.skip();
        return;
      }

      const depositAmount = "100000"; // 0.1 xSAUCE

      // Approve the vault to spend tokens
      const approveTx = await want.approve(vault.address, depositAmount, { gasLimit: 3000000 });
      await approveTx.wait();
      console.log("Tokens approved for vault");

      // Check initial balances
      const initialUserBalance = await want.balanceOf(deployer.address);
      const initialVaultBalance = await want.balanceOf(vault.address);
      const initialTotalSupply = await vault.totalSupply();
      const initialStrategyBalance = await strategy.balanceOf();

      console.log("Initial user balance:", initialUserBalance.toString());
      console.log("Initial vault balance:", initialVaultBalance.toString());
      console.log("Initial total supply:", initialTotalSupply.toString());
      console.log("Initial strategy balance:", initialStrategyBalance.toString());

      // Perform deposit
      console.log("Depositing...");
      const tx = await vault.deposit(depositAmount, { gasLimit: 5000000 });
      const receipt = await tx.wait();
      console.log("Deposit transaction:", receipt.transactionHash);

      // Check post-deposit balances
      const postDepositUserBalance = await want.balanceOf(deployer.address);
      const postDepositVaultBalance = await want.balanceOf(vault.address);
      const postDepositTotalSupply = await vault.totalSupply();
      const userShares = await vault.balanceOf(deployer.address);
      const postDepositStrategyBalance = await strategy.balanceOf();

      console.log("Post-deposit user balance:", postDepositUserBalance.toString());
      console.log("Post-deposit vault balance:", postDepositVaultBalance.toString());
      console.log("Post-deposit total supply:", postDepositTotalSupply.toString());
      console.log("User shares:", userShares.toString());
      console.log("Post-deposit strategy balance:", postDepositStrategyBalance.toString());

      // Verify deposit
      expect(postDepositUserBalance).to.be.lt(initialUserBalance);
      expect(postDepositTotalSupply).to.be.gt(initialTotalSupply);
      expect(userShares).to.be.gt(0);
      expect(postDepositStrategyBalance).to.be.gt(initialStrategyBalance);

      console.log("✅ Deposit test passed!");
    });

    it("should handle withdrawal", async function () {
      console.log("Testing withdrawal functionality...");

      // Check if user has shares to withdraw
      const userShares = await vault.balanceOf(deployer.address);
      console.log("User shares available:", userShares.toString());

      if (userShares.eq(0)) {
        console.log("No shares available for withdrawal test - need to deposit first");

        // Make a deposit first
        const userBalance = await want.balanceOf(deployer.address);
        if (userBalance.eq(0)) {
          console.log("Skipping withdrawal test - no want tokens available for deposit");
          this.skip();
          return;
        }

        const depositAmount = "100000";
        await want.approve(vault.address, depositAmount, { gasLimit: 3000000 });
        await vault.deposit(depositAmount, { gasLimit: 5000000 });
        console.log("Made initial deposit for withdrawal test");
      }

      const totalUserShares = await vault.balanceOf(deployer.address);
      console.log("Total user shares for withdrawal:", totalUserShares.toString());

      const withdrawAmount = totalUserShares.div(2); // Withdraw half
      console.log("Withdrawing shares:", withdrawAmount.toString());

      const preWithdrawBalance = await want.balanceOf(deployer.address);
      const preWithdrawStrategyBalance = await strategy.balanceOf();

      const withdrawTx = await vault.withdraw(withdrawAmount, { gasLimit: 5000000 });
      await withdrawTx.wait();
      console.log("Withdrawal completed");

      const postWithdrawBalance = await want.balanceOf(deployer.address);
      const postWithdrawShares = await vault.balanceOf(deployer.address);
      const postWithdrawStrategyBalance = await strategy.balanceOf();

      console.log("Post-withdrawal user balance:", postWithdrawBalance.toString());
      console.log("Remaining user shares:", postWithdrawShares.toString());
      console.log("Post-withdrawal strategy balance:", postWithdrawStrategyBalance.toString());

      // Withdrawal assertions
      expect(postWithdrawBalance).to.be.gt(preWithdrawBalance);
      expect(postWithdrawShares).to.be.lt(totalUserShares);
      expect(postWithdrawStrategyBalance).to.be.lt(preWithdrawStrategyBalance);

      console.log("✅ Withdrawal test passed!");
    });
  });

  describe("Strategy Parameters", () => {
    it.skip("should allow updating max borrowable", async function () {
      const currentMaxBorrowable = await strategy.getMaxBorrowable();
      console.log("Current max borrowable:", currentMaxBorrowable.toString());

      const newMaxBorrowable = 1500; // 15%
      await strategy.setMaxBorrowable(newMaxBorrowable);
      const updatedMaxBorrowable = await strategy.getMaxBorrowable();

      console.log("Updated max borrowable:", updatedMaxBorrowable.toString());
      expect(updatedMaxBorrowable).to.be.eq(newMaxBorrowable);

      // Reset to original value
      await strategy.setMaxBorrowable(currentMaxBorrowable);
    });

    it.skip("should not allow excessive max borrowable", async function () {
      const excessiveMaxBorrowable = 10001; // > 100%
      await expect(strategy.setMaxBorrowable(excessiveMaxBorrowable)).to.be.revertedWith("!cap");
    });

    it.skip("should allow updating slippage tolerance", async function () {
      const currentSlippage = await strategy.slippageTolerance();
      console.log("Current slippage tolerance:", currentSlippage.toString());

      const newSlippage = 100; // 1%
      await strategy.setSlippageTolerance(newSlippage);
      const updatedSlippage = await strategy.slippageTolerance();

      console.log("Updated slippage tolerance:", updatedSlippage.toString());
      expect(updatedSlippage).to.be.eq(newSlippage);

      // Reset to original value
      await strategy.setSlippageTolerance(currentSlippage);
    });

    it.skip("should not allow excessive slippage tolerance", async function () {
      const excessiveSlippage = 1000; // 10% > 5% max
      await expect(strategy.setSlippageTolerance(excessiveSlippage)).to.be.revertedWith("Slippage too high");
    });

    it.skip("should allow updating max loops", async function () {
      const currentMaxLoops = await strategy.getMaxLoops();
      console.log("Current max loops:", currentMaxLoops.toString());

      const newMaxLoops = 3;
      await strategy.setMaxLoops(newMaxLoops);
      const updatedMaxLoops = await strategy.getMaxLoops();

      console.log("Updated max loops:", updatedMaxLoops.toString());
      expect(updatedMaxLoops).to.be.eq(newMaxLoops);

      // Reset to original value
      await strategy.setMaxLoops(currentMaxLoops);
    });

    it.skip("should not allow invalid max loops", async function () {
      // Test zero loops
      await expect(strategy.setMaxLoops(0)).to.be.revertedWith("!range");

      // Test excessive loops
      const excessiveLoops = 11;
      await expect(strategy.setMaxLoops(excessiveLoops)).to.be.revertedWith("!range");
    });

    it.skip("should allow updating harvest on deposit", async function () {
      const currentHarvestOnDeposit = await strategy.harvestOnDeposit();
      console.log("Current harvest on deposit:", currentHarvestOnDeposit);

      await strategy.setHarvestOnDeposit(!currentHarvestOnDeposit);
      const updatedHarvestOnDeposit = await strategy.harvestOnDeposit();

      console.log("Updated harvest on deposit:", updatedHarvestOnDeposit);
      expect(updatedHarvestOnDeposit).to.be.eq(!currentHarvestOnDeposit);

      // Reset to original value
      await strategy.setHarvestOnDeposit(currentHarvestOnDeposit);
    });

    it.skip("should allow updating rewards availability", async function () {
      const currentRewardsAvailable = await strategy.isRewardsAvailable();
      console.log("Current rewards available:", currentRewardsAvailable);

      await strategy.setRewardsAvailable(!currentRewardsAvailable);
      const updatedRewardsAvailable = await strategy.isRewardsAvailable();

      console.log("Updated rewards available:", updatedRewardsAvailable);
      expect(updatedRewardsAvailable).to.be.eq(!currentRewardsAvailable);

      // Reset to original value
      await strategy.setRewardsAvailable(currentRewardsAvailable);
    });
  });

  describe("View Functions", () => {
    it.skip("should return correct balance information", async function () {
      const totalBalance = await strategy.balanceOf();
      const wantBalance = await strategy.balanceOfWant();
      const poolBalance = await strategy.balanceOfPool();

      console.log("Total balance:", totalBalance.toString());
      console.log("Want balance:", wantBalance.toString());
      console.log("Pool balance:", poolBalance.toString());

      expect(totalBalance).to.be.gte(0);
      expect(wantBalance).to.be.gte(0);
      expect(poolBalance).to.be.gte(0);
    });

    it.skip("should return correct token addresses", async function () {
      const wantToken = await strategy.want();
      const borrowToken = await strategy.borrowToken();
      const aToken = await strategy.aToken();
      const debtToken = await strategy.debtToken();
      const stakingPool = await strategy.stakingPool();

      console.log("Want token:", wantToken);
      console.log("Borrow token:", borrowToken);
      console.log("aToken:", aToken);
      console.log("Debt token:", debtToken);
      console.log("Staking pool:", stakingPool);

      expect(wantToken).to.be.eq(XSAUCE_TOKEN_ADDRESS);
      expect(borrowToken).to.be.eq(SAUCE_TOKEN_ADDRESS);
      expect(aToken).to.be.eq(AXSAUCE_TOKEN_ADDRESS);
      expect(debtToken).to.be.eq(DEBT_TOKEN_ADDRESS);
      expect(stakingPool).to.be.eq(STAKING_POOL_ADDRESS);
    });

    it.skip("should return correct protocol addresses", async function () {
      const lendingPool = await strategy.getLendingPool();
      const rewardsController = await strategy.getRewardsController();

      console.log("Lending pool:", lendingPool);
      console.log("Rewards controller:", rewardsController);

      expect(lendingPool).to.be.eq(LENDING_POOL_ADDRESS);
      expect(rewardsController).to.be.eq(REWARDS_CONTROLLER_ADDRESS);
    });

    it.skip("should return correct strategy configuration", async function () {
      const maxLoops = await strategy.getMaxLoops();
      const maxBorrowable = await strategy.getMaxBorrowable();
      const slippageTolerance = await strategy.slippageTolerance();
      const harvestOnDeposit = await strategy.harvestOnDeposit();
      const isRewardsAvailable = await strategy.isRewardsAvailable();
      const isBonzoDeployer = await strategy.isBonzoDeployer();
      const lastHarvest = await strategy.lastHarvest();

      console.log("Max loops:", maxLoops.toString());
      console.log("Max borrowable:", maxBorrowable.toString());
      console.log("Slippage tolerance:", slippageTolerance.toString());
      console.log("Harvest on deposit:", harvestOnDeposit);
      console.log("Is rewards available:", isRewardsAvailable);
      console.log("Is Bonzo deployer:", isBonzoDeployer);
      console.log("Last harvest:", lastHarvest.toString());

      expect(maxLoops).to.be.gte(1);
      expect(maxBorrowable).to.be.lte(10000);
      expect(slippageTolerance).to.be.lte(500);
      expect(lastHarvest).to.be.gte(0);
    });
  });

  describe("Harvest Functionality", () => {
    it.skip("should allow harvest", async function () {
      console.log("Testing harvest functionality...");

      const initialBalance = await strategy.balanceOf();
      const initialLastHarvest = await strategy.lastHarvest();

      console.log("Initial strategy balance:", initialBalance.toString());
      console.log("Initial last harvest:", initialLastHarvest.toString());

      // Call harvest
      const harvestTx = await strategy.harvest({ gasLimit: 5000000 });
      const harvestReceipt = await harvestTx.wait();
      console.log("Harvest transaction:", harvestReceipt.transactionHash);

      const finalBalance = await strategy.balanceOf();
      const finalLastHarvest = await strategy.lastHarvest();

      console.log("Final strategy balance:", finalBalance.toString());
      console.log("Final last harvest:", finalLastHarvest.toString());

      // Harvest should complete without reverting
      expect(harvestReceipt.status).to.be.eq(1);
      expect(finalLastHarvest).to.be.gte(initialLastHarvest);
    });
  });

  describe("Emergency Functions", () => {
    it.skip("should allow manager to pause strategy", async function () {
      const initialPaused = await strategy.paused();
      console.log("Initial paused state:", initialPaused);

      await strategy.pause();
      const isPaused = await strategy.paused();
      console.log("Paused state after pause:", isPaused);

      expect(isPaused).to.be.eq(true);

      // Unpause for other tests
      await strategy.unpause();
      const finalPaused = await strategy.paused();
      console.log("Final paused state:", finalPaused);
      expect(finalPaused).to.be.eq(false);
    });

    it.skip("should allow manager to call panic", async function () {
      const initialPaused = await strategy.paused();
      console.log("Initial paused state before panic:", initialPaused);

      const panicTx = await strategy.panic();
      const panicReceipt = await panicTx.wait();
      console.log("Panic transaction:", panicReceipt.transactionHash);

      const isPaused = await strategy.paused();
      console.log("Paused state after panic:", isPaused);
      expect(isPaused).to.be.eq(true);

      // Unpause for other tests
      await strategy.unpause();
    });

    it.skip("should allow manager to unpause strategy", async function () {
      // First ensure it's paused
      if (!(await strategy.paused())) {
        await strategy.pause();
      }

      const pausedBeforeUnpause = await strategy.paused();
      console.log("Paused before unpause:", pausedBeforeUnpause);

      await strategy.unpause();
      const isPaused = await strategy.paused();
      console.log("Paused after unpause:", isPaused);

      expect(isPaused).to.be.eq(false);
    });
  });

  describe("Access Control", () => {
    it.skip("should only allow vault to call withdraw", async function () {
      const withdrawAmount = 1000;
      await expect(strategy.withdraw(withdrawAmount)).to.be.revertedWith("!vault");
    });

    it.skip("should only allow vault to call retireStrat", async function () {
      await expect(strategy.retireStrat()).to.be.revertedWith("!vault");
    });

    it.skip("should only allow manager to update parameters", async function () {
      const signers = await ethers.getSigners();
      if (signers.length > 1) {
        const nonManager = signers[1];
        const strategyAsNonManager = strategy.connect(nonManager);

        await expect(strategyAsNonManager.setMaxBorrowable(2000)).to.be.reverted;
        await expect(strategyAsNonManager.setMaxLoops(3)).to.be.reverted;
        await expect(strategyAsNonManager.setSlippageTolerance(100)).to.be.reverted;
        await expect(strategyAsNonManager.setHarvestOnDeposit(true)).to.be.reverted;
        await expect(strategyAsNonManager.setRewardsAvailable(true)).to.be.reverted;
      } else {
        console.log("⚠️ Skipping access control test - only one signer available");
        this.skip();
      }
    });

    it.skip("should only allow manager to call emergency functions", async function () {
      const signers = await ethers.getSigners();
      if (signers.length > 1) {
        const nonManager = signers[1];
        const strategyAsNonManager = strategy.connect(nonManager);

        await expect(strategyAsNonManager.pause()).to.be.reverted;
        await expect(strategyAsNonManager.panic()).to.be.reverted;
        await expect(strategyAsNonManager.unpause()).to.be.reverted;
      } else {
        console.log("⚠️ Skipping access control test - only one signer available");
        this.skip();
      }
    });

    it.skip("should only allow authorized addresses to harvest", async function () {
      // Note: The harvest function allows vault, owner, or keeper to call it
      // Since we're using deployer as all roles in tests, this should pass
      const harvestTx = await strategy.harvest({ gasLimit: 5000000 });
      const harvestReceipt = await harvestTx.wait();
      expect(harvestReceipt.status).to.be.eq(1);
    });
  });

  describe("Token Management", () => {
    it.skip("should handle stuck tokens recovery", async function () {
      // This test would require sending some random tokens to the strategy first
      // For now, we just test that the function exists and has proper access control
      const signers = await ethers.getSigners();
      if (signers.length > 1) {
        const nonManager = signers[1];
        const strategyAsNonManager = strategy.connect(nonManager);

        // Should revert when called by non-manager
        await expect(strategyAsNonManager.inCaseTokensGetStuck(XSAUCE_TOKEN_ADDRESS)).to.be.reverted;
      }

      // Should revert when trying to recover protected tokens
      await expect(strategy.inCaseTokensGetStuck(XSAUCE_TOKEN_ADDRESS)).to.be.revertedWith("!want");
      await expect(strategy.inCaseTokensGetStuck(SAUCE_TOKEN_ADDRESS)).to.be.revertedWith("!borrowToken");
      await expect(strategy.inCaseTokensGetStuck(AXSAUCE_TOKEN_ADDRESS)).to.be.revertedWith("!aToken");
      await expect(strategy.inCaseTokensGetStuck(DEBT_TOKEN_ADDRESS)).to.be.revertedWith("!debtToken");
    });
  });

  describe("Strategy Safety", () => {
    it.skip("should not allow deposit when paused", async function () {
      // Pause the strategy
      await strategy.pause();

      // Try to deposit - should fail
      await expect(strategy.deposit()).to.be.revertedWith("Pausable: paused");

      // Unpause for other tests
      await strategy.unpause();
    });

    it.skip("should not allow withdraw when paused", async function () {
      // Pause the strategy
      await strategy.pause();

      // Try to withdraw - should fail
      await expect(strategy.withdraw(1000)).to.be.revertedWith("Pausable: paused");

      // Unpause for other tests
      await strategy.unpause();
    });

    it.skip("should not allow harvest when paused", async function () {
      // Pause the strategy
      await strategy.pause();

      // Try to harvest - should fail
      await expect(strategy.harvest()).to.be.revertedWith("Pausable: paused");

      // Unpause for other tests
      await strategy.unpause();
    });
  });

  // Keep the original deposit test for compatibility
  describe("Original Deposit Test", () => {
    it.skip("should handle deposits and withdrawals correctly", async function () {
      console.log("sender address", deployer.address);

      // Skip this test if we don't have xSAUCE tokens to test with
      const userBalance = await want.balanceOf(deployer.address);
      console.log("user balance", userBalance.toString());
      if (userBalance.eq(0)) {
        console.log("Skipping deposit/withdraw test - no xSAUCE tokens available");
        this.skip();
        return;
      }

      const depositAmount = "100000"; // 0.1 xSAUCE (assuming 6 decimals)

      // Approve the vault to spend tokens
      const approveTx = await want.approve(vault.address, depositAmount, { gasLimit: 3000000 });
      const approveReceipt = await approveTx.wait();
      console.log("approve transaction", approveReceipt.transactionHash);

      // Check initial balances
      const initialUserBalance = await want.balanceOf(deployer.address);
      const initialVaultBalance = await want.balanceOf(vault.address);
      const initialTotalSupply = await vault.totalSupply();

      console.log("Initial user balance:", initialUserBalance.toString());
      console.log("Initial vault balance:", initialVaultBalance.toString());
      console.log("Initial total supply:", initialTotalSupply.toString());

      // Perform deposit
      console.log("Depositing...");
      const tx = await vault.deposit(depositAmount, { gasLimit: 5000000 });
      const receipt = await tx.wait();
      console.log("Deposit transaction:", receipt.transactionHash);

      const debugFilter = strategy.filters.DebugValues();
      const debugEvents = await strategy.queryFilter(debugFilter, receipt.blockNumber, receipt.blockNumber);

      if (debugEvents.length > 0) {
        const debugEvent = debugEvents[0];
        console.log("Strategy Debug Values:");
        console.log("Collateral Base:", ethers.utils.formatUnits(debugEvent.args.collateralBase, 18));
        console.log("Debt Base:", ethers.utils.formatUnits(debugEvent.args.debtBase, 18));
        console.log("LTV:", debugEvent.args.ltv.toString());
        console.log("SAUCE Price:", ethers.utils.formatUnits(debugEvent.args.saucePrice, 18));
        console.log("Max Borrow Base:", ethers.utils.formatUnits(debugEvent.args.maxBorrowBase, 18));
        console.log("Desired:", ethers.utils.formatUnits(debugEvent.args.desired, 18));
      }

      // Check post-deposit balances
      const postDepositUserBalance = await want.balanceOf(deployer.address);
      const postDepositVaultBalance = await want.balanceOf(vault.address);
      const postDepositTotalSupply = await vault.totalSupply();
      const userShares = await vault.balanceOf(deployer.address);

      console.log("Post-deposit user balance:", postDepositUserBalance.toString());
      console.log("Post-deposit vault balance:", postDepositVaultBalance.toString());
      console.log("Post-deposit total supply:", postDepositTotalSupply.toString());
      console.log("User shares:", userShares.toString());

      // Verify deposit
      expect(postDepositUserBalance).to.be.lt(initialUserBalance);
      expect(postDepositTotalSupply).to.be.gt(initialTotalSupply);
      expect(userShares).to.be.gt(0);

      // Wait for some time to allow for yield generation
      console.log("Waiting for yield generation...");
      await new Promise(resolve => setTimeout(resolve, 30000));

      // Perform withdrawal
      console.log("Withdrawing...");
      const withdrawTx = await vault.withdraw(userShares, { gasLimit: 5000000 });
      const withdrawReceipt = await withdrawTx.wait();
      console.log("Withdraw transaction:", withdrawReceipt.transactionHash);

      // Check post-withdrawal balances
      const postWithdrawUserBalance = await want.balanceOf(deployer.address);
      const postWithdrawVaultBalance = await want.balanceOf(vault.address);
      const postWithdrawTotalSupply = await vault.totalSupply();
      const postWithdrawUserShares = await vault.balanceOf(deployer.address);

      console.log("Post-withdraw user balance:", postWithdrawUserBalance.toString());
      console.log("Post-withdraw vault balance:", postWithdrawVaultBalance.toString());
      console.log("Post-withdraw total supply:", postWithdrawTotalSupply.toString());
      console.log("Post-withdraw user shares:", postWithdrawUserShares.toString());

      // Verify withdrawal
      expect(postWithdrawUserBalance).to.be.gt(postDepositUserBalance);
      expect(postWithdrawTotalSupply).to.be.lt(postDepositTotalSupply);
      expect(postWithdrawUserShares).to.be.eq(0);
    });
  });
});
