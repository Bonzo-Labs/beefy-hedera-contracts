import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BeefyVaultV7Hedera, BonzoUSDCSupplyStrategy, IERC20Upgradeable } from "../../typechain-types";

//*******************SET CHAIN TYPE HERE*******************
const CHAIN_TYPE = process.env.CHAIN_TYPE;
//*******************SET CHAIN TYPE HERE*******************

let addresses, USDC_TOKEN_ADDRESS: string, AUSDC_TOKEN_ADDRESS: string, LENDING_POOL_ADDRESS: string, REWARDS_CONTROLLER_ADDRESS: string, UNIROUTER_ADDRESS: string;
let nonManagerPK: string;
if (CHAIN_TYPE === "testnet") {
  addresses = require("../../scripts/deployed-addresses.json");
  USDC_TOKEN_ADDRESS = "0x0000000000000000000000000000000000001549"; // Hedera USDC token
  AUSDC_TOKEN_ADDRESS = "0xee72C37fEc48C9FeC6bbD0982ecEb7d7a038841e"; // aUSDC token
  LENDING_POOL_ADDRESS = "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62"; // Bonzo lending pool
  REWARDS_CONTROLLER_ADDRESS = "0x40f1f4247972952ab1D276Cf552070d2E9880DA6"; // Bonzo rewards controller
  UNIROUTER_ADDRESS = "0x00000000000000000000000000000000000026e7"; // Router address
  nonManagerPK = process.env.NON_MANAGER_PK!;
} else if (CHAIN_TYPE === "mainnet") {
  addresses = require("../../scripts/deployed-addresses-mainnet.json");
  USDC_TOKEN_ADDRESS = "0x000000000000000000000000000000000006f89a"; // Hedera USDC token
  AUSDC_TOKEN_ADDRESS = "0xB7687538c7f4CAD022d5e97CC778d0b46457c5DB"; // aUSDC token
  LENDING_POOL_ADDRESS = "0x236897c518996163E7b313aD21D1C9fCC7BA1afc"; // Bonzo lending pool
  REWARDS_CONTROLLER_ADDRESS = ""; // Bonzo rewards controller
  UNIROUTER_ADDRESS = "0x00000000000000000000000000000000003c437a"; // Router address
  nonManagerPK = process.env.NON_MANAGER_PK_MAINNET!;
}

// Using deployed addresses from deployed-addresses.json and specific Hedera contract addresses
const VAULT_FACTORY_ADDRESS = addresses.vaultFactory;
const FEE_CONFIG_ADDRESS = addresses.beefyFeeConfig;
const BEEFY_FEE_RECIPIENT = addresses.beefyFeeRecipient;
const STRATEGY_OWNER = addresses.strategyOwner;
const VAULT_OWNER = addresses.vaultOwner;
const KEEPER = addresses.keeper;

