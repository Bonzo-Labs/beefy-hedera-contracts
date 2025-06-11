import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BeefyVaultV7Hedera, BonzoSAUCELevergedLiqStaking, IERC20Upgradeable } from "../../typechain-types";
import addresses from "../../scripts/deployed-addresses.json";

// Hardcoded values from the deployment
const VAULT_FACTORY_ADDRESS = addresses.vaultFactory;
const XSAUCE_TOKEN_ADDRESS = "0x000000000000000000000000000000000015a59b"; // xSAUCE token
const SAUCE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000120f46"; // SAUCE token
const AXSAUCE_TOKEN_ADDRESS = "0x2217F55E2056C15a21ED7a600446094C36720f29"; // axSAUCE token
const DEBT_TOKEN_ADDRESS = "0x65be417A48511d2f20332673038e5647a4ED194D"; // debtSAUCE token
const LENDING_POOL_ADDRESS = "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62"; // Bonzo lending pool
const REWARDS_CONTROLLER_ADDRESS = "0x40f1f4247972952ab1D276Cf552070d2E9880DA6"; // Bonzo rewards controller
const STAKING_POOL_ADDRESS = "0x000000000000000000000000000000000015a59a"; // SaucerSwap staking pool
const UNIROUTER_ADDRESS = "0x00000000000000000000000000000000000026e7"; // Router address
const FEE_CONFIG_ADDRESS = addresses.beefyFeeConfig; // Fee config address

describe("BeefyBonzoSauceXSauceVault", function () {
  // Set timeout to 60 seconds for all tests in this suite
  this.timeout(1000000);

  let vault: BeefyVaultV7Hedera | any;
  let strategy: BonzoSAUCELevergedLiqStaking | any;
  let want: IERC20Upgradeable | any;
  let deployer: SignerWithAddress | any;
  let vaultAddress: string;
  let deployNewContract = true;

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
        keeper: deployer.address,
        strategist: deployer.address,
        unirouter: UNIROUTER_ADDRESS,
        beefyFeeRecipient: deployer.address,
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
        1000, // maxBorrowable (50%)
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
      const VAULT_ADDRESS = "0x9F846865c2cF56994e285a2939479845C7f2bb05";
      const STRATEGY_ADDRESS = "0x88D9808d3Aa3ecCf015f4a2A47f153727a40f019";
      vault = await ethers.getContractAt("BeefyVaultV7Hedera", VAULT_ADDRESS);
      strategy = await ethers.getContractAt("BonzoSAUCELevergedLiqStaking", STRATEGY_ADDRESS);
      vaultAddress = VAULT_ADDRESS;
      deployNewContract = false;
    }
    want = await ethers.getContractAt("IERC20Upgradeable", XSAUCE_TOKEN_ADDRESS);
  });

  describe("Deposit and Withdraw", () => {
    it("should handle deposits and withdrawals correctly", async function () {
      console.log("sender address", deployer.address);

      console.log("setting harvest on deposit to true");
      // const initialHarvestOnDeposit = await strategy.harvestOnDeposit();
      // console.log("initialHarvestOnDeposit", initialHarvestOnDeposit);
      // if (!initialHarvestOnDeposit) {
      //     const setHarvestOnDeposit = await strategy.setHarvestOnDeposit(true);
      //     const setHarvestOnDepositReceipt = await setHarvestOnDeposit.wait();
      //     console.log("setHarvestOnDeposit transaction", setHarvestOnDepositReceipt.transactionHash);
      //     const isHarvestOnDeposit = await strategy.harvestOnDeposit();
      //     console.log("isHarvestOnDeposit", isHarvestOnDeposit);
      // }

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

      // // Wait for some time to allow for yield generation
      // console.log("Waiting for yield generation...");
      // await new Promise(resolve => setTimeout(resolve, 30000));

      // // Perform withdrawal
      // console.log("Withdrawing...");
      // const withdrawTx = await vault.withdraw(userShares, { gasLimit: 3000000 });
      // const withdrawReceipt = await withdrawTx.wait();
      // console.log("Withdraw transaction:", withdrawReceipt.transactionHash);

      // // Check post-withdrawal balances
      // const postWithdrawUserBalance = await want.balanceOf(deployer.address);
      // const postWithdrawVaultBalance = await want.balanceOf(vault.address);
      // const postWithdrawTotalSupply = await vault.totalSupply();
      // const postWithdrawUserShares = await vault.balanceOf(deployer.address);

      // console.log("Post-withdraw user balance:", postWithdrawUserBalance.toString());
      // console.log("Post-withdraw vault balance:", postWithdrawVaultBalance.toString());
      // console.log("Post-withdraw total supply:", postWithdrawTotalSupply.toString());
      // console.log("Post-withdraw user shares:", postWithdrawUserShares.toString());

      // // Verify withdrawal
      // expect(postWithdrawUserBalance).to.be.gt(postDepositUserBalance);
      // expect(postWithdrawTotalSupply).to.be.lt(postDepositTotalSupply);
      // expect(postWithdrawUserShares).to.be.eq(0);
    });
  });

  // describe("Strategy Parameters", () => {
  //     it("should have correct initial parameters", async function () {
  //         const maxBorrowable = await strategy.maxBorrowable();
  //         const slippageTolerance = await strategy.slippageTolerance();
  //         const maxLoops = await strategy.maxLoops();
  //         const isRewardsAvailable = await strategy.isRewardsAvailable();
  //         const isBonzoDeployer = await strategy.isBonzoDeployer();

  //         console.log("Max borrowable:", maxBorrowable.toString());
  //         console.log("Slippage tolerance:", slippageTolerance.toString());
  //         console.log("Max loops:", maxLoops.toString());
  //         console.log("Is rewards available:", isRewardsAvailable);
  //         console.log("Is Bonzo deployer:", isBonzoDeployer);

  //         expect(maxBorrowable).to.be.eq(5000); // 50%
  //         expect(slippageTolerance).to.be.eq(50); // 0.5%
  //         expect(maxLoops).to.be.gt(0);
  //     });

  //     it("should allow updating slippage tolerance", async function () {
  //         const newSlippage = 100; // 1%
  //         await strategy.setSlippageTolerance(newSlippage);
  //         const updatedSlippage = await strategy.slippageTolerance();
  //         expect(updatedSlippage).to.be.eq(newSlippage);
  //     });

  //     it("should allow updating max loops", async function () {
  //         const newMaxLoops = 5;
  //         await strategy.setMaxLoops(newMaxLoops);
  //         const updatedMaxLoops = await strategy.maxLoops();
  //         expect(updatedMaxLoops).to.be.eq(newMaxLoops);
  //     });
  // });

  // describe("Strategy Safety", () => {
  //     it("should not allow excessive slippage", async function () {
  //         const excessiveSlippage = 1000; // 10%
  //         await expect(strategy.setSlippageTolerance(excessiveSlippage))
  //             .to.be.revertedWith("Slippage too high");
  //     });

  //     it("should not allow excessive max loops", async function () {
  //         const excessiveLoops = 11;
  //         await expect(strategy.setMaxLoops(excessiveLoops))
  //             .to.be.revertedWith("!range");
  //     });

  //     it("should not allow excessive max borrowable", async function () {
  //         const excessiveBorrowable = 10001;
  //         await expect(strategy.setMaxBorrowable(excessiveBorrowable))
  //             .to.be.revertedWith("!cap");
  //     });
  // });
});
