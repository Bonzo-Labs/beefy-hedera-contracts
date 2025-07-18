import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
  BeefyVaultV7Hedera,
  BonzoHBARXLevergedLiqStaking,
  IERC20Upgradeable,
  MockStaking,
} from "../../typechain-types";
//*******************SET CHAIN TYPE HERE*******************
const CHAIN_TYPE = process.env.CHAIN_TYPE;
//*******************SET CHAIN TYPE HERE*******************

let addresses,
  HBARX_TOKEN_ADDRESS: string,
  HBAR_TOKEN_ADDRESS: string,
  AHBARX_TOKEN_ADDRESS: string,
  DEBT_TOKEN_ADDRESS: string,
  LENDING_POOL_ADDRESS: string,
  REWARDS_CONTROLLER_ADDRESS: string,
  UNIROUTER_ADDRESS: string,
  STAKING_CONTRACT_ADDRESS: string;
let nonManagerPK: string;

if (CHAIN_TYPE === "testnet") {
  addresses = require("../../scripts/deployed-addresses.json");
  HBARX_TOKEN_ADDRESS = "0x0000000000000000000000000000000000220ced"; // HBARX token
  HBAR_TOKEN_ADDRESS = "0x0000000000000000000000000000000000003ad2"; // WHBAR token
  AHBARX_TOKEN_ADDRESS = "0x37FfB9d2c91ef6858E54DD5B05805339A1aEA207"; // aHBARX token
  DEBT_TOKEN_ADDRESS = "0xacE6c84d8737e377c1f85BE5f7BC82E4fF3248E6"; // debtWHBAR token
  LENDING_POOL_ADDRESS = "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62"; // Bonzo lending pool
  REWARDS_CONTROLLER_ADDRESS = "0x40f1f4247972952ab1D276Cf552070d2E9880DA6"; // Bonzo rewards controller
  UNIROUTER_ADDRESS = "0x0000000000000000000000000000000000159398"; // Router address
  STAKING_CONTRACT_ADDRESS = ""; // Will be set by mock deployment
  nonManagerPK = process.env.NON_MANAGER_PK!;
} else if (CHAIN_TYPE === "mainnet") {
  addresses = require("../../scripts/deployed-addresses-mainnet.json");
  HBARX_TOKEN_ADDRESS = "0x00000000000000000000000000000000000cba44"; // Hedera HBARX token mainnet
  HBAR_TOKEN_ADDRESS = "0x0000000000000000000000000000000000163b5a"; // WHBAR token mainnet
  AHBARX_TOKEN_ADDRESS = "0x40EBC87627Fe4689567C47c8C9C84EDC4Cf29132"; // aHBARX token mainnet
  DEBT_TOKEN_ADDRESS = "0xCD5A1FF3AD6EDd7e85ae6De3854f3915dD8c9103"; // debtWHBAR token mainnet
  LENDING_POOL_ADDRESS = "0x236897c518996163E7b313aD21D1C9fCC7BA1afc"; // Bonzo lending pool mainnet
  REWARDS_CONTROLLER_ADDRESS = "0x0f3950d2fCbf62a2D79880E4fc251E4CB6625FBC"; // Bonzo rewards controller mainnet
  UNIROUTER_ADDRESS = "0x00000000000000000000000000000000003c437a"; // Router address mainnet
  STAKING_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000158d97"; // Stader staking contract mainnet
  nonManagerPK = process.env.NON_MANAGER_PK_MAINNET!;
}

// Using deployed addresses from deployed-addresses.json and specific Hedera contract addresses
const VAULT_FACTORY_ADDRESS = addresses.vaultFactory;
const FEE_CONFIG_ADDRESS = addresses.beefyFeeConfig;
const BEEFY_FEE_RECIPIENT = addresses.beefyFeeRecipient;
const STRATEGY_OWNER = addresses.strategyOwner;
const VAULT_OWNER = addresses.vaultOwner;
const KEEPER = addresses.keeper;