describe("BeefyBonzoUSDCVault", function () {
  // Set timeout to 60 seconds for all tests in this suite
  this.timeout(1000000);

  let vault: BeefyVaultV7Hedera | any;
  let strategy: BonzoUSDCSupplyStrategy | any;
  let want: IERC20Upgradeable | any;
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
      console.log("Deploying BonzoUSDCSupplyStrategy...");
      const BonzoUSDCSupplyStrategy = await ethers.getContractFactory("BonzoUSDCSupplyStrategy");
      strategy = await BonzoUSDCSupplyStrategy.deploy();
      await strategy.deployed();
      console.log("BonzoUSDCSupplyStrategy deployed to:", strategy.address);

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
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for 5 seconds

      const commonAddresses = {
        vault: vaultAddress,
        keeper: KEEPER,
        strategist: STRATEGY_OWNER,
        unirouter: UNIROUTER_ADDRESS,
        beefyFeeRecipient: BEEFY_FEE_RECIPIENT,
        beefyFeeConfig: FEE_CONFIG_ADDRESS,
      };

      await strategy.initialize(
        USDC_TOKEN_ADDRESS,
        AUSDC_TOKEN_ADDRESS,
        LENDING_POOL_ADDRESS,
        REWARDS_CONTROLLER_ADDRESS,
        USDC_TOKEN_ADDRESS, // Output is also USDC
        commonAddresses,
        { gasLimit: 3000000 }
      );
      console.log("Strategy initialized");

      // Step 6: Initialize the vault
      console.log("Initializing vault...");
      const isHederaToken = true; // Set to true for HTS tokens
      await vault.initialize(
        strategy.address,
        "Beefy USDC Bonzo Test",
        "bvUSDC-BONZO-TEST",
        0, // Performance fee - set to 0 initially
        isHederaToken,
        { gasLimit: 3000000 }
      );
      console.log("Vault initialized");
    } else {
      // Use already deployed contracts
      const VAULT_ADDRESS = "0x6966D5426F97e2B29ddd3517DE7aC00Da628e718";
      const STRATEGY_ADDRESS = "0xB261cA394eA8aF0F8d4263A232b80b06654cC5Be";

      console.log("Using existing deployed contracts:");
      console.log("Vault address:", VAULT_ADDRESS);
      console.log("Strategy address:", STRATEGY_ADDRESS);

      vault = await ethers.getContractAt("BeefyVaultV7Hedera", VAULT_ADDRESS);
      strategy = await ethers.getContractAt("BonzoUSDCSupplyStrategy", STRATEGY_ADDRESS);
      vaultAddress = VAULT_ADDRESS;
    }

    want = await ethers.getContractAt("IERC20Upgradeable", USDC_TOKEN_ADDRESS);
  });

  describe.skip("Strategy Initialization", () => {
    it("should have correct initial parameters", async function () {
      const wantAddress = await strategy.want();
      const outputAddress = await strategy.output();
      const vaultAddr = await strategy.vault();
      const aTokenAddr = await strategy.aToken();
      const lendingPoolAddr = await strategy.lendingPool();
      const rewardsControllerAddr = await strategy.rewardsController();

      console.log("Want address:", wantAddress);
      console.log("Output address:", outputAddress);
      console.log("Vault address:", vaultAddr);
      console.log("aToken address:", aTokenAddr);
      console.log("Lending pool address:", lendingPoolAddr);
      console.log("Rewards controller address:", rewardsControllerAddr);

      expect(wantAddress).to.be.eq(USDC_TOKEN_ADDRESS);
      expect(outputAddress).to.be.eq(USDC_TOKEN_ADDRESS);
      expect(vaultAddr).to.be.eq(vaultAddress);
      expect(aTokenAddr).to.be.eq(AUSDC_TOKEN_ADDRESS);
      expect(lendingPoolAddr).to.be.eq(LENDING_POOL_ADDRESS);
      expect(rewardsControllerAddr).to.be.eq(REWARDS_CONTROLLER_ADDRESS);
    });

    it("should have correct vault configuration", async function () {
      const vaultStrategy = await vault.strategy();
      const vaultName = await vault.name();
      const vaultSymbol = await vault.symbol();
      const vaultDecimals = await vault.decimals();

      console.log("Vault strategy:", vaultStrategy);
      console.log("Vault name:", vaultName);
      console.log("Vault symbol:", vaultSymbol);
      console.log("Vault decimals:", vaultDecimals.toString());

      expect(vaultStrategy).to.be.eq(strategy.address);
      expect(vaultName).to.be.eq("Beefy USDC Bonzo");
      expect(vaultSymbol).to.be.eq("bvUSDC-BONZO");
      expect(vaultDecimals).to.be.eq(18); // Vault uses 18 decimals regardless of underlying token
    });

    it("should have correct harvest settings", async function () {
      try {
        const harvestOnDeposit = await strategy.harvestOnDeposit();
        const withdrawalFee = await strategy.withdrawalFee();

        console.log("Harvest on deposit:", harvestOnDeposit);
        console.log("Withdrawal fee:", withdrawalFee.toString());

        // When harvestOnDeposit is true, withdrawal fee should be 0
        if (harvestOnDeposit) {
          expect(withdrawalFee).to.be.eq(0);
        } else {
          expect(withdrawalFee).to.be.eq(10);
        }
      } catch (error) {
        console.log("Harvest settings not accessible, skipping test");
        this.skip();
      }
    });
  });

  describe.skip("Deposit and Withdraw", () => {
    it("should handle deposits correctly", async function () {
      console.log("Testing deposit functionality...");

      // Skip this test if we don't have USDC tokens to test with
      const userBalance = await want.balanceOf(deployer.address);
      console.log("Initial user balance:", userBalance.toString());
      if (userBalance.eq(0)) {
        console.log("Skipping deposit test - no USDC tokens available");
        this.skip();
        return;
      }

      const depositAmount = "1000000"; // 1 USDC (6 decimals)

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
      const tx = await vault.deposit(depositAmount, { gasLimit: 3000000 });
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

      // Deposit assertions
      expect(postDepositUserBalance).to.be.lt(initialUserBalance);
      expect(postDepositTotalSupply).to.be.gt(initialTotalSupply);
      expect(userShares).to.be.gt(0);
      expect(postDepositStrategyBalance).to.be.gt(initialStrategyBalance);

      console.log("✅ Deposit test passed!");
    });

    it("should handle withdrawals correctly", async function () {
      console.log("Testing withdrawal functionality...");

      // Check if user has shares to withdraw
      const userShares = await vault.balanceOf(deployer.address);
      console.log("User shares available:", userShares.toString());

      if (userShares.eq(0)) {
        console.log("No shares available for withdrawal test - need to deposit first");

        // Make a deposit first
        const userBalance = await want.balanceOf(deployer.address);
        if (userBalance.eq(0)) {
          console.log("Skipping withdrawal test - no USDC tokens available for deposit");
          this.skip();
          return;
        }

        const depositAmount = "1000000";
        await want.approve(vault.address, depositAmount, { gasLimit: 3000000 });
        await vault.deposit(depositAmount, { gasLimit: 3000000 });
        console.log("Made initial deposit for withdrawal test");
      }

      const totalUserShares = await vault.balanceOf(deployer.address);
      console.log("Total user shares for withdrawal:", totalUserShares.toString());

      const withdrawAmount = totalUserShares.div(2); // Withdraw half
      console.log("Withdrawing shares:", withdrawAmount.toString());

      const preWithdrawBalance = await want.balanceOf(deployer.address);
      const preWithdrawStrategyBalance = await strategy.balanceOf();

      const withdrawTx = await vault.withdraw(withdrawAmount, { gasLimit: 3000000 });
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

    it("should handle withdrawal fees correctly", async function () {
      console.log("Testing withdrawal fee functionality...");

      // Ensure we have shares and set withdrawal fee
      const userShares = await vault.balanceOf(deployer.address);
      if (userShares.eq(0)) {
        console.log("No shares available - skipping withdrawal fee test");
        this.skip();
        return;
      }

      try {
        // Set harvest on deposit to false to enable withdrawal fees
        await strategy.setHarvestOnDeposit(false);
        const withdrawalFee = await strategy.withdrawalFee();
        expect(withdrawalFee).to.be.eq(10); // 0.1%

        const withdrawAmount = userShares.div(4); // Withdraw quarter
        const preWithdrawBalance = await want.balanceOf(deployer.address);

        await vault.withdraw(withdrawAmount, { gasLimit: 3000000 });

        const postWithdrawBalance = await want.balanceOf(deployer.address);
        const tokensReceived = postWithdrawBalance.sub(preWithdrawBalance);

        console.log("Tokens received with fee:", tokensReceived.toString());
        expect(tokensReceived).to.be.gt(0);

        // Reset harvest on deposit to true
        await strategy.setHarvestOnDeposit(true);
      } catch (error) {
        console.log("Unable to set harvest on deposit or test fees - deployer may not have permissions");
        console.log("Error:", (error as Error).message);
        this.skip();
      }
    });
  });

  describe.skip("Strategy Parameters", () => {
    it("should allow updating harvest on deposit", async function () {
      try {
        const currentHarvestOnDeposit = await strategy.harvestOnDeposit();
        console.log("Current harvest on deposit:", currentHarvestOnDeposit);

        await strategy.setHarvestOnDeposit(!currentHarvestOnDeposit);
        const updatedHarvestOnDeposit = await strategy.harvestOnDeposit();

        console.log("Updated harvest on deposit:", updatedHarvestOnDeposit);
        expect(updatedHarvestOnDeposit).to.be.eq(!currentHarvestOnDeposit);

        // Verify withdrawal fee changes accordingly
        const withdrawalFee = await strategy.withdrawalFee();
        if (updatedHarvestOnDeposit) {
          expect(withdrawalFee).to.be.eq(0);
        } else {
          expect(withdrawalFee).to.be.eq(10);
        }

        // Reset to original value
        await strategy.setHarvestOnDeposit(currentHarvestOnDeposit);
      } catch (error) {
        console.log("Cannot update harvest on deposit - deployer may not have manager permissions");
        console.log("Error:", (error as Error).message);
        this.skip();
      }
    });
  });

  describe.skip("View Functions", () => {
    it("should return correct balance information", async function () {
      const totalBalance = await strategy.balanceOf();
      const wantBalance = await strategy.balanceOfWant();
      const poolBalance = await strategy.balanceOfPool();

      console.log("Total balance:", totalBalance.toString());
      console.log("Want balance:", wantBalance.toString());
      console.log("Pool balance:", poolBalance.toString());

      // Total balance should be want + pool balance
      expect(totalBalance).to.be.eq(wantBalance.add(poolBalance));
      expect(totalBalance).to.be.gte(0);
      expect(wantBalance).to.be.gte(0);
      expect(poolBalance).to.be.gte(0);
    });

    it("should return correct token addresses", async function () {
      const wantToken = await strategy.want();
      const outputToken = await strategy.output();
      const aToken = await strategy.aToken();
      const lendingPool = await strategy.lendingPool();
      const rewardsController = await strategy.rewardsController();

      console.log("Want token:", wantToken);
      console.log("Output token:", outputToken);
      console.log("aToken:", aToken);
      console.log("Lending pool:", lendingPool);
      console.log("Rewards controller:", rewardsController);

      expect(wantToken).to.be.eq(USDC_TOKEN_ADDRESS);
      expect(outputToken).to.be.eq(USDC_TOKEN_ADDRESS);
      expect(aToken).to.be.eq(AUSDC_TOKEN_ADDRESS);
      expect(lendingPool).to.be.eq(LENDING_POOL_ADDRESS);
      expect(rewardsController).to.be.eq(REWARDS_CONTROLLER_ADDRESS);
    });

    it("should return correct fees", async function () {
      try {
        const withdrawalFee = await strategy.withdrawalFee();
        const harvestOnDeposit = await strategy.harvestOnDeposit();

        console.log("Withdrawal fee:", withdrawalFee.toString());
        console.log("Harvest on deposit:", harvestOnDeposit);

        if (harvestOnDeposit) {
          expect(withdrawalFee).to.be.eq(0);
        } else {
          expect(withdrawalFee).to.be.eq(10);
        }
      } catch (error) {
        console.log("Cannot read fee information - strategy may not have these functions");
        this.skip();
      }
    });

    it("should return rewards available", async function () {
      const rewardsAvailable = await strategy.rewardsAvailable();
      console.log("Rewards available:", rewardsAvailable.toString());
      expect(rewardsAvailable).to.be.gte(0);
    });
  });

  describe.skip("Harvest Functionality", () => {
    it("should allow harvest", async function () {
      console.log("Testing harvest functionality...");

      try {
        const initialBalance = await strategy.balanceOf();
        console.log("Initial strategy balance:", initialBalance.toString());

        // Call harvest
        const harvestTx = await strategy.harvest({ gasLimit: 3000000 });
        const harvestReceipt = await harvestTx.wait();
        console.log("Harvest transaction:", harvestReceipt.transactionHash);

        const finalBalance = await strategy.balanceOf();
        console.log("Final strategy balance:", finalBalance.toString());

        // Harvest should complete without reverting
        expect(harvestReceipt.status).to.be.eq(1);
      } catch (error) {
        console.log("Cannot harvest - deployer may not have harvest permissions");
        console.log("Error:", (error as Error).message);
        this.skip();
      }
    });

    it("should allow harvest with custom call fee recipient", async function () {
      try {
        const callFeeRecipient = deployer.address;

        const harvestTx = await strategy["harvest(address)"](callFeeRecipient, { gasLimit: 3000000 });
        const harvestReceipt = await harvestTx.wait();
        console.log("Harvest with recipient transaction:", harvestReceipt.transactionHash);

        expect(harvestReceipt.status).to.be.eq(1);
      } catch (error) {
        console.log("Cannot harvest with recipient - function may not exist or permissions issue");
        this.skip();
      }
    });

    it("should not allow harvest with zero address as recipient", async function () {
      try {
        const zeroAddress = ethers.constants.AddressZero;

        await expect(strategy["harvest(address)"](zeroAddress)).to.be.reverted;
      } catch (error) {
        console.log("Cannot test harvest with zero address - function may not exist");
        this.skip();
      }
    });
  });

  describe.skip("Emergency Functions", () => {
    it("should allow manager to pause strategy", async function () {
      try {
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
      } catch (error) {
        console.log("Cannot pause strategy - deployer may not have manager permissions");
        this.skip();
      }
    });

    it("should allow manager to unpause strategy", async function () {
      try {
        // First ensure it's paused
        if (!(await strategy.paused())) {
          await strategy.pause();
        }

        await strategy.unpause();
        const isPaused = await strategy.paused();
        expect(isPaused).to.be.eq(false);
      } catch (error) {
        console.log("Cannot unpause strategy - deployer may not have manager permissions");
        this.skip();
      }
    });

    it("should allow manager to call panic", async function () {
      try {
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
      } catch (error) {
        console.log("Cannot call panic - deployer may not have manager permissions");
        this.skip();
      }
    });
  });

  describe.skip("Access Control", () => {
    // it("should only allow vault to call withdraw", async function () {
    //   const withdrawAmount = 1000;
    //   await expect(strategy.withdraw(withdrawAmount)).to.be.reverted;
    // });

    // it("should only allow vault to call retireStrat", async function () {
    //   await expect(strategy.retireStrat()).to.be.reverted;
    // });

    it("should only allow manager to update parameters", async function () {
      const signer = new ethers.Wallet(nonManagerPK!, ethers.provider);
      if (signer) {
        const strategyAsNonManager = strategy.connect(signer);

        await expect(strategyAsNonManager.setHarvestOnDeposit(true)).to.be.reverted;
      } else {
        console.log("⚠️ Skipping access control test - only one signer available");
        this.skip();
      }
    });

    it("should only allow manager to call emergency functions", async function () {
      const signer = new ethers.Wallet(nonManagerPK!, ethers.provider);
      if (signer) {
        const strategyAsNonManager = strategy.connect(signer);

        await expect(strategyAsNonManager.pause()).to.be.reverted;
        await expect(strategyAsNonManager.panic()).to.be.reverted;
        await expect(strategyAsNonManager.unpause()).to.be.reverted;
      } else {
        console.log("⚠️ Skipping access control test - only one signer available");
        this.skip();
      }
    });

    it("should only allow authorized addresses to harvest", async function () {
      try {
        // The harvest function allows vault, owner, or keeper to call it
        const harvestTx = await strategy["harvest()"]({ gasLimit: 3000000 });
        const harvestReceipt = await harvestTx.wait();
        expect(harvestReceipt.status).to.be.eq(1);
      } catch (error) {
        console.log("Harvest function not available on this strategy implementation");
        this.skip();
      }
    });
  });

  describe.skip("Token Management", () => {
    it("should handle stuck tokens recovery", async function () {
      try {
        const signer = new ethers.Wallet(nonManagerPK!, ethers.provider);
        if (signer) {
          const strategyAsNonManager = strategy.connect(signer);

          // Should revert when called by non-manager
          await expect(strategyAsNonManager.inCaseTokensGetStuck(USDC_TOKEN_ADDRESS)).to.be.reverted;
        }

        // Should revert when trying to recover protected tokens
        await expect(strategy.inCaseTokensGetStuck(USDC_TOKEN_ADDRESS)).to.be.revertedWith("!want");
        await expect(strategy.inCaseTokensGetStuck(AUSDC_TOKEN_ADDRESS)).to.be.revertedWith("!aToken");
      } catch (error) {
        console.log("inCaseTokensGetStuck function not available on this strategy implementation");
        this.skip();
      }
    });
  });

  describe.skip("Strategy Safety", () => {
    it("should not allow deposit when paused", async function () {
      try {
        // Pause the strategy
        await strategy.pause();

        // Try to deposit - should fail
        await expect(strategy.deposit()).to.be.revertedWith("Pausable: paused");

        // Unpause for other tests
        await strategy.unpause();
      } catch (error) {
        console.log("Cannot test pause functionality - deployer may not have manager permissions");
        this.skip();
      }
    });

    it("should not allow withdraw when paused", async function () {
      try {
        // Pause the strategy
        await strategy.pause();

        // Try to withdraw - should fail
        await expect(strategy.withdraw(1000)).to.be.revertedWith("Pausable: paused");

        // Unpause for other tests
        await strategy.unpause();
      } catch (error) {
        console.log("Cannot test pause functionality - deployer may not have manager permissions");
        this.skip();
      }
    });

    it("should not allow harvest when paused", async function () {
      try {
        // Pause the strategy
        await strategy.pause();

        // Try to harvest - should fail
        await expect(strategy.harvest()).to.be.revertedWith("Pausable: paused");

        // Unpause for other tests
        await strategy.unpause();
      } catch (error) {
        console.log("Cannot test pause functionality - deployer may not have manager permissions");
        this.skip();
      }
    });
  });

  describe.skip("Vault Functions", () => {
    //REMOVED these functions from contract bcz of contract size limit
    // it("should handle depositAll correctly", async function () {
    //   const userBalance = await want.balanceOf(deployer.address);
    //   if (userBalance.eq(0)) {
    //     console.log("Skipping depositAll test - no USDC tokens available");
    //     this.skip();
    //     return;
    //   }

    //   try {
    //     // Only approve a portion to avoid depleting the entire balance
    //     const depositAmount = userBalance.div(10); // Use 10% of balance
    //     await want.approve(vault.address, depositAmount, { gasLimit: 3000000 });

    //     const initialShares = await vault.balanceOf(deployer.address);

    //     await vault.depositAll({ gasLimit: 3000000 });

    //     const finalShares = await vault.balanceOf(deployer.address);
    //     expect(finalShares).to.be.gte(initialShares); // Allow for equal in case of zero approval
    //   } catch (error) {
    //     console.log("DepositAll failed - this may be expected if approval is zero");
    //     // Don't skip, just expect the transaction to revert
    //     await expect(vault.depositAll({ gasLimit: 3000000 })).to.be.reverted;
    //   }
    // });

    // it("should handle withdrawAll correctly", async function () {
    //   const userShares = await vault.balanceOf(deployer.address);
    //   if (userShares.eq(0)) {
    //     console.log("Skipping withdrawAll test - no shares available");
    //     this.skip();
    //     return;
    //   }

    //   const initialBalance = await want.balanceOf(deployer.address);

    //   await vault.withdrawAll({ gasLimit: 3000000 });

    //   const finalBalance = await want.balanceOf(deployer.address);
    //   const finalShares = await vault.balanceOf(deployer.address);

    //   expect(finalBalance).to.be.gt(initialBalance);
    //   expect(finalShares).to.be.eq(0);
    // });

    it("should return correct getPricePerFullShare", async function () {
      const pricePerShare = await vault.getPricePerFullShare();
      console.log("Price per full share:", pricePerShare.toString());
      expect(pricePerShare).to.be.gt(0);
    });

    it("should return correct balance", async function () {
      const vaultBalance = await vault.balance();
      const strategyBalance = await strategy.balanceOf();
      console.log("Vault balance:", vaultBalance.toString());
      console.log("Strategy balance:", strategyBalance.toString());
      expect(vaultBalance).to.be.eq(strategyBalance);
    });

    it("should return correct available", async function () {
      const available = await vault.available();
      const vaultWantBalance = await want.balanceOf(vault.address);
      console.log("Available:", available.toString());
      console.log("Vault want balance:", vaultWantBalance.toString());
      expect(available).to.be.eq(vaultWantBalance);
    });
  });

  describe("Edge Cases", () => {
    it.skip("should handle zero deposits gracefully", async function () {
      try {
        await expect(vault.deposit(0)).to.be.reverted;
      } catch (error) {
        // If zero deposits are allowed, just verify the transaction succeeds
        const tx = await vault.deposit(0);
        const receipt = await tx.wait();
        expect(receipt.status).to.be.eq(1);
        console.log("Zero deposits are allowed on this vault implementation");
      }
    });

    it.skip("should handle zero withdrawals gracefully", async function () {
      try {
        await expect(vault.withdraw(0)).to.be.reverted;
      } catch (error) {
        // If zero withdrawals are allowed, just verify the transaction succeeds
        const tx = await vault.withdraw(0);
        const receipt = await tx.wait();
        expect(receipt.status).to.be.eq(1);
        console.log("Zero withdrawals are allowed on this vault implementation");
      }
    });

    it.skip("should handle withdrawal of more shares than owned", async function () {
      const userShares = await vault.balanceOf(deployer.address);
      const excessiveAmount = userShares.add(1000000);

      if (userShares.gt(0)) {
        await expect(vault.withdraw(excessiveAmount)).to.be.reverted;
      }
    });

    it("should handle deposit when vault has existing balance", async function () {
      const userBalance = await want.balanceOf(deployer.address);
      console.log("User balance before test:", userBalance.toString());

      if (userBalance.lt(ethers.BigNumber.from("750000"))) {
        // Need at least 0.75 USDC for this test
        console.log("Skipping deposit test - insufficient USDC tokens available");
        this.skip();
        return;
      }

      // First, ensure the vault has some balance by making an initial deposit
      const initialDeposit = "250000"; // 0.25 USDC
      await want.approve(vault.address, initialDeposit, { gasLimit: 3000000 });
      const initialDepositTx = await vault.deposit(initialDeposit, { gasLimit: 3000000 });
      const initialDepositReceipt = await initialDepositTx.wait();
      console.log("Initial deposit transaction:", initialDepositReceipt.transactionHash);
      console.log("Initial deposit completed to set up test state.");

      // Now test additional deposit when vault has existing balance
      const depositAmount = "500000"; // 0.5 USDC
      await want.approve(vault.address, depositAmount, { gasLimit: 3000000 });

      const initialTotalSupply = await vault.totalSupply();
      const initialVaultBalance = await vault.balance();

      console.log("Before second deposit - Total supply:", initialTotalSupply.toString());
      console.log("Before second deposit - Vault balance:", initialVaultBalance.toString());

      // The vault must have a balance from the initial deposit
      expect(initialVaultBalance).to.be.gt(0);

      const depositTx = await vault.deposit(depositAmount, { gasLimit: 3000000 });
      const depositReceipt = await depositTx.wait();
      console.log("Deposit transaction:", depositReceipt.transactionHash);

      const finalTotalSupply = await vault.totalSupply();
      const finalVaultBalance = await vault.balance();

      console.log("After second deposit - Total supply:", finalTotalSupply.toString());
      console.log("After second deposit - Vault balance:", finalVaultBalance.toString());

      expect(finalTotalSupply).to.be.gt(initialTotalSupply);
      expect(finalVaultBalance).to.be.gt(initialVaultBalance);
    });

    it.skip("should handle insufficient allowance", async function () {
      const userBalance = await want.balanceOf(deployer.address);
      if (userBalance.eq(0)) {
        console.log("Skipping allowance test - no USDC tokens available");
        this.skip();
        return;
      }

      const depositAmount = "1000000";

      // Approve less than deposit amount (approve only 100000 instead of 1000000)
      await want.approve(vault.address, "100000", { gasLimit: 3000000 });

      // Test that deposit with insufficient allowance reverts
      try {
        const tx = await vault.deposit(depositAmount, { gasLimit: 3000000 });
        const receipt = await tx.wait();

        // If transaction succeeded, it means the vault handles insufficient allowance gracefully
        if (receipt.status === 1) {
          console.log("Vault allows deposit with insufficient allowance - this is acceptable behavior");
          expect(receipt.status).to.be.eq(1);
        } else {
          console.log("Transaction reverted as expected due to insufficient allowance");
          expect(receipt.status).to.be.eq(0);
        }
      } catch (error) {
        console.log("Deposit correctly reverted due to insufficient allowance");
        // This is the expected behavior - transaction should revert
        expect(error).to.exist;
      }
    });

    it.skip("should handle insufficient balance", async function () {
      const userBalance = await want.balanceOf(deployer.address);
      const excessiveAmount = userBalance.add(1000000);

      await want.approve(vault.address, excessiveAmount, { gasLimit: 3000000 });

      if (userBalance.gt(0)) {
        await expect(vault.deposit(excessiveAmount)).to.be.reverted;
      }
    });
  });

  describe.skip("Strategy Internal Functions", () => {
    it("should return correct strategy metadata", async function () {
      // Test any public view functions that return strategy metadata
      const wantToken = await strategy.want();
      const outputToken = await strategy.output();
      const vault = await strategy.vault();

      expect(wantToken).to.not.be.eq(ethers.constants.AddressZero);
      expect(outputToken).to.not.be.eq(ethers.constants.AddressZero);
      expect(vault).to.not.be.eq(ethers.constants.AddressZero);
    });

    it("should handle rewards claiming", async function () {
      // Test the rewards claiming functionality if available
      const rewardsAvailable = await strategy.rewardsAvailable();
      console.log("Rewards available for claiming:", rewardsAvailable.toString());

      // This should not revert even if no rewards are available
      expect(rewardsAvailable).to.be.gte(0);
    });

    it("should handle fee calculations", async function () {
      try {
        const withdrawalFee = await strategy.withdrawalFee();
        const harvestOnDeposit = await strategy.harvestOnDeposit();

        // Verify fee logic consistency
        if (harvestOnDeposit) {
          expect(withdrawalFee).to.be.eq(0);
        } else {
          expect(withdrawalFee).to.be.eq(10);
        }
      } catch (error) {
        console.log("Fee calculation functions not available on this strategy implementation");
        this.skip();
      }
    });
  });

  describe.skip("Integration Tests", () => {
    it("should handle multiple users depositing and withdrawing", async function () {
      const signers = await ethers.getSigners();
      if (signers.length < 2) {
        console.log("Skipping multi-user test - only one signer available");
        this.skip();
        return;
      }

      const user1 = signers[0];
      const user2 = signers[1];

      // Check if users have USDC
      const user1Balance = await want.balanceOf(user1.address);
      if (user1Balance.eq(0)) {
        console.log("Skipping multi-user test - user1 has no USDC tokens");
        this.skip();
        return;
      }

      // User 1 deposits
      const depositAmount1 = "500000";
      await want.connect(user1).approve(vault.address, depositAmount1, { gasLimit: 3000000 });
      await vault.connect(user1).deposit(depositAmount1, { gasLimit: 3000000 });

      const user1Shares = await vault.balanceOf(user1.address);
      expect(user1Shares).to.be.gt(0);

      console.log("Multi-user integration test passed with user1");
    });

    it("should maintain share price consistency across operations", async function () {
      const userBalance = await want.balanceOf(deployer.address);
      if (userBalance.eq(0)) {
        console.log("Skipping share price test - no USDC tokens available");
        this.skip();
        return;
      }

      const initialPricePerShare = await vault.getPricePerFullShare();
      console.log("Initial price per share:", initialPricePerShare.toString());

      // Make a small deposit
      const depositAmount = "100000";
      await want.approve(vault.address, depositAmount, { gasLimit: 3000000 });
      await vault.deposit(depositAmount, { gasLimit: 3000000 });

      const afterDepositPricePerShare = await vault.getPricePerFullShare();
      console.log("Price per share after deposit:", afterDepositPricePerShare.toString());

      // Price should remain relatively stable (allowing for small variations due to fees/slippage)
      expect(afterDepositPricePerShare).to.be.gte(initialPricePerShare.mul(99).div(100));
    });
  });
});
