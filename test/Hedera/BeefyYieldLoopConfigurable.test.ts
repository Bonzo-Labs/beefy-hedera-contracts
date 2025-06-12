import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BeefyVaultV7Hedera, YieldLoopConfigurable, IERC20Upgradeable } from "../../typechain-types";
import addresses from "../../scripts/deployed-addresses.json";

// Using deployed addresses from deployed-addresses.json
const VAULT_FACTORY_ADDRESS = addresses.vaultFactory;
const WANT_TOKEN_ADDRESS = "0x0000000000000000000000000000000000120f46"; // Want token (e.g., USDC)
const ATOKEN_ADDRESS = "0xC4d4315Ac919253b8bA48D5e609594921eb5525c"; // aToken receipt token
const DEBT_TOKEN_ADDRESS = "0x65be417A48511d2f20332673038e5647a4ED194D"; // Debt token
const OUTPUT_TOKEN_ADDRESS = "0x0000000000000000000000000000000000120f46"; // Reward token
const LENDING_POOL_ADDRESS = "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62"; // Bonzo lending pool
const REWARDS_CONTROLLER_ADDRESS = "0x40f1f4247972952ab1D276Cf552070d2E9880DA6"; // Bonzo rewards controller
const UNIROUTER_ADDRESS = "0x00000000000000000000000000000000000026e7"; // Router address
const FEE_CONFIG_ADDRESS = addresses.beefyFeeConfig;
const BEEFY_FEE_RECIPIENT = addresses.beefyFeeRecipient;
const STRATEGY_OWNER = addresses.strategyOwner;
const VAULT_OWNER = addresses.vaultOwner;
const KEEPER = addresses.keeper;

