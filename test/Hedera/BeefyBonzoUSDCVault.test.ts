import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BeefyVaultV7Hedera, BonzoUSDCSupplyStrategy, IERC20Upgradeable } from "../../typechain-types";

// Hardcoded values from the deployment
const VAULT_FACTORY_ADDRESS = "0xeCAfFc8cDB2393aB640cdc8C81C404Ce543384D3";
const USDC_TOKEN_ADDRESS = "0x0000000000000000000000000000000000001549"; // Hedera USDC token
const AUSDC_TOKEN_ADDRESS = "0xee72C37fEc48C9FeC6bbD0982ecEb7d7a038841e"; // aUSDC token
const LENDING_POOL_ADDRESS = "0x7710a96b01e02eD00768C3b39BfA7B4f1c128c62"; // Bonzo lending pool
const REWARDS_CONTROLLER_ADDRESS = "0x40f1f4247972952ab1D276Cf552070d2E9880DA6"; // Bonzo rewards controller
const UNIROUTER_ADDRESS = "0x00000000000000000000000000000000000026e7"; // Router address
const FEE_CONFIG_ADDRESS = "0x57c996f670364cAE84DEc46eA42E1Bc755e9A264"; // Fee config address

describe("BeefyBonzoUSDCVault", function () {
    // Set timeout to 60 seconds for all tests in this suite
    this.timeout(1000000);

    let vault: BeefyVaultV7Hedera | any;
    let strategy: BonzoUSDCSupplyStrategy | any;
    let want: IERC20Upgradeable | any;
    let deployer: SignerWithAddress | any;
    let vaultAddress: string;
    let deployNewContract = false;

    before(async () => {
        [deployer] = await ethers.getSigners();
        console.log("Testing with account:", deployer.address);

        if (deployNewContract) {
            // Step 1: Deploy the strategy
            console.log("Deploying BonzoUSDCSupplyStrategy...");
            const BonzoUSDCSupplyStrategy = await ethers.getContractFactory("BonzoUSDCSupplyStrategy");
            strategy = await BonzoUSDCSupplyStrategy.deploy();
            await strategy.deployed();
            console.log("BonzoUSDCSupplyStrategy deployed to:", strategy.address);

            // Step 2: Connect to the vault factory
            const vaultFactory = await ethers.getContractAt("BeefyVaultV7Factory", VAULT_FACTORY_ADDRESS);
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
                keeper: deployer.address,
                strategist: deployer.address,
                unirouter: UNIROUTER_ADDRESS,
                beefyFeeRecipient: deployer.address,
                beefyFeeConfig: FEE_CONFIG_ADDRESS
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
                "Beefy USDC Bonzo",
                "bvUSDC-BONZO",
                0, // Performance fee - set to 0 initially
                isHederaToken,
                { gasLimit: 3000000 }
            );
            console.log("Vault initialized");

            // Connect to the want token
        }
        else {
            //use already deployed contract
            const VAULT_ADDRESS = "0x6966D5426F97e2B29ddd3517DE7aC00Da628e718";
            const STRATEGY_ADDRESS = "0xB261cA394eA8aF0F8d4263A232b80b06654cC5Be";
            vault = await ethers.getContractAt("BeefyVaultV7Hedera", VAULT_ADDRESS);
            strategy = await ethers.getContractAt("BonzoUSDCSupplyStrategy", STRATEGY_ADDRESS);
            vaultAddress = VAULT_ADDRESS;
            deployNewContract = false;
        }
        want = await ethers.getContractAt("IERC20Upgradeable", USDC_TOKEN_ADDRESS);

    });

    // describe("Deployment", () => {
    //     it("should deploy strategy and vault correctly", async () => {
    //         const commonAddresses = {
    //             vault: vaultAddress,
    //             keeper: deployer.address,
    //             strategist: deployer.address,
    //             unirouter: UNIROUTER_ADDRESS,
    //             beefyFeeRecipient: deployer.address,
    //             beefyFeeConfig: FEE_CONFIG_ADDRESS
    //         };
    //         if (deployNewContract) {
    //             // Step 1: Deploy the strategy
    //             console.log("Deploying BonzoUSDCSupplyStrategy...");
    //             const BonzoUSDCSupplyStrategy = await ethers.getContractFactory("BonzoUSDCSupplyStrategy");
    //             strategy = await BonzoUSDCSupplyStrategy.deploy();
    //             await strategy.deployed();
    //             console.log("BonzoUSDCSupplyStrategy deployed to:", strategy.address);

    //             // Step 2: Connect to the vault factory
    //             const vaultFactory = await ethers.getContractAt("BeefyVaultV7Factory", VAULT_FACTORY_ADDRESS);
    //             console.log("Connected to vault factory at:", VAULT_FACTORY_ADDRESS);

    //             // Step 3: Create a new vault using the factory
    //             console.log("Creating new vault...");
    //             const tx = await vaultFactory.cloneVault();
    //             const receipt = await tx.wait();

    //             // Get the new vault address from the ProxyCreated event
    //             const proxyCreatedEvent = receipt.events?.find((e: any) => e.event === "ProxyCreated");
    //             vaultAddress = proxyCreatedEvent?.args?.proxy;
    //             console.log("New vault deployed to:", vaultAddress);

    //             // Step 4: Connect to the newly created vault
    //             vault = await ethers.getContractAt("BeefyVaultV7Hedera", vaultAddress);

    //             // Step 5: Initialize the strategy
    //             console.log("Initializing strategy...");

    //             await strategy.initialize(
    //                 USDC_TOKEN_ADDRESS,
    //                 AUSDC_TOKEN_ADDRESS,
    //                 LENDING_POOL_ADDRESS,
    //                 REWARDS_CONTROLLER_ADDRESS,
    //                 USDC_TOKEN_ADDRESS, // Output is also USDC
    //                 commonAddresses,
    //                 { gasLimit: 3000000 }
    //             );
    //             console.log("Strategy initialized");

    //             // Step 6: Initialize the vault
    //             console.log("Initializing vault...");
    //             const isHederaToken = true; // Set to true for HTS tokens
    //             await vault.initialize(
    //                 strategy.address,
    //                 "Beefy USDC Bonzo",
    //                 "bvUSDC-BONZO",
    //                 0, // Performance fee - set to 0 initially
    //                 isHederaToken,
    //                 { gasLimit: 3000000 }
    //             );
    //             console.log("Vault initialized");

    //             // Connect to the want token
    //         }
    //         else {
    //             //use already deployed contract
    //             const VAULT_ADDRESS = "0x5dd5cD967C324f7d34Ac669E41549c602cF263b3";
    //             const STRATEGY_ADDRESS = "0xa401E2164D60700E5829D5A508A10907b8CC1fC7";
    //             vault = await ethers.getContractAt("BeefyVaultV7Hedera", VAULT_ADDRESS);
    //             strategy = await ethers.getContractAt("BonzoUSDCSupplyStrategy", STRATEGY_ADDRESS);
    //             vaultAddress = VAULT_ADDRESS;
    //             deployNewContract = false;
    //         }
    //         want = await ethers.getContractAt("IERC20Upgradeable", USDC_TOKEN_ADDRESS);

    //         // Verify initialization
    //         expect(await vault.strategy()).to.equal(strategy.address);
    //         expect(await vault.name()).to.equal("Beefy USDC Bonzo");
    //         expect(await vault.symbol()).to.equal("bvUSDC-BONZO");
    //         expect(await strategy.want()).to.equal(USDC_TOKEN_ADDRESS);
    //         expect(await strategy.vault()).to.equal(vaultAddress);
    //     });
    // });

    describe("Deposit and Withdraw", () => {
        it("should handle deposits and withdrawals correctly", async function () {
            console.log("sender address", deployer.address);
            
            console.log("setting harvest on deposit to true");
            const initialHarvestOnDeposit = await strategy.harvestOnDeposit();
            console.log("initialHarvestOnDeposit", initialHarvestOnDeposit);
            if (!initialHarvestOnDeposit) {
                const setHarvestOnDeposit = await strategy.setHarvestOnDeposit(true);
                const setHarvestOnDepositReceipt = await setHarvestOnDeposit.wait();
                console.log("setHarvestOnDeposit transaction", setHarvestOnDepositReceipt.transactionHash);
                const isHarvestOnDeposit = await strategy.harvestOnDeposit();
                console.log("isHarvestOnDeposit", isHarvestOnDeposit);
            }
            
            // Skip this test if we don't have USDC tokens to test with
            const userBalance = await want.balanceOf(deployer.address);
            console.log("user balance", userBalance.toString());
            if (userBalance.eq(0)) {
                console.log("Skipping deposit/withdraw test - no USDC tokens available");
                this.skip();
                return;
            }

            const depositAmount = "1000000"; // 1 USDC (assuming 6 decimals)

            // Approve the vault to spend tokens
            const approveTx = await want.approve(vault.address, depositAmount, {gasLimit: 3000000});
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
            const tx = await vault.deposit(depositAmount, { gasLimit: 3000000 });
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

            // User balance should decrease by deposit amount
            expect(initialUserBalance.sub(postDepositUserBalance)).to.equal(depositAmount);

            // First deposit should mint shares equal to deposit amount
            // expect(userShares).to.equal(depositAmount);

            // Test withdrawal
              console.log("Withdrawing...");
              const sharesToWithdraw = "1000000";
              const withdrawTx = await vault.withdraw(sharesToWithdraw, {gasLimit: 3000000});
              const withdrawReceipt = await withdrawTx.wait();
              console.log("Withdraw transaction:", withdrawReceipt.transactionHash);

              // Check final balances after withdrawal
              const finalUserBalance = await want.balanceOf(deployer.address);
              const finalVaultBalance = await want.balanceOf(vault.address);
              const finalUserShares = await vault.balanceOf(deployer.address);

              console.log("Final user balance:", finalUserBalance.toString());
              console.log("Final vault balance:", finalVaultBalance.toString());
              console.log("Final user shares:", finalUserShares.toString());

              // User should have received back their tokens (minus potential fees)
              expect(finalUserBalance).to.be.gt(initialUserBalance); // Allow for small rounding errors

              // User should have no shares left
            //   expect(finalUserShares).to.equal(0);
        });
    });

    //   describe("Strategy Functions", () => {
    //     it("should correctly report balances", async function() {
    //       // Check balance reporting functions
    //       const balanceOfWant = await strategy.balanceOfWant();
    //       const balanceOfPool = await strategy.balanceOfPool();
    //       const balanceOf = await strategy.balanceOf();

    //       console.log("Balance of want:", balanceOfWant.toString());
    //       console.log("Balance of pool:", balanceOfPool.toString());
    //       console.log("Total balance:", balanceOf.toString());

    //       expect(balanceOf).to.equal(balanceOfWant.add(balanceOfPool));
    //     });

    //     it("should handle harvest settings", async function() {
    //       // Test harvest on deposit setting
    //       await strategy.setHarvestOnDeposit(true);
    //       expect(await strategy.harvestOnDeposit()).to.be.true;

    //       // When harvestOnDeposit is true, withdrawal fee should be 0
    //       expect(await strategy.withdrawalFee()).to.equal(0);

    //       await strategy.setHarvestOnDeposit(false);
    //       expect(await strategy.harvestOnDeposit()).to.be.false;

    //       // When harvestOnDeposit is false, withdrawal fee should be 10
    //       expect(await strategy.withdrawalFee()).to.equal(10);
    //     });

    //     it("should handle pause/unpause", async function() {
    //       // Test pause functionality
    //       await strategy.pause();
    //       expect(await strategy.paused()).to.be.true;

    //       await strategy.unpause();
    //       expect(await strategy.paused()).to.be.false;
    //     });
    //   });
});
