import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BeefyVaultV7Hedera, IERC20Upgradeable, IHederaTokenService, BeefyVaultV7Factory, MockStrategy } from "../../typechain-types";


// Hardcoded values from the deployment
const VAULT_FACTORY_ADDRESS = "0x379808c428B38e09B573494aE76337D3085aaffA";
// const VAULT_OWNER = "0xa8A3b408ca5595BC5134F05569EFA2E5f04a66E0";

describe("BeefyVaultV7Hedera", function() {
  // Set timeout to 60 seconds for all tests in this suite
  this.timeout(1000000);
  
  let vault: BeefyVaultV7Hedera;
  let vaultFactory: BeefyVaultV7Factory;
  let want: IERC20Upgradeable;
  let deployer: SignerWithAddress;
  let isHederaToken: boolean;
  let mockStrategy: MockStrategy;
  beforeEach(async () => {
    [deployer] = await ethers.getSigners();

    // Deploy a mock strategy
    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    // @ts-ignore
    mockStrategy = await MockStrategy.deploy("0x00000000000000000000000000000000004e8936", true);
    await mockStrategy.deployed();

    // Connect to the already deployed vault factory
    // @ts-ignore
    vaultFactory = await ethers.getContractAt("BeefyVaultV7Factory", VAULT_FACTORY_ADDRESS);
    
    // Create a new vault using the factory
    const tx = await vaultFactory.cloneVault();
    const receipt = await tx.wait();
    
    // Get the new vault address from the ProxyCreated event
    const proxyCreatedEvent = receipt.events?.find(e => e.event === "ProxyCreated");
    const vaultAddress = proxyCreatedEvent?.args?.proxy;
    console.log("vaultAddress", vaultAddress);
    // Connect to the newly created vault
    // @ts-ignore
    vault = await ethers.getContractAt("BeefyVaultV7Hedera", vaultAddress);
    await mockStrategy.setVault(vaultAddress);
    // // For testing purposes, we'll test both HTS and non-HTS scenarios
    // isHederaToken = true; // Change to true to test HTS token path (requires Hedera network)
    
    // // Initialize the vault
    // await vault.initialize(
    //   mockStrategy.address,
    //   "BeefyHedera",
    //   "bvHTS",
    //   0, 
    //   isHederaToken
    // );
    
    // // @ts-ignore
    // want = await ethers.getContractAt("IERC20Upgradeable", await mockStrategy.want());
    // console.log("want", want.address);
    // // Set the vault owner to the deployed vault owner
    // // await vault.transferOwnership(VAULT_OWNER);
  });

  describe("testDeposit", () => {
    it.skip("should deposit HTS tokens and mint shares correctly", async () => {
      isHederaToken = true; // Change to true to test HTS token path (requires Hedera network)
    
      // Initialize the vault
      await vault.initialize(
        mockStrategy.address,
        "BeefyHedera",
        "bvHTS",
        0, 
        isHederaToken
      );
      
      // @ts-ignore
      want = await ethers.getContractAt("IERC20Upgradeable", await mockStrategy.want());
      console.log("want", want.address);
      const depositAmount = "100000000";
      // Approve the vault to spend tokens on behalf of the deployer
      const approveTx = await want.connect(deployer).approve(vault.address, depositAmount);
      const approveReceipt = await approveTx.wait(2);
      console.log("approve Receipt", approveReceipt.transactionHash);
      
      // Verify the allowance was set correctly
      const allowance = await want.allowance(deployer.address, vault.address);
    
      expect(allowance).to.equal(depositAmount);
      // Check initial balances
      const initialUserBalance = await want.balanceOf(deployer.address);
      const initialVaultBalance = await want.balanceOf(vault.address);
      const initialTotalSupply = await vault.totalSupply();
      
      expect(initialTotalSupply).to.equal(0);
      
      // Perform test deposit
      const tx = await vault.connect(deployer).deposit(depositAmount, {gasLimit: 3000000});
      const receipt = await tx.wait(2);
      console.log("deposit receipt", receipt.transactionHash);
    
      // Check final balances
      const finalUserBalance = await want.balanceOf(deployer.address);
      const finalVaultBalance = await want.balanceOf(vault.address);
      const finalTotalSupply = await vault.totalSupply();
      console.log("finalUserBalance", finalUserBalance);
      console.log("finalVaultBalance", finalVaultBalance);
      console.log("finalTotalSupply", finalTotalSupply);
      // deployer balance should decrease by deposit amount
      expect(initialUserBalance.sub(finalUserBalance)).to.equal(depositAmount);
      
      // Vault balance should increase by deposit amount
      // expect(finalVaultBalance.sub(initialVaultBalance)).to.equal(depositAmount);
      
      // First deposit should mint shares equal to deposit amount
      expect(finalTotalSupply).to.equal(depositAmount);
      
      // deployer should have received shares
      const userShares = await vault.balanceOf(deployer.address);
      expect(userShares).to.equal(depositAmount);

      // Test withdrawal
      console.log("withdrawing all");
      const withdrawTx = await vault.connect(deployer).withdrawAll({gasLimit: 3000000});
      const withdrawReceipt = await withdrawTx.wait(2);
      console.log("withdraw receipt", withdrawReceipt.transactionHash);
      // Check final balances after withdrawal
      const finalUserBalance2 = await want.balanceOf(deployer.address);
      const finalVaultBalance2 = await want.balanceOf(vault.address);
      expect(finalUserBalance2).to.equal(initialUserBalance);
      expect(finalVaultBalance2).to.equal(initialVaultBalance);
      
    });

    it("should handle ERC20 token deposits and withdrawals correctly", async function() {
      // Set up with ERC20 token (not Hedera token)
      const isHederaToken = false;
      // Deploy a mock ERC20 token for testing
      const ERC20Mock = await ethers.getContractFactory("TestToken");
      const erc20Token = await ERC20Mock.deploy(ethers.utils.parseEther("1000000000"), "TestToken", "TEST");
      await erc20Token.deployed();
      
      // Verify the deployer has received the tokens
      const deployerBalance = await erc20Token.balanceOf(deployer.address);
      expect(deployerBalance).to.equal(ethers.utils.parseEther("1000000000"));

      // Deploy mock strategy for ERC20 token
      const MockStrategy = await ethers.getContractFactory("MockStrategy");
      const mockStrategy = await MockStrategy.deploy(erc20Token.address, isHederaToken);
      await mockStrategy.deployed();
      
      // Deploy vault with ERC20 configuration
      const BeefyVault = await ethers.getContractFactory("BeefyVaultV7Hedera");
      const vault = await upgrades.deployProxy(BeefyVault, [
        mockStrategy.address,
        "BeefyERC20",
        "bvERC20",
        0, 
        isHederaToken
      ]);
      await vault.deployed();
      await mockStrategy.setVault(vault.address);
      // @ts-ignore
      const erc20Want = await ethers.getContractAt("IERC20Upgradeable", await mockStrategy.want());
      console.log("erc20Want", erc20Want.address);
      const depositAmount = "100000000";
      
      // Approve the vault to spend tokens on behalf of the deployer
      const approveTx = await erc20Want.connect(deployer).approve(vault.address, depositAmount);
      const approveReceipt = await approveTx.wait(2);
      console.log("approve Receipt", approveReceipt.transactionHash);
      
      // Verify the allowance was set correctly
      const allowance = await erc20Want.allowance(deployer.address, vault.address);
      expect(allowance).to.equal(depositAmount);
      
      // Check initial balances
      const initialUserBalance = await erc20Want.balanceOf(deployer.address);
      const initialVaultBalance = await erc20Want.balanceOf(vault.address);
      const initialTotalSupply = await vault.totalSupply();
      
      expect(initialTotalSupply).to.equal(0);
      
      // Perform deposit
      const tx = await vault.connect(deployer).deposit(depositAmount, {gasLimit: 3000000});
      const receipt = await tx.wait(2);
      console.log("deposit receipt", receipt.transactionHash);
      
      // Check post-deposit balances
      const postDepositUserBalance = await erc20Want.balanceOf(deployer.address);
      const postDepositVaultBalance = await erc20Want.balanceOf(vault.address);
      const postDepositTotalSupply = await vault.totalSupply();
      
      // User balance should decrease by deposit amount
      expect(initialUserBalance.sub(postDepositUserBalance)).to.equal(depositAmount);
      
      // First deposit should mint shares equal to deposit amount
      expect(postDepositTotalSupply).to.equal(depositAmount);
      
      // User should have received shares
      const userShares = await vault.balanceOf(deployer.address);
      expect(userShares).to.equal(depositAmount);
      
      // Test withdrawal
      const withdrawTx = await vault.connect(deployer).withdrawAll({gasLimit: 3000000});
      const withdrawReceipt = await withdrawTx.wait(2);
      console.log("withdraw receipt", withdrawReceipt.transactionHash);
      
      // Check final balances after withdrawal
      const finalUserBalance = await erc20Want.balanceOf(deployer.address);
      const finalVaultBalance = await erc20Want.balanceOf(vault.address);
      const finalUserShares = await vault.balanceOf(deployer.address);
      
      // User should have received back their tokens
      expect(finalUserBalance).to.equal(initialUserBalance);
      
      // User should have no shares left
      expect(finalUserShares).to.equal(0);
      
      // Vault should have no tokens left (or minimal dust)
      expect(finalVaultBalance).to.be.lte(1);
    });

  });

  
});