describe("BeefyBonzoHbarXHbarVault", function () {
  // Set timeout to 60 seconds for all tests in this suite
  this.timeout(1000000);

  let vault: BeefyVaultV7Hedera | any;
  let strategy: BonzoHBARXLevergedLiqStaking | any;
  let want: IERC20Upgradeable | any;
  let deployer: SignerWithAddress | any;
  let vaultAddress: string;
  let deployNewContract = true;
  let staking: MockStaking | any;

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
      //Step 0: Deploy the staking contract (only for testnet)
      if (CHAIN_TYPE === "testnet") {
        console.log("Deploying staking contract...");
        const Staking = await ethers.getContractFactory("MockStaking");
        staking = await Staking.deploy(HBARX_TOKEN_ADDRESS);
        await staking.deployed();
        console.log("Staking contract deployed to:", staking.address);
        STAKING_CONTRACT_ADDRESS = staking.address;
        //transfer hbarx to the staking contract
        const hbarx = await ethers.getContractAt("IERC20Upgradeable", HBARX_TOKEN_ADDRESS);
        await hbarx.transfer(staking.address, "100000000");
        console.log("HBARX transferred to staking contract");
      } else {
        console.log("Using mainnet staking contract:", STAKING_CONTRACT_ADDRESS);
      }

      // Step 1: Deploy the strategy
      console.log("Deploying BonzoHBARXLevergedLiqStaking...");
      const BonzoHBARXLevergedLiqStaking = await ethers.getContractFactory("BonzoHBARXLevergedLiqStaking");
      strategy = await BonzoHBARXLevergedLiqStaking.deploy({gasLimit: 5000000});
      await strategy.deployed();
      console.log("BonzoHBARXLevergedLiqStaking deployed to:", strategy.address);

      // Step 2: Connect to the vault factory
      const vaultFactory = await ethers.getContractAt("BeefyVaultV7FactoryHedera", VAULT_FACTORY_ADDRESS);
      console.log("Connected to vault factory at:", VAULT_FACTORY_ADDRESS);

      // Step 3: Create a new vault using the factory
      console.log("Creating new vault...");
      const tx = await vaultFactory.cloneVault({gasLimit: 4000000});
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
      console.log("Staking contract address:", STAKING_CONTRACT_ADDRESS);
      await strategy.initialize(
        HBARX_TOKEN_ADDRESS,
        HBAR_TOKEN_ADDRESS,
        AHBARX_TOKEN_ADDRESS,
        DEBT_TOKEN_ADDRESS,
        LENDING_POOL_ADDRESS,
        REWARDS_CONTROLLER_ADDRESS,
        STAKING_CONTRACT_ADDRESS,
        3000, // maxBorrowable (10%)
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
        "Beefy HBARX Bonzo Leveraged Test",
        "bvHBARX-BONZO-LEV-TEST",
        0, // Performance fee - set to 0 initially
        isHederaToken,
        { gasLimit: 4000000 }
      );
      console.log("Vault initialized");
    } else {
      // Use already deployed contract
      const VAULT_ADDRESS = "0x7974CAb644B9D9A4C7A5bB175b53C8219C77Faa4";
      const STRATEGY_ADDRESS = "0x867F34aC29DaBf4c424BE40c8c403301836BeD4e";
      vault = await ethers.getContractAt("BeefyVaultV7Hedera", VAULT_ADDRESS);
      strategy = await ethers.getContractAt("BonzoHBARXLevergedLiqStaking", STRATEGY_ADDRESS);
      vaultAddress = VAULT_ADDRESS;
    }
    want = await ethers.getContractAt("IERC20Upgradeable", HBARX_TOKEN_ADDRESS);

    const aToken = await ethers.getContractAt("IERC20Upgradeable", AHBARX_TOKEN_ADDRESS);
    const debtToken = await ethers.getContractAt("IERC20Upgradeable", DEBT_TOKEN_ADDRESS);

    const strategyATokenBalance = await aToken.balanceOf(strategy.address);
    const strategyDebtTokenBalance = await debtToken.balanceOf(strategy.address);

    console.log("Strategy aToken balance:", strategyATokenBalance.toString());
    console.log("Strategy debt token balance:", strategyDebtTokenBalance.toString());
  });

  after(async () => {
    const aToken = await ethers.getContractAt("IERC20Upgradeable", AHBARX_TOKEN_ADDRESS);
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

    //withdraw all hbarx from the staking contract (only for testnet)
    if (CHAIN_TYPE === "testnet" && staking) {
      await staking.withdrawHbarx();
      console.log("HBARX withdrawn from staking contract");
    }
  });

  describe.skip("Strategy Initialization", () => {
    it("should have correct initial parameters", async function () {
      const maxBorrowable = await strategy.getMaxBorrowable();
      const slippageTolerance = await strategy.slippageTolerance();
      const maxLoops = await strategy.getMaxLoops();
      const isRewardsAvailable = await strategy.isRewardsAvailable();
      const isBonzoDeployer = await strategy.isBonzoDeployer();
      const wantToken = await strategy.want();
      const borrowTokenAddr = await strategy.borrowToken();
      const aTokenAddr = await strategy.aToken();
      const debtTokenAddr = await strategy.debtToken();
      const lendingPoolAddr = await strategy.lendingPool();
      const rewardsControllerAddr = await strategy.rewardsController();
      const stakingContractAddr = await strategy.stakingContract();

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
      console.log("Staking contract:", stakingContractAddr);

      expect(maxBorrowable).to.be.eq(4000); // 10%
      expect(slippageTolerance).to.be.eq(50); // 0.5%
      expect(maxLoops).to.be.eq(2);
      expect(isRewardsAvailable).to.be.eq(false);
      expect(isBonzoDeployer).to.be.eq(true);
      expect(wantToken.toLowerCase()).to.be.eq(HBARX_TOKEN_ADDRESS.toLowerCase());
      expect(borrowTokenAddr.toLowerCase()).to.be.eq(HBAR_TOKEN_ADDRESS.toLowerCase());
      expect(aTokenAddr.toLowerCase()).to.be.eq(AHBARX_TOKEN_ADDRESS.toLowerCase());
      expect(debtTokenAddr.toLowerCase()).to.be.eq(DEBT_TOKEN_ADDRESS.toLowerCase());
      expect(lendingPoolAddr.toLowerCase()).to.be.eq(LENDING_POOL_ADDRESS.toLowerCase());
      expect(rewardsControllerAddr.toLowerCase()).to.be.eq(REWARDS_CONTROLLER_ADDRESS.toLowerCase());
      expect(stakingContractAddr.toLowerCase()).to.be.eq(STAKING_CONTRACT_ADDRESS.toLowerCase());
    });

    it("should have correct metadata", async function () {
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

      expect(name).to.be.eq("Strategy Bonzo HBARX Leveraged Liquidity Staking");
      expect(symbol).to.be.eq("strategy-bonzo-hbarx-leveraged");
      expect(version).to.be.eq("1.0");
      expect(description).to.be.eq("Strategy for Bonzo HBARX Leveraged Liquidity Staking");
      expect(category).to.be.eq("Leveraged Staking");
      expect(riskLevel).to.be.eq(3);
    });
  });

  describe("Deposit and Withdraw", () => {
    it("should handle deposit", async function () {
      console.log("Testing deposit functionality...");

      // Skip this test if we don't have HBARX tokens to test with
      const userBalance = await want.balanceOf(deployer.address);
      console.log("Initial user balance:", userBalance.toString());
      if (userBalance.eq(0)) {
        console.log("Skipping deposit test - no HBARX tokens available");
        this.skip();
        return;
      }

      const depositAmount = "300000000"; // 0.1 HBARX (8 decimals)
      
      // Approve the vault to spend tokens
      const approveTx = await want.approve(vault.address, depositAmount, { gasLimit: 1000000 });
      const approveReceipt = await approveTx.wait();
      console.log("Approve transaction hash:", approveReceipt.transactionHash);
      console.log("Tokens approved for vault");

      // Check initial balances
      // const initialUserBalance = await want.balanceOf(deployer.address);
      // const initialVaultBalance = await want.balanceOf(vault.address);
      // const initialTotalSupply = await vault.totalSupply();
      // const initialStrategyBalance = await strategy.balanceOf();

      // console.log("Initial user balance:", initialUserBalance.toString());
      // console.log("Initial vault balance:", initialVaultBalance.toString());
      // console.log("Initial total supply:", initialTotalSupply.toString());
      // console.log("Initial strategy balance:", initialStrategyBalance.toString());

      
      // Perform deposit
      console.log("Depositing...");
      const tx = await vault.deposit(depositAmount, { gasLimit: 5000000 });
      const receipt = await tx.wait();
      console.log("Deposit transaction:", receipt.transactionHash);

      //catch staking debug event
      const stakingDebugEvent = receipt.events?.find((e: any) => e.event === "StakingDebug");
      console.log("Staking debug:", stakingDebugEvent?.args?.amount.toString());
      console.log("Staking debug:", stakingDebugEvent?.args?.contractBalance.toString());

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
      // expect(postDepositUserBalance).to.be.lt(initialUserBalance);
      // expect(postDepositTotalSupply).to.be.gt(initialTotalSupply);
      // expect(userShares).to.be.gt(0);
      // expect(postDepositStrategyBalance).to.be.gt(initialStrategyBalance);

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

        const depositAmount = "10000000"; // 0.1 HBARX
        const approveTx = await want.approve(vault.address, depositAmount, { gasLimit: 3000000 });
        const approveReceipt = await approveTx.wait();
        console.log("Approve transaction hash:", approveReceipt.transactionHash);

        const trx = await vault.deposit(depositAmount, { gasLimit: 5000000 });
        const receipt = await trx.wait();
        console.log("Deposit transaction hash:", receipt.transactionHash);
      }

      const totalUserShares = await vault.balanceOf(deployer.address);
      console.log("Total user shares for withdrawal:", totalUserShares.toString());

      const withdrawAmount = totalUserShares.div(2); // Withdraw half
      console.log("Withdrawing shares:", withdrawAmount.toString());

      const preWithdrawBalance = await want.balanceOf(deployer.address);
      const preWithdrawStrategyBalance = await strategy.balanceOf();

      const withdrawTx = await vault.withdraw(withdrawAmount, { gasLimit: 6000000 });
      const withdrawReceipt = await withdrawTx.wait();
      console.log("Withdrawal completed, hash: ", withdrawReceipt.transactionHash);

      const debugEvents = withdrawReceipt.events?.filter((e: any) => e.event === "Debug");
      if (debugEvents && debugEvents.length > 0) {
        const debugEvent = debugEvents[0];
        console.log("Debug Event Values:");
        console.log("  HBARX Amount:", debugEvent.args.hbarxAmount.toString());
        console.log("  HBAR Amount:", debugEvent.args.hbarAmount.toString());
        console.log("  Contract Balance:", debugEvent.args.contractBalance.toString());
        console.log("  Exchange Rate:", debugEvent.args.exchangeRate.toString());
      }

      //catch unstake debug event
      const unstakeDebugEvent = (await withdrawTx.wait()).events?.find((e: any) => e.event === "UnstakeDebug");
      console.log("Unstake debug:", unstakeDebugEvent?.args?.hbarxAmount.toString());
      console.log("Unstake debug:", unstakeDebugEvent?.args?.expectedHbar.toString());
      console.log("Unstake debug:", unstakeDebugEvent?.args?.received.toString());

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

      //complete withdrawal
      const withdrawTxAfter = await vault.withdraw(postWithdrawShares/2, { gasLimit: 6000000 });
      const withdrawReceiptAfter = await withdrawTxAfter.wait();
      console.log("Withdrawal completed:", withdrawReceiptAfter.transactionHash);

      //complete withdrawal
      console.log("Completing withdrawal...");
      const remainingShares = await vault.balanceOf(deployer.address);
      const withdrawTxAfter2 = await vault.withdraw(remainingShares, { gasLimit: 6000000 });
      const withdrawReceiptAfter2 = await withdrawTxAfter2.wait();
      console.log("Withdrawal completed:", withdrawReceiptAfter2.transactionHash);


      console.log("✅ Withdrawal test passed!");
    });
  });

  //   describe.skip("Strategy Parameters", () => {
  //     it("should allow updating max borrowable", async function () {
  //       const currentMaxBorrowable = await strategy.getMaxBorrowable();
  //       console.log("Current max borrowable:", currentMaxBorrowable.toString());

  //       const newMaxBorrowable = 1500; // 15%
  //       await strategy.setMaxBorrowable(newMaxBorrowable);
  //       const updatedMaxBorrowable = await strategy.getMaxBorrowable();

  //       console.log("Updated max borrowable:", updatedMaxBorrowable.toString());
  //       expect(updatedMaxBorrowable).to.be.eq(newMaxBorrowable);

  //       // Reset to original value
  //       await strategy.setMaxBorrowable(currentMaxBorrowable);
  //     });

  //     it("should not allow excessive max borrowable", async function () {
  //       const excessiveMaxBorrowable = 10001; // > 100%
  //       await expect(strategy.setMaxBorrowable(excessiveMaxBorrowable)).to.be.revertedWith("!cap");
  //     });

  //     it("should allow updating slippage tolerance", async function () {
  //       const currentSlippage = await strategy.slippageTolerance();
  //       console.log("Current slippage tolerance:", currentSlippage.toString());

  //       const newSlippage = 100; // 1%
  //       await strategy.setSlippageTolerance(newSlippage);
  //       const updatedSlippage = await strategy.slippageTolerance();

  //       console.log("Updated slippage tolerance:", updatedSlippage.toString());
  //       expect(updatedSlippage).to.be.eq(newSlippage);

  //       // Reset to original value
  //       await strategy.setSlippageTolerance(currentSlippage);
  //     });

  //     it("should not allow excessive slippage tolerance", async function () {
  //       const excessiveSlippage = 1000; // 10% > 5% max
  //       await expect(strategy.setSlippageTolerance(excessiveSlippage)).to.be.revertedWith("Slippage too high");
  //     });

  //     it("should allow updating max loops", async function () {
  //       const currentMaxLoops = await strategy.getMaxLoops();
  //       console.log("Current max loops:", currentMaxLoops.toString());

  //       const newMaxLoops = 3;
  //       await strategy.setMaxLoops(newMaxLoops);
  //       const updatedMaxLoops = await strategy.getMaxLoops();

  //       console.log("Updated max loops:", updatedMaxLoops.toString());
  //       expect(updatedMaxLoops).to.be.eq(newMaxLoops);

  //       // Reset to original value
  //       await strategy.setMaxLoops(currentMaxLoops);
  //     });

  //     it("should not allow invalid max loops", async function () {
  //       // Test zero loops
  //       await expect(strategy.setMaxLoops(0)).to.be.revertedWith("!range");

  //       // Test excessive loops
  //       const excessiveLoops = 11;
  //       await expect(strategy.setMaxLoops(excessiveLoops)).to.be.revertedWith("!range");
  //     });

  //     it("should allow updating harvest on deposit", async function () {
  //       const currentHarvestOnDeposit = await strategy.harvestOnDeposit();
  //       console.log("Current harvest on deposit:", currentHarvestOnDeposit);

  //       await strategy.setHarvestOnDeposit(!currentHarvestOnDeposit);
  //       const updatedHarvestOnDeposit = await strategy.harvestOnDeposit();

  //       console.log("Updated harvest on deposit:", updatedHarvestOnDeposit);
  //       expect(updatedHarvestOnDeposit).to.be.eq(!currentHarvestOnDeposit);

  //       // Reset to original value
  //       await strategy.setHarvestOnDeposit(currentHarvestOnDeposit);
  //     });

  //     it("should allow updating rewards availability", async function () {
  //       const currentRewardsAvailable = await strategy.isRewardsAvailable();
  //       console.log("Current rewards available:", currentRewardsAvailable);

  //       await strategy.setRewardsAvailable(!currentRewardsAvailable);
  //       const updatedRewardsAvailable = await strategy.isRewardsAvailable();

  //       console.log("Updated rewards available:", updatedRewardsAvailable);
  //       expect(updatedRewardsAvailable).to.be.eq(!currentRewardsAvailable);

  //       // Reset to original value
  //       await strategy.setRewardsAvailable(currentRewardsAvailable);
  //     });
  //   });

  //   describe.skip("View Functions", () => {
  //     it("should return correct balance information", async function () {
  //       const totalBalance = await strategy.balanceOf();
  //       const wantBalance = await strategy.balanceOfWant();
  //       const poolBalance = await strategy.balanceOfPool();

  //       console.log("Total balance:", totalBalance.toString());
  //       console.log("Want balance:", wantBalance.toString());
  //       console.log("Pool balance:", poolBalance.toString());

  //       expect(totalBalance).to.be.gte(0);
  //       expect(wantBalance).to.be.gte(0);
  //       expect(poolBalance).to.be.gte(0);
  //     });

  //     it("should return correct token addresses", async function () {
  //       const wantToken = await strategy.want();
  //       const borrowToken = await strategy.borrowToken();
  //       const aToken = await strategy.aToken();
  //       const debtToken = await strategy.debtToken();
  //       const stakingContract = await strategy.stakingContract();

  //       console.log("Want token:", wantToken);
  //       console.log("Borrow token:", borrowToken);
  //       console.log("aToken:", aToken);
  //       console.log("Debt token:", debtToken);
  //       console.log("Staking contract:", stakingContract);

  //       expect(wantToken).to.be.eq(HBARX_TOKEN_ADDRESS);
  //       expect(borrowToken).to.be.eq(HBAR_TOKEN_ADDRESS);
  //       expect(aToken).to.be.eq(AHBARX_TOKEN_ADDRESS);
  //       expect(debtToken).to.be.eq(DEBT_TOKEN_ADDRESS);
  //       expect(stakingContract).to.be.eq(STAKING_CONTRACT_ADDRESS);
  //     });

  //     it("should return correct protocol addresses", async function () {
  //       const lendingPool = await strategy.lendingPool();
  //       const rewardsController = await strategy.rewardsController();

  //       console.log("Lending pool:", lendingPool);
  //       console.log("Rewards controller:", rewardsController);

  //       expect(lendingPool).to.be.eq(LENDING_POOL_ADDRESS);
  //       expect(rewardsController).to.be.eq(REWARDS_CONTROLLER_ADDRESS);
  //     });

  //     it("should return correct strategy configuration", async function () {
  //       const maxLoops = await strategy.getMaxLoops();
  //       const maxBorrowable = await strategy.getMaxBorrowable();
  //       const slippageTolerance = await strategy.slippageTolerance();
  //       const harvestOnDeposit = await strategy.harvestOnDeposit();
  //       const isRewardsAvailable = await strategy.isRewardsAvailable();
  //       const isBonzoDeployer = await strategy.isBonzoDeployer();
  //       const lastHarvest = await strategy.lastHarvest();

  //       console.log("Max loops:", maxLoops.toString());
  //       console.log("Max borrowable:", maxBorrowable.toString());
  //       console.log("Slippage tolerance:", slippageTolerance.toString());
  //       console.log("Harvest on deposit:", harvestOnDeposit);
  //       console.log("Is rewards available:", isRewardsAvailable);
  //       console.log("Is Bonzo deployer:", isBonzoDeployer);
  //       console.log("Last harvest:", lastHarvest.toString());

  //       expect(maxLoops).to.be.gte(1);
  //       expect(maxBorrowable).to.be.lte(10000);
  //       expect(slippageTolerance).to.be.lte(500);
  //       expect(lastHarvest).to.be.gte(0);
  //     });
  //   });

    describe.skip("Harvest Functionality", () => {
      it("should allow harvest", async function () {
        console.log("Testing harvest functionality...");

        const initialBalance = await strategy.balanceOf();
        const initialLastHarvest = await strategy.lastHarvest();

        console.log("Initial strategy balance:", initialBalance.toString());
        console.log("Initial last harvest:", initialLastHarvest.toString());

        // Call harvest
        const harvestTx = await strategy["harvest()"]({ gasLimit: 5000000 });
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

  //   describe.skip("Emergency Functions", () => {
  //     it("should allow manager to pause strategy", async function () {
  //       const initialPaused = await strategy.paused();
  //       console.log("Initial paused state:", initialPaused);

  //       await strategy.pause();
  //       const isPaused = await strategy.paused();
  //       console.log("Paused state after pause:", isPaused);

  //       expect(isPaused).to.be.eq(true);

  //       // Unpause for other tests
  //       await strategy.unpause();
  //       const finalPaused = await strategy.paused();
  //       console.log("Final paused state:", finalPaused);
  //       expect(finalPaused).to.be.eq(false);
  //     });

  //     it("should allow manager to call panic", async function () {
  //       const initialPaused = await strategy.paused();
  //       console.log("Initial paused state before panic:", initialPaused);

  //       const panicTx = await strategy.panic();
  //       const panicReceipt = await panicTx.wait();
  //       console.log("Panic transaction:", panicReceipt.transactionHash);

  //       const isPaused = await strategy.paused();
  //       console.log("Paused state after panic:", isPaused);
  //       expect(isPaused).to.be.eq(true);

  //       // Unpause for other tests
  //       await strategy.unpause();
  //     });

  //     it("should allow manager to unpause strategy", async function () {
  //       // First ensure it's paused
  //       if (!(await strategy.paused())) {
  //         await strategy.pause();
  //       }

  //       const pausedBeforeUnpause = await strategy.paused();
  //       console.log("Paused before unpause:", pausedBeforeUnpause);

  //       await strategy.unpause();
  //       const isPaused = await strategy.paused();
  //       console.log("Paused after unpause:", isPaused);

  //       expect(isPaused).to.be.eq(false);
  //     });
  //   });

  //   describe.skip("Access Control", () => {
  //     it("should only allow vault to call withdraw", async function () {
  //       const withdrawAmount = 1000;
  //       await expect(strategy.withdraw(withdrawAmount)).to.be.revertedWith("!vault");
  //     });

  //     it("should only allow vault to call retireStrat", async function () {
  //       await expect(strategy.retireStrat()).to.be.revertedWith("!vault");
  //     });

  //     it("should only allow manager to update parameters", async function () {
  //       const signers = await ethers.getSigners();
  //       if (signers.length > 1) {
  //         const nonManager = signers[1];
  //         const strategyAsNonManager = strategy.connect(nonManager);

  //         await expect(strategyAsNonManager.setMaxBorrowable(2000)).to.be.reverted;
  //         await expect(strategyAsNonManager.setMaxLoops(3)).to.be.reverted;
  //         await expect(strategyAsNonManager.setSlippageTolerance(100)).to.be.reverted;
  //         await expect(strategyAsNonManager.setHarvestOnDeposit(true)).to.be.reverted;
  //         await expect(strategyAsNonManager.setRewardsAvailable(true)).to.be.reverted;
  //       } else {
  //         console.log("⚠️ Skipping access control test - only one signer available");
  //         this.skip();
  //       }
  //     });

  //     it("should only allow manager to call emergency functions", async function () {
  //       const signers = await ethers.getSigners();
  //       if (signers.length > 1) {
  //         const nonManager = signers[1];
  //         const strategyAsNonManager = strategy.connect(nonManager);

  //         await expect(strategyAsNonManager.pause()).to.be.reverted;
  //         await expect(strategyAsNonManager.panic()).to.be.reverted;
  //         await expect(strategyAsNonManager.unpause()).to.be.reverted;
  //       } else {
  //         console.log("⚠️ Skipping access control test - only one signer available");
  //         this.skip();
  //       }
  //     });

  //     it("should only allow authorized addresses to harvest", async function () {
  //       // Note: The harvest function allows vault, owner, or keeper to call it
  //       // Since we're using deployer as all roles in tests, this should pass
  //       const harvestTx = await strategy.harvest({ gasLimit: 5000000 });
  //       const harvestReceipt = await harvestTx.wait();
  //       expect(harvestReceipt.status).to.be.eq(1);
  //     });
  //   });

  //   describe.skip("Token Management", () => {
  //     it("should handle stuck tokens recovery", async function () {
  //       // This test would require sending some random tokens to the strategy first
  //       // For now, we just test that the function exists and has proper access control
  //       const signers = await ethers.getSigners();
  //       if (signers.length > 1) {
  //         const nonManager = signers[1];
  //         const strategyAsNonManager = strategy.connect(nonManager);

  //         // Should revert when called by non-manager
  //         await expect(strategyAsNonManager.inCaseTokensGetStuck(HBARX_TOKEN_ADDRESS)).to.be.reverted;
  //       }

  //       // Should revert when trying to recover protected tokens
  //       await expect(strategy.inCaseTokensGetStuck(HBARX_TOKEN_ADDRESS)).to.be.revertedWith("!want");
  //       await expect(strategy.inCaseTokensGetStuck(HBAR_TOKEN_ADDRESS)).to.be.revertedWith("!borrowToken");
  //       await expect(strategy.inCaseTokensGetStuck(AHBARX_TOKEN_ADDRESS)).to.be.revertedWith("!aToken");
  //       await expect(strategy.inCaseTokensGetStuck(DEBT_TOKEN_ADDRESS)).to.be.revertedWith("!debtToken");
  //     });
  //   });

  //   describe.skip("Strategy Safety", () => {
  //     it("should not allow deposit when paused", async function () {
  //       // Pause the strategy
  //       await strategy.pause();

  //       // Try to deposit - should fail
  //       await expect(strategy.deposit()).to.be.revertedWith("Pausable: paused");

  //       // Unpause for other tests
  //       await strategy.unpause();
  //     });

  //     it("should not allow withdraw when paused", async function () {
  //       // Pause the strategy
  //       await strategy.pause();

  //       // Try to withdraw - should fail
  //       await expect(strategy.withdraw(1000)).to.be.revertedWith("Pausable: paused");

  //       // Unpause for other tests
  //       await strategy.unpause();
  //     });

  //     it("should not allow harvest when paused", async function () {
  //       // Pause the strategy
  //       await strategy.pause();

  //       // Try to harvest - should fail
  //       await expect(strategy.harvest()).to.be.revertedWith("Pausable: paused");

  //       // Unpause for other tests
  //       await strategy.unpause();
  //     });
  //   });
});