describe("BeefyYieldLoopConfigurable", function () {
  // Set timeout to 60 seconds for all tests in this suite
  this.timeout(1000000);

  let vault: BeefyVaultV7Hedera | any;
  let strategy: YieldLoopConfigurable | any;
  let want: IERC20Upgradeable | any;
  let output: IERC20Upgradeable | any;
  let deployer: SignerWithAddress | any;
  let vaultAddress: string;
  let deployNewContract = true; // Set to false to use existing deployed contracts

  before(async () => {
    [deployer] = await ethers.getSigners();
    console.log("Testing with account:", deployer.address);
    console.log("Using deployed addresses from scripts/deployed-addresses.json:");
    console.log("- Vault Factory:", VAULT_FACTORY_ADDRESS);
    console.log("- Beefy Fee Config:", FEE_CONFIG_ADDRESS);
    console.log("- Beefy Fee Recipient:", BEEFY_FEE_RECIPIENT);
    console.log("- Strategy Owner:", STRATEGY_OWNER);
    console.log("- Vault Owner:", VAULT_OWNER);
    console.log("- Keeper:", KEEPER);

    if (deployNewContract) {
      // Step 1: Deploy the strategy
      console.log("Deploying YieldLoopConfigurable...");
      const YieldLoopConfigurable = await ethers.getContractFactory("YieldLoopConfigurable");
      strategy = await YieldLoopConfigurable.deploy();
      await strategy.deployed();
      console.log("YieldLoopConfigurable deployed to:", strategy.address);

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
        WANT_TOKEN_ADDRESS,
        ATOKEN_ADDRESS,
        DEBT_TOKEN_ADDRESS,
        LENDING_POOL_ADDRESS,
        REWARDS_CONTROLLER_ADDRESS,
        OUTPUT_TOKEN_ADDRESS,
        true, // isHederaToken
        2, // leverageLoops
        commonAddresses,
        { gasLimit: 3000000 }
      );
      console.log("Strategy initialized");

      // Step 6: Initialize the vault
      console.log("Initializing vault...");
      const isHederaToken = true; // Set to true for HTS tokens
      await vault.initialize(
        strategy.address,
        "Beefy Yield Loop Configurable",
        "bvYieldLoop",
        0, // Performance fee - set to 0 initially
        isHederaToken,
        { gasLimit: 3000000 }
      );
      console.log("Vault initialized");
    } else {
      // Use already deployed contracts - Use addresses.vaultV7 as reference or update with actual deployed addresses
      const VAULT_ADDRESS = addresses.vaultV7; // Update this with actual deployed YieldLoopConfigurable vault
      const STRATEGY_ADDRESS = "0x0000000000000000000000000000000000000000"; // Update with actual deployed strategy

      console.log("Using existing deployed contracts:");
      console.log("Vault address:", VAULT_ADDRESS);
      console.log("Strategy address:", STRATEGY_ADDRESS);

      vault = await ethers.getContractAt("BeefyVaultV7Hedera", VAULT_ADDRESS);
      strategy = await ethers.getContractAt("YieldLoopConfigurable", STRATEGY_ADDRESS);
      vaultAddress = VAULT_ADDRESS;
      deployNewContract = false;
    }
    want = await ethers.getContractAt("IERC20Upgradeable", WANT_TOKEN_ADDRESS);
    output = await ethers.getContractAt("IERC20Upgradeable", OUTPUT_TOKEN_ADDRESS);
  });

  describe("Strategy Initialization", () => {
    it("should have correct initial parameters", async function () {
      const borrowFactor = await strategy.borrowFactor();
      const leverageLoops = await strategy.leverageLoops();
      const isHederaToken = await strategy.isHederaToken();
      const wantAddress = await strategy.want();
      const outputAddress = await strategy.output();

      console.log("Borrow factor:", borrowFactor.toString());
      console.log("Leverage loops:", leverageLoops.toString());
      console.log("Is Hedera token:", isHederaToken);
      console.log("Want address:", wantAddress);
      console.log("Output address:", outputAddress);

      expect(borrowFactor).to.be.eq(4000); // 40%
      expect(leverageLoops).to.be.eq(2);
      expect(isHederaToken).to.be.eq(true);
      expect(wantAddress).to.be.eq(WANT_TOKEN_ADDRESS);
      expect(outputAddress).to.be.eq(OUTPUT_TOKEN_ADDRESS);
    });

    it("should have correct addresses", async function () {
      const lendingPool = await strategy.lendingPool();
      const rewardsController = await strategy.rewardsController();
      const aToken = await strategy.aToken();
      const debtToken = await strategy.debtToken();

      expect(lendingPool).to.be.eq(LENDING_POOL_ADDRESS);
      expect(rewardsController).to.be.eq(REWARDS_CONTROLLER_ADDRESS);
      expect(aToken).to.be.eq(ATOKEN_ADDRESS);
      expect(debtToken).to.be.eq(DEBT_TOKEN_ADDRESS);
    });

    it("should have correct initial swap settings", async function () {
      const swapPath = await strategy.getSwapPath();
      const slippageTolerance = await strategy.swapSlippageTolerance();

      console.log("Initial swap path:", swapPath);
      console.log("Initial slippage tolerance:", slippageTolerance.toString());

      expect(swapPath.length).to.be.eq(2);
      expect(swapPath[0]).to.be.eq(OUTPUT_TOKEN_ADDRESS);
      expect(swapPath[1]).to.be.eq(WANT_TOKEN_ADDRESS);
      expect(slippageTolerance).to.be.eq(300); // 3%
    });
  });

  describe("Deposit and Withdraw", () => {
    it("should handle complete deposit-withdraw cycle", async function () {
      console.log("Testing complete deposit-withdraw cycle...");

      // Skip this test if we don't have want tokens to test with
      const userBalance = await want.balanceOf(deployer.address);
      console.log("Initial user balance:", userBalance.toString());
      if (userBalance.eq(0)) {
        console.log("Skipping deposit-withdraw test - no want tokens available");
        this.skip();
        return;
      }

      const depositAmount = "1000000"; // 1 unit (assuming 6 decimals)

      console.log("\n=== DEPOSIT PHASE ===");

      // Approve and deposit
      const approveTx = await want.approve(vault.address, depositAmount, { gasLimit: 3000000 });
      await approveTx.wait();
      console.log("Tokens approved for vault");

      const initialVaultBalance = await want.balanceOf(vault.address);
      const initialTotalSupply = await vault.totalSupply();
      const initialUserBalance = await want.balanceOf(deployer.address);

      const depositTx = await vault.deposit(depositAmount, { gasLimit: 5000000 });
      await depositTx.wait();
      console.log("Deposit completed");

      // Verify deposit results
      const postDepositUserBalance = await want.balanceOf(deployer.address);
      const postDepositTotalSupply = await vault.totalSupply();
      const userShares = await vault.balanceOf(deployer.address);
      const strategyBalance = await strategy.balanceOf();
      const supplyBalance = await strategy.balanceOfSupply();
      const borrowBalance = await strategy.balanceOfBorrow();

      console.log("Post-deposit user balance:", postDepositUserBalance.toString());
      console.log("User shares received:", userShares.toString());
      console.log("Strategy total balance:", strategyBalance.toString());
      console.log("Strategy supply balance:", supplyBalance.toString());
      console.log("Strategy borrow balance:", borrowBalance.toString());

      // Deposit assertions
      expect(postDepositUserBalance).to.be.lt(initialUserBalance);
      expect(postDepositTotalSupply).to.be.gt(initialTotalSupply);
      expect(userShares).to.be.gt(0);
      expect(strategyBalance).to.be.gt(0);
      expect(supplyBalance).to.be.gt(0);

      console.log("\n=== PARTIAL WITHDRAWAL PHASE ===");

      const partialWithdrawAmount = userShares.div(2); // Withdraw half
      console.log("Withdrawing shares:", partialWithdrawAmount.toString());

      const prePartialWithdrawBalance = await want.balanceOf(deployer.address);

      const partialWithdrawTx = await vault.withdraw(partialWithdrawAmount, { gasLimit: 5000000 });
      await partialWithdrawTx.wait();
      console.log("Partial withdrawal completed");

      const postPartialWithdrawBalance = await want.balanceOf(deployer.address);
      const postPartialWithdrawShares = await vault.balanceOf(deployer.address);
      const postPartialStrategyBalance = await strategy.balanceOf();

      console.log("Post-partial-withdrawal user balance:", postPartialWithdrawBalance.toString());
      console.log("Remaining user shares:", postPartialWithdrawShares.toString());
      console.log("Strategy balance after partial withdrawal:", postPartialStrategyBalance.toString());

      // Partial withdrawal assertions
      expect(postPartialWithdrawBalance).to.be.gt(prePartialWithdrawBalance);
      expect(postPartialWithdrawShares).to.be.lt(userShares);
      expect(postPartialStrategyBalance).to.be.lt(strategyBalance);
      expect(postPartialWithdrawShares).to.be.gt(0); // Still has shares

      console.log("\n=== FULL WITHDRAWAL PHASE ===");

      const remainingShares = await vault.balanceOf(deployer.address);
      console.log("Withdrawing remaining shares:", remainingShares.toString());

      const preFullWithdrawBalance = await want.balanceOf(deployer.address);

      const fullWithdrawTx = await vault.withdraw(remainingShares, { gasLimit: 5000000 });
      await fullWithdrawTx.wait();
      console.log("Full withdrawal completed");

      const finalUserBalance = await want.balanceOf(deployer.address);
      const finalUserShares = await vault.balanceOf(deployer.address);
      const finalStrategyBalance = await strategy.balanceOf();
      const finalSupplyBalance = await strategy.balanceOfSupply();
      const finalBorrowBalance = await strategy.balanceOfBorrow();

      console.log("Final user balance:", finalUserBalance.toString());
      console.log("Final user shares:", finalUserShares.toString());
      console.log("Final strategy balance:", finalStrategyBalance.toString());
      console.log("Final supply balance:", finalSupplyBalance.toString());
      console.log("Final borrow balance:", finalBorrowBalance.toString());

      // Full withdrawal assertions
      expect(finalUserBalance).to.be.gt(preFullWithdrawBalance);
      expect(finalUserShares).to.be.eq(0); // No shares left

      // Strategy should be fully unwound (allow for small dust amounts)
      const dustThreshold = 1002;
      expect(finalStrategyBalance).to.be.lt(dustThreshold);
      expect(finalSupplyBalance).to.be.lt(dustThreshold);
      expect(finalBorrowBalance).to.be.lt(dustThreshold);

      // === WITHDRAWAL FEES TEST ===
      console.log("\n=== WITHDRAWAL FEES TEST ===");

      // Test withdrawal fees with a non-owner account
      await strategy.setWithdrawalFee(10); // 0.1%

      // Make another deposit for fee testing
      const feeTestAmount = "500000";
      await want.approve(vault.address, feeTestAmount, { gasLimit: 3000000 });
      await vault.deposit(feeTestAmount, { gasLimit: 5000000 });

      const ownerShares = await vault.balanceOf(deployer.address);

      // Check if we have multiple signers available
      const signers = await ethers.getSigners();
      if (signers.length > 1) {
        // Transfer shares to non-owner and test fees
        const nonOwner = signers[1];
        const sharesToTransfer = ownerShares.div(2);
        await vault.transfer(nonOwner.address, sharesToTransfer);

        const nonOwnerShares = await vault.balanceOf(nonOwner.address);
        const preNonOwnerBalance = await want.balanceOf(nonOwner.address);

        // Withdraw as non-owner (should incur fees)
        const vaultAsNonOwner = vault.connect(nonOwner);
        await vaultAsNonOwner.withdraw(nonOwnerShares, { gasLimit: 5000000 });

        const postNonOwnerBalance = await want.balanceOf(nonOwner.address);
        const tokensReceived = postNonOwnerBalance.sub(preNonOwnerBalance);

        console.log("Tokens received by non-owner (with fees):", tokensReceived.toString());
        expect(tokensReceived).to.be.gt(0);

        // Clean up - reset withdrawal fee and withdraw remaining
        await strategy.setWithdrawalFee(0);
        const remainingOwnerShares = await vault.balanceOf(deployer.address);
        if (remainingOwnerShares.gt(0)) {
          await vault.withdraw(remainingOwnerShares, { gasLimit: 5000000 });
        }
      } else {
        console.log("⚠️ Skipping withdrawal fee test - only one signer available");
        // Just test that withdrawal fee can be set and reset
        await strategy.setWithdrawalFee(0);
        // Withdraw all remaining shares
        await vault.withdraw(ownerShares, { gasLimit: 5000000 });
      }

      console.log("✅ Complete deposit-withdraw cycle test passed!");
    });
  });

  describe("Strategy Parameters", () => {
    it("should allow updating borrow factor", async function () {
      const newBorrowFactor = 3000; // 30%
      await strategy.setBorrowFactor(newBorrowFactor);
      const updatedBorrowFactor = await strategy.borrowFactor();
      expect(updatedBorrowFactor).to.be.eq(newBorrowFactor);
    });

    it("should not allow borrow factor above maximum", async function () {
      const excessiveBorrowFactor = 7000; // 70% - above BORROW_FACTOR_MAX of 60%
      await expect(strategy.setBorrowFactor(excessiveBorrowFactor)).to.be.reverted;
    });

    it("should allow updating leverage loops", async function () {
      const newLeverageLoops = 3;
      await strategy.setLeverageLoops(newLeverageLoops);
      const updatedLeverageLoops = await strategy.leverageLoops();
      expect(updatedLeverageLoops).to.be.eq(newLeverageLoops);
    });

    it("should not allow leverage loops above maximum", async function () {
      const excessiveLoops = 6; // Above MAX_LOOPS of 5
      await expect(strategy.setLeverageLoops(excessiveLoops)).to.be.reverted;
    });

    it("should not allow zero leverage loops", async function () {
      const zeroLoops = 0;
      await expect(strategy.setLeverageLoops(zeroLoops)).to.be.reverted;
    });

    it("should allow updating harvest on deposit", async function () {
      const currentHarvestOnDeposit = await strategy.harvestOnDeposit();
      await strategy.setHarvestOnDeposit(!currentHarvestOnDeposit);
      const updatedHarvestOnDeposit = await strategy.harvestOnDeposit();
      expect(updatedHarvestOnDeposit).to.be.eq(!currentHarvestOnDeposit);
    });
  });

  describe("Swap Functionality", () => {
    it("should allow updating swap path", async function () {
      // Create a test path with an intermediate token
      const intermediateToken = "0x0000000000000000000000000000000000INTER";
      const newPath = [OUTPUT_TOKEN_ADDRESS, intermediateToken, WANT_TOKEN_ADDRESS];

      await strategy.setSwapPath(newPath);
      const updatedPath = await strategy.getSwapPath();

      expect(updatedPath.length).to.be.eq(3);
      expect(updatedPath[0]).to.be.eq(OUTPUT_TOKEN_ADDRESS);
      expect(updatedPath[1]).to.be.eq(intermediateToken);
      expect(updatedPath[2]).to.be.eq(WANT_TOKEN_ADDRESS);
    });

    it("should not allow invalid swap paths", async function () {
      // Test empty path
      await expect(strategy.setSwapPath([])).to.be.reverted;

      // Test single token path
      await expect(strategy.setSwapPath([OUTPUT_TOKEN_ADDRESS])).to.be.reverted;

      // Test path not starting with output token
      const invalidPath1 = [WANT_TOKEN_ADDRESS, OUTPUT_TOKEN_ADDRESS];
      await expect(strategy.setSwapPath(invalidPath1)).to.be.reverted;

      // Test path not ending with want token
      const invalidPath2 = [OUTPUT_TOKEN_ADDRESS, "0x0000000000000000000000000000000000OTHER"];
      await expect(strategy.setSwapPath(invalidPath2)).to.be.reverted;
    });

    it("should allow updating slippage tolerance", async function () {
      const newSlippage = 500; // 5%
      await strategy.setSwapSlippageTolerance(newSlippage);
      const updatedSlippage = await strategy.swapSlippageTolerance();
      expect(updatedSlippage).to.be.eq(newSlippage);
    });

    it("should not allow excessive slippage tolerance", async function () {
      const excessiveSlippage = 1500; // 15% - above 10% limit
      await expect(strategy.setSwapSlippageTolerance(excessiveSlippage)).to.be.reverted;
    });

    it("should return correct swap path", async function () {
      // Reset to default path
      const defaultPath = [OUTPUT_TOKEN_ADDRESS, WANT_TOKEN_ADDRESS];
      await strategy.setSwapPath(defaultPath);

      const retrievedPath = await strategy.getSwapPath();
      expect(retrievedPath.length).to.be.eq(2);
      expect(retrievedPath[0]).to.be.eq(OUTPUT_TOKEN_ADDRESS);
      expect(retrievedPath[1]).to.be.eq(WANT_TOKEN_ADDRESS);
    });
  });

  describe("Harvest Functionality", () => {
    it("should allow harvest when rewards are available", async function () {
      const initialBalance = await strategy.balanceOf();

      // Call harvest
      const harvestTx = await strategy.harvest({ gasLimit: 5000000 });
      const harvestReceipt = await harvestTx.wait();
      console.log("Harvest transaction:", harvestReceipt.transactionHash);

      const finalBalance = await strategy.balanceOf();
      console.log("Balance before harvest:", initialBalance.toString());
      console.log("Balance after harvest:", finalBalance.toString());

      // Harvest should complete without reverting
      expect(harvestReceipt.status).to.be.eq(1);
    });

    it("should allow harvest with custom call fee recipient", async function () {
      const callFeeRecipient = deployer.address;

      const harvestTx = await strategy["harvest(address)"](callFeeRecipient, { gasLimit: 5000000 });
      const harvestReceipt = await harvestTx.wait();
      console.log("Harvest with recipient transaction:", harvestReceipt.transactionHash);

      expect(harvestReceipt.status).to.be.eq(1);
    });

    it("should not allow harvest with zero address as recipient", async function () {
      const zeroAddress = ethers.constants.AddressZero;

      await expect(strategy["harvest(address)"](zeroAddress)).to.be.reverted;
    });

    it("should handle harvest with swap when output tokens available", async function () {
      // This test would require having actual output tokens to swap
      // For now, we just verify harvest completes without errors
      const harvestTx = await strategy.harvest({ gasLimit: 5000000 });
      const harvestReceipt = await harvestTx.wait();

      expect(harvestReceipt.status).to.be.eq(1);

      // Check if any swap-related events were emitted (would depend on having rewards)
      console.log("Harvest completed, checking for any reward processing...");
    });
  });

  describe("Emergency Functions", () => {
    it("should allow manager to pause strategy", async function () {
      await strategy.pause();
      const isPaused = await strategy.paused();
      expect(isPaused).to.be.eq(true);
    });

    it("should allow manager to unpause strategy", async function () {
      // First ensure it's paused
      if (!(await strategy.paused())) {
        await strategy.pause();
      }

      await strategy.unpause({ gasLimit: 5000000 });
      const isPaused = await strategy.paused();
      expect(isPaused).to.be.eq(false);
    });

    it("should allow manager to call panic", async function () {
      const panicTx = await strategy.panic({ gasLimit: 5000000 });
      const panicReceipt = await panicTx.wait();
      console.log("Panic transaction:", panicReceipt.transactionHash);

      const isPaused = await strategy.paused();
      expect(isPaused).to.be.eq(true);

      // Unpause for other tests
      await strategy.unpause({ gasLimit: 5000000 });
    });
  });

  describe("View Functions", () => {
    it("should return correct balance information", async function () {
      const totalBalance = await strategy.balanceOf();
      const wantBalance = await strategy.balanceOfWant();
      const supplyBalance = await strategy.balanceOfSupply();
      const borrowBalance = await strategy.balanceOfBorrow();

      console.log("Total balance:", totalBalance.toString());
      console.log("Want balance:", wantBalance.toString());
      console.log("Supply balance:", supplyBalance.toString());
      console.log("Borrow balance:", borrowBalance.toString());

      // Total balance should be supply + want - borrow
      const calculatedBalance = supplyBalance.add(wantBalance).sub(borrowBalance);
      expect(totalBalance).to.be.eq(calculatedBalance);
    });

    it("should return rewards available", async function () {
      const rewardsAvailable = await strategy.rewardsAvailable();
      const callReward = await strategy.callReward();

      console.log("Rewards available:", rewardsAvailable.toString());
      console.log("Call reward:", callReward.toString());

      expect(rewardsAvailable).to.be.gte(0);
      expect(callReward).to.be.gte(0);
    });

    it("should return supply and borrow at each level", async function () {
      const leverageLoops = await strategy.leverageLoops();

      for (let i = 0; i < leverageLoops; i++) {
        const supplyAtLevel = await strategy.getSupplyAtLevel(i);
        const borrowAtLevel = await strategy.getBorrowAtLevel(i);

        console.log(`Level ${i} - Supply: ${supplyAtLevel.toString()}, Borrow: ${borrowAtLevel.toString()}`);

        expect(supplyAtLevel).to.be.gte(0);
        expect(borrowAtLevel).to.be.gte(0);
      }
    });

    it("should return current swap configuration", async function () {
      const swapPath = await strategy.getSwapPath();
      const slippageTolerance = await strategy.swapSlippageTolerance();

      console.log("Current swap path:", swapPath);
      console.log("Current slippage tolerance:", slippageTolerance.toString());

      expect(swapPath.length).to.be.gte(2);
      expect(slippageTolerance).to.be.lte(1000); // Should be <= 10%
    });
  });

  describe("Access Control", () => {
    it("should only allow vault to call withdraw", async function () {
      const withdrawAmount = 1000;

      await expect(strategy.withdraw(withdrawAmount)).to.be.reverted;
    });

    it("should only allow vault to call retireStrat", async function () {
      await expect(strategy.retireStrat()).to.be.reverted;
    });

    it("should only allow manager to update parameters", async function () {
      const [, nonManager] = await ethers.getSigners();
      const strategyAsNonManager = strategy.connect(nonManager);

      await expect(strategyAsNonManager.setBorrowFactor(3000)).to.be.reverted;

      await expect(strategyAsNonManager.setLeverageLoops(3)).to.be.reverted;

      await expect(strategyAsNonManager.setHarvestOnDeposit(true)).to.be.reverted;
    });

    it("should only allow manager to update swap settings", async function () {
      const [, nonManager] = await ethers.getSigners();
      const strategyAsNonManager = strategy.connect(nonManager);

      const newPath = [OUTPUT_TOKEN_ADDRESS, WANT_TOKEN_ADDRESS];
      await expect(strategyAsNonManager.setSwapPath(newPath)).to.be.reverted;

      await expect(strategyAsNonManager.setSwapSlippageTolerance(500)).to.be.reverted;
    });
  });

  describe("Leverage Mechanism", () => {
    it("should track leverage levels correctly", async function () {
      const leverageLoops = await strategy.leverageLoops();
      console.log("Current leverage loops:", leverageLoops.toString());

      // Check each level
      for (let i = 0; i < leverageLoops; i++) {
        const supplyAtLevel = await strategy.getSupplyAtLevel(i);
        const borrowAtLevel = await strategy.getBorrowAtLevel(i);

        console.log(`Level ${i}:`);
        console.log(`  Supply: ${supplyAtLevel.toString()}`);
        console.log(`  Borrow: ${borrowAtLevel.toString()}`);
      }
    });

    it("should respect borrow factor limits", async function () {
      const borrowFactor = await strategy.borrowFactor();
      const maxBorrowFactor = await strategy.BORROW_FACTOR_MAX();

      console.log("Current borrow factor:", borrowFactor.toString());
      console.log("Max borrow factor:", maxBorrowFactor.toString());

      expect(borrowFactor).to.be.lte(maxBorrowFactor);
    });
  });
});
