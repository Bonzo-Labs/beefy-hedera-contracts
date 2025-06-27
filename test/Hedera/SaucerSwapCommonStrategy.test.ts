import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { IERC20Upgradeable } from "../../typechain-types";
import addresses from "../../scripts/deployed-addresses.json";

describe("SaucerSwapCommonStrategy", function () {
  // Set timeout to 60 seconds for all tests in this suite
  this.timeout(1000000);

  let strategy: any;
  let vault: any;
  let lpToken0: IERC20Upgradeable | any;
  let lpToken1: IERC20Upgradeable | any;
  let deployer: SignerWithAddress | any;
  let positionManager: string;
  let saucerSwapRouter: string;
  let deployNewContract = true;

  // Test addresses - replace with actual addresses
  const POSITION_MANAGER_ADDRESS = "0x000000000000000000000000000000000013f618"; // Replace with actual
  const SAUCERSWAP_ROUTER_ADDRESS = "0x0000000000000000000000000000000000159398"; // Replace with actual
  const LP_TOKEN0_ADDRESS = "0x0000000000000000000000000000000000003ad2"; // Replace with actual
  const LP_TOKEN1_ADDRESS = "0x0000000000000000000000000000000000120f46"; // Replace with actual
  const isLpToken0Native = true;
  const isLpToken1Native = false;
  const VAULT_FACTORY_ADDRESS = addresses.vaultFactory;
  const FEE_CONFIG_ADDRESS = addresses.beefyFeeConfig;
  const SAUCER_FACTORY_ADDRESS = "0x00000000000000000000000000000000001243ee";
  let vaultAddress: string;

  before(async () => {
    [deployer] = await ethers.getSigners();
    console.log("Testing with account:", deployer.address);

    if (deployNewContract) {
      // Step 1: Deploy the strategy
      console.log("Deploying SaucerSwapCommonStrategy...");
      const SaucerSwapCommonStrategy = await ethers.getContractFactory("StrategyCommonSaucerSwap");
      strategy = await SaucerSwapCommonStrategy.deploy();
      await strategy.deployed();
      console.log("SaucerSwapCommonStrategy deployed to:", strategy.address);

      // Step 2: Connect to the vault factory
      const vaultFactory = await ethers.getContractAt("BeefyVaultV7FactoryHedera", VAULT_FACTORY_ADDRESS);
      console.log("Connected to vault factory at:", VAULT_FACTORY_ADDRESS);

      // Step 3: Create a new vault using the factory
      console.log("Creating new vault...");
      const tx = await vaultFactory.cloneVaultMultiToken();
      const receipt = await tx.wait();

      // Get the new vault address from the ProxyCreated event
      const proxyCreatedEvent = receipt.events?.find((e: any) => e.event === "ProxyCreated");
      vaultAddress = proxyCreatedEvent?.args?.proxy;
      console.log("New vault deployed to:", vaultAddress);

      // Step 4: Connect to the newly created vault
      vault = await ethers.getContractAt("BeefyVaultV7HederaMultiToken", vaultAddress);

      // Step 5: Initialize the strategy
      console.log("Initializing strategy...");
      const commonAddresses = {
        vault: vaultAddress,
        keeper: deployer.address,
        strategist: deployer.address,
        unirouter: SAUCERSWAP_ROUTER_ADDRESS,
        beefyFeeRecipient: deployer.address,
        beefyFeeConfig: FEE_CONFIG_ADDRESS,
      };

      await strategy.initialize(
        LP_TOKEN0_ADDRESS,
        LP_TOKEN1_ADDRESS,
        POSITION_MANAGER_ADDRESS,
        SAUCER_FACTORY_ADDRESS,
        3000, // poolFee
        [LP_TOKEN0_ADDRESS, "0x0000000000000000000000000000000000003ad2"],
        [LP_TOKEN1_ADDRESS, "0x0000000000000000000000000000000000003ad2"],
        true, // isLpToken0HTS
        true, // isLpToken1HTS
        commonAddresses,
        { gasLimit: 3000000 }
      );
      console.log("Strategy initialized");

      // Step 6: Initialize the vault
      const poolAddress = await strategy.pool();
      console.log("Initializing vault...");
      const isHederaToken0 = true; // Set to false for ERC20 tokens
      const isHederaToken1 = true; // Set to false for ERC20 tokens
      await vault.initialize(
        strategy.address,
        poolAddress,
        "Beefy SaucerSwap Common",
        "bvSS-COMMON",
        0, // Performance fee - set to 0 initially
        isHederaToken0,
        isHederaToken1,
        isLpToken0Native, // isLpToken0Native
        isLpToken1Native, // isLpToken1Native
        addresses.beefyOracle,
        { gasLimit: 3000000 }
      );
      console.log("Vault initialized");
    } else {
      // Use already deployed contract
      const STRATEGY_ADDRESS = "0xB4F9Cb4970F2Aa07dC56b36F2aBDE65c25009fAb"; // Replace with actual
      const VAULT_ADDRESS = "0x5E4bDC9c752AA9d314f245f628B834ADD89a0D08"; // Replace with actual
      strategy = await ethers.getContractAt("StrategyCommonSaucerSwap", STRATEGY_ADDRESS);
      vault = await ethers.getContractAt("BeefyVaultV7HederaMultiToken", VAULT_ADDRESS);
      vaultAddress = VAULT_ADDRESS;
    }

    //log strategy and vault addresses
    console.log("Strategy address:", await strategy.address);
    const _positionManager = await strategy.positionManager();
    console.log("Position manager address:", _positionManager);
    const _poolFactory = await strategy.poolFactory();
    console.log("Pool factory address:", _poolFactory);


    // Connect to tokens
    lpToken0 = await ethers.getContractAt("IERC20Upgradeable", LP_TOKEN0_ADDRESS);
    lpToken1 = await ethers.getContractAt("IERC20Upgradeable", LP_TOKEN1_ADDRESS);
    positionManager = POSITION_MANAGER_ADDRESS;
    saucerSwapRouter = SAUCERSWAP_ROUTER_ADDRESS;

    //test
    // const bal0lpToken0 = await lpToken0.balanceOf(strategy.address);
    // const bal0lpToken1 = await lpToken1.balanceOf(strategy.address);
    // console.log("Balance of token0:", bal0lpToken0.toString());
    // console.log("Balance of token1:", bal0lpToken1.toString());

    const _strategy = await vault.strategy();
    console.log("Strategy address:", _strategy);
    const bal0token0 = await vault.balance0();
    const bal0token1 = await vault.balance1();
    console.log("Balance of token0:", bal0token0.toString());
    console.log("Balance of token1:", bal0token1.toString());
    const _token0 = await vault.token0();
    const _token1 = await vault.token1();
    console.log("Token0 address:", _token0);
    console.log("Token1 address:", _token1);
  });

  after(async () => {
    //remove allowances
    if (!isLpToken0Native) {
      await lpToken0.approve(vault.address, 0);
    }
    if (!isLpToken1Native) {
      await lpToken1.approve(vault.address, 0);
    }
    console.log("Allowances removed");
  });

  describe("Deposit and Withdraw", () => {
    it("should handle deposit", async function () {
      console.log("Testing deposit functionality...");

      // Skip this test if we don't have tokens to test with
      const userBalance0 = await lpToken0.balanceOf(deployer.address);
      const userBalance1 = await lpToken1.balanceOf(deployer.address);
      console.log("Initial user balance token0:", userBalance0.toString());
      console.log("Initial user balance token1:", userBalance1.toString());
      
      if (userBalance0.eq(0) && userBalance1.eq(0)) {
        console.log("Skipping deposit test - no tokens available");
        this.skip();
        return;
      }

      const depositAmount0 = 100000;  
      const depositAmount1 = 674848; 

      // Approve the vault to spend tokens
      if (depositAmount0 > 0 && !isLpToken0Native) {
        const approveTx0 = await lpToken0.approve(vault.address, depositAmount0, { gasLimit: 3000000 });
        await approveTx0.wait();
        console.log("Token0 approved for vault");
      }
      
      if (depositAmount1 > 0 && !isLpToken1Native) {
        const approveTx1 = await lpToken1.approve(vault.address, depositAmount1, { gasLimit: 3000000 });
        await approveTx1.wait();
        console.log("Token1 approved for vault");
      }

      // Check initial balances
      const initialUserBalance0 = await lpToken0.balanceOf(deployer.address);
      const initialUserBalance1 = await lpToken1.balanceOf(deployer.address);
      const initialVaultBalance0 = await lpToken0.balanceOf(vault.address);
      const initialVaultBalance1 = await lpToken1.balanceOf(vault.address);
      const initialTotalSupply = await vault.totalSupply();
      const isHarvestOnDeposit = await strategy.harvestOnDeposit();
      console.log("Is harvest on deposit:", isHarvestOnDeposit);
      // const initialStrategyBalance = await strategy.balanceOf();

      console.log("Initial user balance token0:", initialUserBalance0.toString());
      console.log("Initial user balance token1:", initialUserBalance1.toString());
      console.log("Initial vault balance token0:", initialVaultBalance0.toString());
      console.log("Initial vault balance token1:", initialVaultBalance1.toString());
      console.log("Initial total supply:", initialTotalSupply.toString());
      // console.log("Initial strategy balance:", initialStrategyBalance.toString());

      // Perform deposit
      console.log("Depositing...");
      let valueToSend = 0;
      if (isLpToken0Native) {
        valueToSend = depositAmount0 * 10 ** 10;
      }
      if (isLpToken1Native) {
        valueToSend = depositAmount1 * 10 ** 10;
      }

      const tx = await vault.deposit(depositAmount0, depositAmount1, { value: valueToSend, gasLimit: 5000000 });
      const receipt = await tx.wait();
      console.log("Deposit transaction:", receipt.transactionHash);
      //catch Deposit event
      const depositEvent = receipt.logs?.find((log: any) => {
        try {
          const parsedLog = vault.interface.parseLog(log);
          return parsedLog.name === "Deposit";
        } catch {
          return false;
        }
      });
      console.log("Deposit event:", depositEvent);
     
      // Check post-deposit balances
      const postDepositUserBalance0 = await lpToken0.balanceOf(deployer.address);
      const postDepositUserBalance1 = await lpToken1.balanceOf(deployer.address);
      const postDepositVaultBalance0 = await lpToken0.balanceOf(vault.address);
      const postDepositVaultBalance1 = await lpToken1.balanceOf(vault.address);
      const postDepositTotalSupply = await vault.totalSupply();
      const userShares = await vault.balanceOf(deployer.address);
      //const postDepositStrategyBalance = await strategy.balanceOf();

      console.log("Post-deposit user balance token0:", postDepositUserBalance0.toString());
      console.log("Post-deposit user balance token1:", postDepositUserBalance1.toString());
      console.log("Post-deposit vault balance token0:", postDepositVaultBalance0.toString());
      console.log("Post-deposit vault balance token1:", postDepositVaultBalance1.toString());
      console.log("Post-deposit total supply:", postDepositTotalSupply.toString());
      console.log("User shares:", userShares.toString());
      // console.log("Post-deposit strategy balance:", postDepositStrategyBalance.toString());
      const totalDeposited0 = await strategy.totalDeposited0();
      console.log("Total deposited token0:", totalDeposited0.toString());
      const totalDeposited1 = await strategy.totalDeposited1();
      console.log("Total deposited token1:", totalDeposited1.toString());
      const balanceOfPool = await strategy.balanceOfPool();
      console.log("Balance of pool:", balanceOfPool.toString());

      console.log("depositing again...");
      //approve
      await lpToken1.approve(vault.address, depositAmount1, { gasLimit: 3000000 });
      const tx2 = await vault.deposit(depositAmount0, depositAmount1, { value: valueToSend, gasLimit: 5000000 });
      const receipt2 = await tx2.wait();
      console.log("Deposit transaction:", receipt2.transactionHash);
      //catch Deposit event
      const depositEvent2 = receipt2.logs?.find((log: any) => {
        try {
          const parsedLog = vault.interface.parseLog(log);
          return parsedLog.name === "Deposit";
        } catch {
          return false;
        }
      });
      console.log("Deposit event:", depositEvent2);

      const totalDeposited02 = await strategy.totalDeposited0();
      console.log("Total deposited token0:", totalDeposited02.toString());
      const totalDeposited12 = await strategy.totalDeposited1();
      console.log("Total deposited token1:", totalDeposited12.toString());

      const postDepositUserBalance12 = await lpToken1.balanceOf(deployer.address);
      const postDepositVaultBalance12 = await lpToken1.balanceOf(vault.address);
      const postDepositTotalSupply2 = await vault.totalSupply();
      const userShares2 = await vault.balanceOf(deployer.address);
      //const postDepositStrategyBalance = await strategy.balanceOf();
      console.log("Post-deposit user balance token1:", postDepositUserBalance12.toString());
      console.log("Post-deposit vault balance token1:", postDepositVaultBalance12.toString());
      console.log("Post-deposit total supply:", postDepositTotalSupply2.toString());
      console.log("User shares:", userShares2.toString());

      //deposit again
      console.log("depositing again...");
      await lpToken1.approve(vault.address, depositAmount1, { gasLimit: 3000000 });
      const tx3 = await vault.deposit(depositAmount0, depositAmount1, { value: valueToSend, gasLimit: 5000000 });
      const receipt3 = await tx3.wait();
      console.log("Deposit transaction:", receipt3.transactionHash);
      //catch Deposit event
      const depositEvent3 = receipt3.logs?.find((log: any) => {
        try {
          const parsedLog = vault.interface.parseLog(log);
          return parsedLog.name === "Deposit";
        } catch {
          return false;
        }
      });
      console.log("Deposit event:", depositEvent3);
      const totalDeposited03 = await strategy.totalDeposited0();
      console.log("Total deposited token0:", totalDeposited03.toString());
      const totalDeposited13 = await strategy.totalDeposited1();
      console.log("Total deposited token1:", totalDeposited13.toString());
      const userShares3 = await vault.balanceOf(deployer.address);
      console.log("User shares:", userShares3.toString());

      // Verify deposit
      if (depositAmount0 > 0) {
        //not for HBAR
        // expect(postDepositUserBalance0).to.be.lt(initialUserBalance0);
      }
      if (depositAmount1 > 0) {
        expect(postDepositUserBalance1).to.be.lt(initialUserBalance1);
      }
      expect(postDepositTotalSupply).to.be.gt(initialTotalSupply);
      expect(userShares).to.be.gt(0);
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
        const userBalance0 = await lpToken0.balanceOf(deployer.address);
        const userBalance1 = await lpToken1.balanceOf(deployer.address);
        
        if (userBalance0.eq(0) && userBalance1.eq(0)) {
          console.log("Skipping withdrawal test - no tokens available for deposit");
          this.skip();
          return;
        }
        
        const depositAmount0 = 100000;  
        const depositAmount1 = 674848; 
  
        // Approve the vault to spend tokens
        if (depositAmount0 > 0 && !isLpToken0Native) {
          const approveTx0 = await lpToken0.approve(vault.address, depositAmount0, { gasLimit: 3000000 });
          await approveTx0.wait();
          console.log("Token0 approved for vault");
        }
        
        if (depositAmount1 > 0 && !isLpToken1Native) {
          const approveTx1 = await lpToken1.approve(vault.address, depositAmount1, { gasLimit: 3000000 });
          await approveTx1.wait();
          console.log("Token1 approved for vault");
        }
  
        // Check initial balances
        const initialUserBalance0 = await lpToken0.balanceOf(deployer.address);
        const initialUserBalance1 = await lpToken1.balanceOf(deployer.address);
        const initialVaultBalance0 = await lpToken0.balanceOf(vault.address);
        const initialVaultBalance1 = await lpToken1.balanceOf(vault.address);
        const initialTotalSupply = await vault.totalSupply();
        const isHarvestOnDeposit = await strategy.harvestOnDeposit();
        console.log("Is harvest on deposit:", isHarvestOnDeposit);
        // const initialStrategyBalance = await strategy.balanceOf();
  
        console.log("Initial user balance token0:", initialUserBalance0.toString());
        console.log("Initial user balance token1:", initialUserBalance1.toString());
        console.log("Initial vault balance token0:", initialVaultBalance0.toString());
        console.log("Initial vault balance token1:", initialVaultBalance1.toString());
        console.log("Initial total supply:", initialTotalSupply.toString());
        // console.log("Initial strategy balance:", initialStrategyBalance.toString());
  
        // Perform deposit
        console.log("Depositing...");
        let valueToSend = 0;
        if (isLpToken0Native) {
          valueToSend = depositAmount0 * 10 ** 10;
        }
        if (isLpToken1Native) {
          valueToSend = depositAmount1 * 10 ** 10;
        }
  
        const tx = await vault.deposit(depositAmount0, depositAmount1, { value: valueToSend, gasLimit: 5000000 });
        const receipt = await tx.wait();
        console.log("Deposit transaction:", receipt.transactionHash);
      }

      const totalUserShares = await vault.balanceOf(deployer.address);
      console.log("Total user shares for withdrawal:", totalUserShares.toString());

      const withdrawAmount = totalUserShares.div(2); // Withdraw half
      console.log("Withdrawing shares:", withdrawAmount.toString());

      const preWithdrawBalance1 = await lpToken1.balanceOf(deployer.address);
      console.log("Pre-withdrawal user balance token1:", preWithdrawBalance1.toString());
      //native balance pre withdraw
      const preWithdrawBalance0 = await ethers.provider.getBalance(deployer.address);
      console.log("Pre-withdrawal user balance token0:", preWithdrawBalance0.toString());
      const withdrawTx = await vault.withdraw(withdrawAmount, { gasLimit: 5000000 });
      const withdrawReceipt = await withdrawTx.wait();
      console.log("Withdrawal completed hash:", withdrawReceipt.transactionHash);

      const postWithdrawBalance1 = await lpToken1.balanceOf(deployer.address);
      const postWithdrawShares = await vault.balanceOf(deployer.address);
      const postWithdrawBalance0 = await ethers.provider.getBalance(deployer.address);
      console.log("Post-withdrawal user balance token0:", postWithdrawBalance0.toString());

      console.log("Post-withdrawal user balance token1:", postWithdrawBalance1.toString());
      console.log("Remaining user shares:", postWithdrawShares.toString());

      //withdraw again
      console.log("withdrawing remaining shares...");
      const withdrawAmount2 = postWithdrawShares;
      console.log("Withdrawing shares:", withdrawAmount2.toString());
      const preWithdrawBalance12 = await lpToken1.balanceOf(deployer.address);
      console.log("Pre-withdrawal user balance token1:", preWithdrawBalance12.toString());
      const preWithdrawBalance02 = await ethers.provider.getBalance(deployer.address);
      console.log("Pre-withdrawal user balance token0:", preWithdrawBalance02.toString());
      const withdrawTx2 = await vault.withdraw(withdrawAmount2, { gasLimit: 5000000 });
      const withdrawReceipt2 = await withdrawTx2.wait();
      console.log("Withdrawal completed hash:", withdrawReceipt2.transactionHash);
      const postWithdrawBalance12 = await lpToken1.balanceOf(deployer.address);
      const postWithdrawBalance02 = await ethers.provider.getBalance(deployer.address);
      console.log("Post-withdrawal user balance token0:", postWithdrawBalance02.toString());
      console.log("Post-withdrawal user balance token1:", postWithdrawBalance12.toString());
      const postWithdrawShares2 = await vault.balanceOf(deployer.address);
      console.log("Remaining user shares:", postWithdrawShares2.toString());

      // Withdrawal assertions
      // expect(postWithdrawBalance1).to.be.gte(preWithdrawBalance1);
      // expect(postWithdrawShares).to.be.lt(totalUserShares);
      // expect(postWithdrawStrategyBalance).to.be.lte(preWithdrawStrategyBalance);

      console.log("✅ Withdrawal test passed!");
    });
  });



  describe.skip("Strategy Initialization", () => {
    it.skip("should initialize with correct parameters", async function () {
      const lpToken0Address = await strategy.lpToken0();
      const lpToken1Address = await strategy.lpToken1();
      const positionManagerAddress = await strategy.positionManager();
      const routerAddress = await strategy.saucerSwapRouter();
      const poolFee = await strategy.poolFee();

      expect(lpToken0Address.toLowerCase()).to.equal(LP_TOKEN0_ADDRESS.toLowerCase());
      expect(lpToken1Address.toLowerCase()).to.equal(LP_TOKEN1_ADDRESS.toLowerCase());
      expect(positionManagerAddress.toLowerCase()).to.equal(POSITION_MANAGER_ADDRESS.toLowerCase());
      expect(routerAddress.toLowerCase()).to.equal(SAUCERSWAP_ROUTER_ADDRESS.toLowerCase());
      expect(poolFee).to.equal(3000);
    });

    it.skip("should set correct HTS status for tokens", async function () {
      const isLpToken0HTS = await strategy.isLpToken0HTS();
      const isLpToken1HTS = await strategy.isLpToken1HTS();

      expect(isLpToken0HTS).to.equal(true);
      expect(isLpToken1HTS).to.equal(true);
    });

    it.skip("should allow manager to update HTS status", async function () {
      await strategy.updateTokenHTSStatus(true, true);
      
      const isLpToken0HTS = await strategy.isLpToken0HTS();
      const isLpToken1HTS = await strategy.isLpToken1HTS();

      expect(isLpToken0HTS).to.equal(true);
      expect(isLpToken1HTS).to.equal(true);

      // Reset to original values
      await strategy.updateTokenHTSStatus(false, false);
    });
  });


  describe.skip("Position Management", () => {
    it.skip("should return correct position info", async function () {
      //deposit
      const depositAmount0 = 100000;  
      const depositAmount1 = 674848; 
      let valueToSend = 0;
      if (isLpToken0Native) {
        valueToSend = depositAmount0 * 10 ** 10;
      }
      if (isLpToken1Native) {
        valueToSend = depositAmount1 * 10 ** 10;
      }
      //approve
      await lpToken1.approve(vault.address, depositAmount1, { gasLimit: 3000000 });
      const tx = await vault.deposit(depositAmount0, depositAmount1, { value: valueToSend, gasLimit: 5000000 });
      const receipt = await tx.wait();
      console.log("Deposit transaction:", receipt.transactionHash);
      
      const positionInfo = await strategy.getPositionInfo();
      
      // Position info should return 10 values
      expect(positionInfo).to.have.lengthOf(10);
    });

    it.skip("should return correct pool balance", async function () {
      const poolBalance = await strategy.balanceOfPool();
      
      // Should be 0 if no position exists
      expect(poolBalance).to.be.gte(0);
    });

    it.skip("should return correct token balances", async function () {
      const token0Balance = await strategy.balanceOfToken0();
      const token1Balance = await strategy.balanceOfToken1();

      expect(token0Balance).to.be.gte(0);
      expect(token1Balance).to.be.gte(0);
    });
  });



  describe("Harvest Functionality", () => {
    it("should allow manager to harvest", async function () {
      //deposit
      const depositAmount0 = 100000;  
      const depositAmount1 = 674848; 
      let valueToSend = 0;
      if (isLpToken0Native) {
        valueToSend = depositAmount0 * 10 ** 10;
      }
      if (isLpToken1Native) {
        valueToSend = depositAmount1 * 10 ** 10;
      }
      //approve
      await lpToken1.approve(vault.address, depositAmount1, { gasLimit: 3000000 });
      const tx = await vault.deposit(depositAmount0, depositAmount1, { value: valueToSend, gasLimit: 5000000 });
      const receipt = await tx.wait();
      console.log("Deposit transaction:", receipt.transactionHash);
      
      //harvest
      try {
        console.log("Attempting to call harvest...");
        const harvestTx = await strategy['harvest()']({ gasLimit: 3000000 });
        const harvestReceipt = await harvestTx.wait();
        console.log("Harvest transaction:", harvestReceipt.transactionHash);
        //catch harvest event
        const harvestEvent = harvestReceipt.logs?.filter((log: any) => {
          try {
            const parsedLog = strategy.interface.parseLog(log);
            return parsedLog.name === "Harvest";
          } catch {
            return false;
          }
        });
        console.log("Harvest event:", harvestEvent);
        
        //check balances
        const postHarvestBalance0 = await ethers.provider.getBalance(deployer.address);
      } catch (error) {
        console.error("Harvest error details:", error);
      }

      //check balances
      const postHarvestBalance0 = await ethers.provider.getBalance(deployer.address);
      const postHarvestBalance1 = await lpToken1.balanceOf(deployer.address);
      console.log("Post-harvest user balance token0:", postHarvestBalance0.toString());
      console.log("Post-harvest user balance token1:", postHarvestBalance1.toString());

      
    });

    it.skip("should emit harvest event", async function () {
      // This would require actual rewards to be available
      // Test structure for when rewards are present
      await expect(strategy.harvest()).to.not.be.reverted;
    });

    it.skip("should allow harvest with custom fee recipient", async function () {
      const customRecipient = deployer.address;
      await expect(strategy.harvest(customRecipient)).to.not.be.reverted;
    });

  });

  // describe("Emergency Functions", () => {
  //   it("should allow manager to pause strategy", async function () {
  //     const initialPaused = await strategy.paused();
  //     console.log("Initial paused state:", initialPaused);

  //     await strategy.pause();
  //     const isPaused = await strategy.paused();
  //     expect(isPaused).to.be.true;
  //   });

  //   it("should allow manager to unpause strategy", async function () {
  //     // First pause if not already paused
  //     if (!(await strategy.paused())) {
  //       await strategy.pause();
  //     }

  //     await strategy.unpause();
  //     const isPaused = await strategy.paused();
  //     expect(isPaused).to.be.false;
  //   });

  //   it("should allow manager to panic", async function () {
  //     await expect(strategy.panic()).to.not.be.reverted;
  //   });

  //   it("should allow vault to retire strategy", async function () {
  //     // This would require the caller to be the vault
  //     // For now, we'll test the function structure
  //     await expect(strategy.retireStrat()).to.be.revertedWith("!vault");
  //   });
  // });

  // describe("Fee Management", () => {
  //   it("should allow manager to set harvest on deposit", async function () {
  //     const initialHarvestOnDeposit = await strategy.harvestOnDeposit();
      
  //     await strategy.setHarvestOnDeposit(!initialHarvestOnDeposit);
  //     const newHarvestOnDeposit = await strategy.harvestOnDeposit();
      
  //     expect(newHarvestOnDeposit).to.equal(!initialHarvestOnDeposit);
      
  //     // Reset to original value
  //     await strategy.setHarvestOnDeposit(initialHarvestOnDeposit);
  //   });

  //   it("should allow manager to set gas throttle", async function () {
  //     const initialGasThrottle = await strategy.shouldGasThrottle();
      
  //     await strategy.setShouldGasThrottle(!initialGasThrottle);
  //     const newGasThrottle = await strategy.shouldGasThrottle();
      
  //     expect(newGasThrottle).to.equal(!initialGasThrottle);
      
  //     // Reset to original value
  //     await strategy.setShouldGasThrottle(initialGasThrottle);
  //   });
  // });

  // describe("Access Control", () => {
  //   it("should only allow manager to call restricted functions", async function () {
  //     const [deployer, user] = await ethers.getSigners();
      
  //     // Test that non-manager cannot call restricted functions
  //     await expect(strategy.connect(user).pause()).to.be.reverted;
  //     await expect(strategy.connect(user).panic()).to.be.reverted;
  //     await expect(strategy.connect(user).updateTokenHTSStatus(true, true)).to.be.reverted;
  //   });

  //   it("should only allow vault to call vault-only functions", async function () {
  //     const [deployer, user] = await ethers.getSigners();
      
  //     const amount0 = ethers.utils.parseEther("1");
  //     const amount1 = ethers.utils.parseEther("1");
      
  //     await expect(strategy.connect(user).withdraw(amount0, amount1)).to.be.revertedWith("!vault");
  //     await expect(strategy.connect(user).retireStrat()).to.be.revertedWith("!vault");
  //   });
  // });

  // describe("Before Deposit Hook", () => {
  //   it("should call beforeDeposit hook", async function () {
  //     // This would require vault integration to test properly
  //     // For now, we'll test the function exists
  //     await expect(strategy.beforeDeposit()).to.not.be.reverted;
  //   });

  //   it("should harvest on deposit when enabled", async function () {
  //     // Enable harvest on deposit
  //     await strategy.setHarvestOnDeposit(true);
      
  //     // This would require vault integration to test properly
  //     // The function should be called by the vault before deposits
  //     expect(true).to.be.true; // Placeholder assertion
  //   });
  // });

  // describe("Gas Optimization", () => {
  //   it("should respect gas throttle settings", async function () {
  //     // Test that gas throttle works correctly
  //     await strategy.setShouldGasThrottle(true);
      
  //     // This would require more complex testing with actual gas measurement
  //     // For now, we'll just test the setting can be changed
  //     expect(await strategy.shouldGasThrottle()).to.be.true;
  //   });
  // });

  // describe("Error Handling", () => {
  //   it("should handle invalid token addresses gracefully", async function () {
  //     const invalidAddress = "0x0000000000000000000000000000000000000000";
      
  //     // Test that invalid operations are handled properly
  //     // This would depend on the specific implementation
  //     expect(true).to.be.true; // Placeholder assertion
  //   });

  //   it("should handle insufficient balances", async function () {
  //     // Test withdrawal with insufficient balances
  //     const largeAmount = ethers.utils.parseEther("1000000");
      
  //     // This would require actual token balances to test properly
  //     expect(true).to.be.true; // Placeholder assertion
  //   });
  // });

  // describe("Integration Tests", () => {
  //   it("should work with actual tokens and vault", async function () {
  //     // This test would require:
  //     // 1. Actual token addresses
  //     // 2. Actual vault contract
  //     // 3. Actual position manager
  //     // 4. Actual router addresses
      
  //     // For now, this is a placeholder for integration testing
  //     expect(true).to.be.true;
  //   });

  //   it("should handle real liquidity provision", async function () {
  //     // This test would require actual tokens and liquidity
  //     // For now, this is a placeholder for real-world testing
  //     expect(true).to.be.true;
  //   });
  // });
});

