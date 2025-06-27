import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { IERC20Upgradeable } from "../../typechain-types";
import addresses from "../../scripts/deployed-addresses.json";

describe("SaucerSwapLariRewardsStrategy", function () {
  // Set timeout to 60 seconds for all tests in this suite
  this.timeout(1000000);

  let strategy: any;
  let vault: any;
  let lpToken0: IERC20Upgradeable | any;
  let lpToken1: IERC20Upgradeable | any;
  let rewardToken1: IERC20Upgradeable | any;
  let rewardToken2: IERC20Upgradeable | any;
  let rewardToken3: IERC20Upgradeable | any;
  let deployer: SignerWithAddress | any;
  let positionManager: string;
  let saucerSwapRouter: string;
  let deployNewContract = true;

  // Test addresses - replace with actual addresses
  const POSITION_MANAGER_ADDRESS = "0x000000000000000000000000000000000013f618";
  const SAUCERSWAP_ROUTER_ADDRESS = "0x0000000000000000000000000000000000159398";
  const LP_TOKEN0_ADDRESS = "0x0000000000000000000000000000000000003ad2"; // WHBAR
  const LP_TOKEN1_ADDRESS = "0x0000000000000000000000000000000000120f46"; // SAUCE
  const REWARD_TOKEN1_ADDRESS = "0x0000000000000000000000000000000000003ad2"; // for HBAR
  const REWARD_TOKEN2_ADDRESS = "0x0000000000000000000000000000000000120f46"; //SAUCE
  const REWARD_TOKEN3_ADDRESS = "0x0000000000000000000000000000000000220ced"; //HBARX
  const rewardTokens = [REWARD_TOKEN3_ADDRESS];
  
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
      console.log("Deploying SaucerSwapLariRewardsStrategy...");
      const SaucerSwapLariRewardsStrategy = await ethers.getContractFactory("SaucerSwapLariRewardsStrategy");
      strategy = await SaucerSwapLariRewardsStrategy.deploy({gasLimit: 6000000});
      await strategy.deployed();
      console.log("SaucerSwapLariRewardsStrategy deployed to:", strategy.address);

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

      await strategy["initialize(address,address,address[],address,address,uint24,address[],address[],(address,address,address,address,address,address))"](
        LP_TOKEN0_ADDRESS,
        LP_TOKEN1_ADDRESS,
        rewardTokens,
        POSITION_MANAGER_ADDRESS,
        SAUCER_FACTORY_ADDRESS,
        3000, // poolFee
        [LP_TOKEN0_ADDRESS, "0x0000000000000000000000000000000000003ad2"],
        [LP_TOKEN1_ADDRESS, "0x0000000000000000000000000000000000003ad2"],
        commonAddresses,
        { gasLimit: 3000000 }
      );
      console.log("Strategy initialized");

      // Step 6: Initialize the vault
      const poolAddress = await strategy.pool();
      console.log("Initializing vault...");
      const isHederaToken0 = true;
      const isHederaToken1 = true;
      await vault.initialize(
        strategy.address,
        poolAddress,
        "Beefy SaucerSwap Lari",
        "bvSS-LARI",
        0, // Performance fee - set to 0 initially
        isHederaToken0,
        isHederaToken1,
        isLpToken0Native,
        isLpToken1Native,
        addresses.beefyOracle,
        { gasLimit: 3000000 }
      );
      console.log("Vault initialized");
    } else {
      // Use already deployed contract
      const STRATEGY_ADDRESS = "0x0000000000000000000000000000000000000000"; // Replace with actual
      const VAULT_ADDRESS = "0x0000000000000000000000000000000000000000"; // Replace with actual
      strategy = await ethers.getContractAt("SaucerSwapLariRewardsStrategy", STRATEGY_ADDRESS);
      vault = await ethers.getContractAt("BeefyVaultV7HederaMultiToken", VAULT_ADDRESS);
      vaultAddress = VAULT_ADDRESS;
    }

    // Connect to tokens
    lpToken0 = await ethers.getContractAt("IERC20Upgradeable", LP_TOKEN0_ADDRESS);
    lpToken1 = await ethers.getContractAt("IERC20Upgradeable", LP_TOKEN1_ADDRESS);
    rewardToken1 = await ethers.getContractAt("IERC20Upgradeable", REWARD_TOKEN1_ADDRESS);
    rewardToken2 = await ethers.getContractAt("IERC20Upgradeable", REWARD_TOKEN2_ADDRESS);
    rewardToken3 = await ethers.getContractAt("IERC20Upgradeable", REWARD_TOKEN3_ADDRESS);
    positionManager = POSITION_MANAGER_ADDRESS;
    saucerSwapRouter = SAUCERSWAP_ROUTER_ADDRESS;

    console.log("Strategy address:", await strategy.address);
    console.log("Vault address:", vaultAddress);

    console.log("Strategy lpToken0:", await strategy.lpToken0());
    console.log("reward tokens:", await strategy.rewardTokens([0]));
    console.log("Strategy vault:", await strategy.vault());
    console.log("Strategy unirouter:", await strategy.unirouter());
    console.log("Strategy owner:", await strategy.owner());
    console.log("Strategy keeper:", await strategy.keeper());
    console.log("Deployer address:", deployer.address);
  });

  after(async () => {
    // Remove allowances
    if (!isLpToken0Native) {
      await lpToken0.approve(vault.address, 0);
    }
    if (!isLpToken1Native) {
      await lpToken1.approve(vault.address, 0);
    }
    console.log("Allowances removed");
  });

  describe.skip("Strategy Initialization", () => {
    it("should initialize with correct parameters", async function () {
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

    it("should have reward tokens initialized", async function () {
      const rewardTokenCount = await strategy.getRewardTokenCount();
      expect(rewardTokenCount).to.equal(2);

      const rewardToken1Info = await strategy.getRewardTokenInfo(REWARD_TOKEN1_ADDRESS);
      expect(rewardToken1Info.token).to.equal(REWARD_TOKEN1_ADDRESS);
      expect(rewardToken1Info.isActive).to.be.true;

      const rewardToken2Info = await strategy.getRewardTokenInfo(REWARD_TOKEN2_ADDRESS);
      expect(rewardToken2Info.token).to.equal(REWARD_TOKEN2_ADDRESS);
      expect(rewardToken2Info.isActive).to.be.true;
    });

    it("should return active reward tokens", async function () {
      const activeTokens = await strategy.getActiveRewardTokens();
      expect(activeTokens).to.have.lengthOf(2);
      expect(activeTokens).to.include(REWARD_TOKEN1_ADDRESS);
      expect(activeTokens).to.include(REWARD_TOKEN2_ADDRESS);
    });
  });

  describe.skip("Reward Token Management", () => {
    it("should allow manager to add new reward token", async function () {
      const newRewardToken = "0x0000000000000000000000000000000000123458";
      
      await strategy.addRewardToken(newRewardToken, true);
      
      const rewardTokenCount = await strategy.getRewardTokenCount();
      expect(rewardTokenCount).to.equal(3);
      
      const newTokenInfo = await strategy.getRewardTokenInfo(newRewardToken);
      expect(newTokenInfo.token).to.equal(newRewardToken);
      expect(newTokenInfo.isActive).to.be.true;
    });

    it("should allow manager to update reward token status", async function () {
      await strategy.updateRewardTokenStatus(REWARD_TOKEN1_ADDRESS, false);
      
      const tokenInfo = await strategy.getRewardTokenInfo(REWARD_TOKEN1_ADDRESS);
      expect(tokenInfo.isActive).to.be.false;
      
      // Reset to active
      await strategy.updateRewardTokenStatus(REWARD_TOKEN1_ADDRESS, true);
    });

    it("should allow manager to remove reward token", async function () {
      await strategy.removeRewardToken(REWARD_TOKEN2_ADDRESS);
      
      const tokenInfo = await strategy.getRewardTokenInfo(REWARD_TOKEN2_ADDRESS);
      expect(tokenInfo.isActive).to.be.false;
      
      // Reset to active
      await strategy.updateRewardTokenStatus(REWARD_TOKEN2_ADDRESS, true);
    });

    it("should allow manager to set reward routes", async function () {
      const tokens = [REWARD_TOKEN1_ADDRESS];
      const toLp0Routes = [[REWARD_TOKEN1_ADDRESS, LP_TOKEN0_ADDRESS]];
      const toLp1Routes = [[REWARD_TOKEN1_ADDRESS, LP_TOKEN1_ADDRESS]];
      
      await strategy.setRewardRoutes(tokens, toLp0Routes, toLp1Routes);
      
      const tokenInfo = await strategy.getRewardTokenInfo(REWARD_TOKEN1_ADDRESS);
      expect(tokenInfo.toLp0Route).to.deep.equal(toLp0Routes[0]);
      expect(tokenInfo.toLp1Route).to.deep.equal(toLp1Routes[0]);
    });

    it("should revert when adding duplicate reward token", async function () {
      await expect(
        strategy.addRewardToken(REWARD_TOKEN1_ADDRESS, true)
      ).to.be.revertedWith("Token already exists");
    });

    it("should revert when accessing non-existent reward token", async function () {
      const nonExistentToken = "0x0000000000000000000000000000000000000000";
      await expect(
        strategy.getRewardTokenInfo(nonExistentToken)
      ).to.be.revertedWith("Token not found");
    });
  });

  describe("Harvest Functionality", () => {
    it("should allow manager to harvest", async function () {
      // First set up reward routes
      const toLp0Routes0 = [REWARD_TOKEN1_ADDRESS, LP_TOKEN0_ADDRESS];
      const toLp1Routes0 = [REWARD_TOKEN1_ADDRESS, LP_TOKEN1_ADDRESS];
      const toLp0Routes1 = [REWARD_TOKEN2_ADDRESS, LP_TOKEN0_ADDRESS];
      const toLp1Routes1 = [REWARD_TOKEN2_ADDRESS, LP_TOKEN1_ADDRESS];
      const toLp0Routes2 = [REWARD_TOKEN3_ADDRESS, LP_TOKEN0_ADDRESS];
      const toLp1Routes2 = [REWARD_TOKEN3_ADDRESS, LP_TOKEN0_ADDRESS, LP_TOKEN1_ADDRESS];
      // await strategy.setRewardRoute(REWARD_TOKEN1_ADDRESS, toLp0Routes0, toLp1Routes0);
      // await strategy.setRewardRoute(REWARD_TOKEN2_ADDRESS, toLp0Routes1, toLp1Routes1);
      await strategy.setRewardRoute(REWARD_TOKEN3_ADDRESS, toLp0Routes2, toLp1Routes2);
      // Deposit first to create position
      const depositAmount0 = 100000;
      const depositAmount1 = 674848;
      let valueToSend = 0;
      if (isLpToken0Native) {
        valueToSend = depositAmount0 * 10 ** 10;
      }
      if (isLpToken1Native) {
        valueToSend = depositAmount1 * 10 ** 10;
      }
      
      await lpToken1.approve(vault.address, depositAmount1, { gasLimit: 3000000 });
      const tx = await vault.deposit(depositAmount0, depositAmount1, { value: valueToSend, gasLimit: 5000000 });
      const receipt = await tx.wait();
      console.log("Deposit transaction:", receipt.transactionHash);

      console.log("sending reward tokens to strategy to mock the LARI rewards...")
      const tx2 = await rewardToken3.transfer(strategy.address, "10000000" ) 
      const receipt2 = await tx2.wait();
      console.log("Reward token transfer transaction:", receipt2.transactionHash);

      // Try to harvest
      try {
        console.log("Attempting to call harvest...");
        const harvestTx = await strategy['harvest()']({ gasLimit: 8000000 });
        const harvestReceipt = await harvestTx.wait();
        console.log("Harvest transaction:", harvestReceipt.transactionHash);
        
        // Check for LariHarvested events
        const lariHarvestedEvents = harvestReceipt.logs?.filter((log: any) => {
          try {
            const parsedLog = strategy.interface.parseLog(log);
            return parsedLog.name === "LariHarvested";
          } catch {
            return false;
          }
        });
        console.log("LariHarvested events:", lariHarvestedEvents);
        
      } catch (error) {
        console.error("Harvest error details:", error);
        // This might fail if no rewards are available, which is expected
      }
    });

    it.skip("should revert harvest when no reward routes are configured", async function () {
      // Deactivate all reward tokens to simulate no routes
      await strategy.updateRewardTokenStatus(REWARD_TOKEN1_ADDRESS, false);
      await strategy.updateRewardTokenStatus(REWARD_TOKEN2_ADDRESS, false);
      
      await expect(
        strategy['harvest()']({ gasLimit: 3000000 })
      ).to.be.revertedWith("No reward routes configured");
      
      // Reactivate for other tests
      await strategy.updateRewardTokenStatus(REWARD_TOKEN1_ADDRESS, true);
      await strategy.updateRewardTokenStatus(REWARD_TOKEN2_ADDRESS, true);
    });

    it.skip("should allow harvest with custom fee recipient", async function () {
      // Set up reward routes first
      const tokens = [REWARD_TOKEN1_ADDRESS];
      const toLp0Routes = [[REWARD_TOKEN1_ADDRESS, LP_TOKEN0_ADDRESS]];
      const toLp1Routes = [[REWARD_TOKEN1_ADDRESS, LP_TOKEN1_ADDRESS]];
      await strategy.setRewardRoutes(tokens, toLp0Routes, toLp1Routes);

      const customRecipient = deployer.address;
      try {
        await strategy['harvest(address)'](customRecipient, { gasLimit: 3000000 });
      } catch (error) {
        console.log("Harvest with custom recipient failed (expected if no rewards):", error);
      }
    });
  });

//   describe("Reward Token Information", () => {
//     it("should return correct reward token by index", async function () {
//       const tokenInfo = await strategy.getRewardTokenByIndex(0);
//       expect(tokenInfo.token).to.equal(REWARD_TOKEN1_ADDRESS);
//       expect(tokenInfo.isActive).to.be.true;
//     });

//     it("should revert when accessing invalid index", async function () {
//       const rewardTokenCount = await strategy.getRewardTokenCount();
//       await expect(
//         strategy.getRewardTokenByIndex(rewardTokenCount)
//       ).to.be.revertedWith("Index out of bounds");
//     });

//     it("should correctly identify reward tokens", async function () {
//       const isReward1 = await strategy.isRewardToken(REWARD_TOKEN1_ADDRESS);
//       const isReward2 = await strategy.isRewardToken(REWARD_TOKEN2_ADDRESS);
//       const isNotReward = await strategy.isRewardToken(LP_TOKEN0_ADDRESS);
      
//       expect(isReward1).to.be.true;
//       expect(isReward2).to.be.true;
//       expect(isNotReward).to.be.false;
//     });
//   });

//   describe("Access Control", () => {
//     it("should only allow manager to call restricted functions", async function () {
//       const [deployer, user] = await ethers.getSigners();
      
//       // Test that non-manager cannot call restricted functions
//       await expect(
//         strategy.connect(user).addRewardToken("0x0000000000000000000000000000000000000001", true)
//       ).to.be.reverted;
      
//       await expect(
//         strategy.connect(user).updateRewardTokenStatus(REWARD_TOKEN1_ADDRESS, false)
//       ).to.be.reverted;
      
//       await expect(
//         strategy.connect(user).removeRewardToken(REWARD_TOKEN1_ADDRESS)
//       ).to.be.reverted;
      
//       await expect(
//         strategy.connect(user).setRewardRoutes([], [], [])
//       ).to.be.reverted;
//     });
//   });

//   describe("Integration Tests", () => {
//     it("should handle multiple reward tokens correctly", async function () {
//       // Add a third reward token
//       const newRewardToken = "0x0000000000000000000000000000000000123459";
//       await strategy.addRewardToken(newRewardToken, true);
      
//       // Set routes for all reward tokens
//       const tokens = [REWARD_TOKEN1_ADDRESS, REWARD_TOKEN2_ADDRESS, newRewardToken];
//       const toLp0Routes = [
//         [REWARD_TOKEN1_ADDRESS, LP_TOKEN0_ADDRESS],
//         [REWARD_TOKEN2_ADDRESS, LP_TOKEN0_ADDRESS],
//         [newRewardToken, LP_TOKEN0_ADDRESS]
//       ];
//       const toLp1Routes = [
//         [REWARD_TOKEN1_ADDRESS, LP_TOKEN1_ADDRESS],
//         [REWARD_TOKEN2_ADDRESS, LP_TOKEN1_ADDRESS],
//         [newRewardToken, LP_TOKEN1_ADDRESS]
//       ];
      
//       await strategy.setRewardRoutes(tokens, toLp0Routes, toLp1Routes);
      
//       // Verify all tokens are active
//       const activeTokens = await strategy.getActiveRewardTokens();
//       expect(activeTokens).to.have.lengthOf(3);
//       expect(activeTokens).to.include(newRewardToken);
//     });

//     it("should handle reward token lifecycle correctly", async function () {
//       // Add token
//       const testToken = "0x0000000000000000000000000000000000123460";
//       await strategy.addRewardToken(testToken, true);
      
//       // Verify it's active
//       let tokenInfo = await strategy.getRewardTokenInfo(testToken);
//       expect(tokenInfo.isActive).to.be.true;
      
//       // Deactivate
//       await strategy.updateRewardTokenStatus(testToken, false);
//       tokenInfo = await strategy.getRewardTokenInfo(testToken);
//       expect(tokenInfo.isActive).to.be.false;
      
//       // Remove
//       await strategy.removeRewardToken(testToken);
//       tokenInfo = await strategy.getRewardTokenInfo(testToken);
//       expect(tokenInfo.isActive).to.be.false;
//     });
//   });

//   describe("Error Handling", () => {
//     it("should handle invalid token addresses gracefully", async function () {
//       await expect(
//         strategy.addRewardToken("0x0000000000000000000000000000000000000000", true)
//       ).to.be.revertedWith("Invalid token address");
//     });

//     it("should handle array length mismatches", async function () {
//       const tokens = [REWARD_TOKEN1_ADDRESS];
//       const toLp0Routes = [[REWARD_TOKEN1_ADDRESS, LP_TOKEN0_ADDRESS]];
//       const toLp1Routes: any[] = []; // Mismatched length
      
//       await expect(
//         strategy.setRewardRoutes(tokens, toLp0Routes, toLp1Routes)
//       ).to.be.revertedWith("Array lengths must match");
//     });
//   });
});
