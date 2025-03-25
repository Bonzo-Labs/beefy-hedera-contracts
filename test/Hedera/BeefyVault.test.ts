import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BeefyVaultV7Hedera, IERC20Upgradeable, IHederaTokenService, BeefyVaultV7Factory } from "../../typechain-types";

const TIMEOUT = 10 * 60 * 100000;
const HTS_PRECOMPILE = "0x167";

// Hardcoded values from the deployment
const VAULT_FACTORY_ADDRESS = "0x379808c428B38e09B573494aE76337D3085aaffA";
// const VAULT_OWNER = "0xa8A3b408ca5595BC5134F05569EFA2E5f04a66E0";

describe("BeefyVaultV7Hedera", () => {
  let vault: BeefyVaultV7Hedera;
  let vaultFactory: BeefyVaultV7Factory;
  let want: IERC20Upgradeable;
  let deployer: SignerWithAddress;
  let isHederaToken: boolean;

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();

    // Deploy a mock strategy
    const MockStrategy = await ethers.getContractFactory("MockStrategy");
    const mockStrategy = await MockStrategy.deploy("0x00000000000000000000000000000000004e8936");
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
    
    // For testing purposes, we'll test both HTS and non-HTS scenarios
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
    // Set the vault owner to the deployed vault owner
    // await vault.transferOwnership(VAULT_OWNER);
  });

  describe("testDeposit", () => {
    it("should deposit ERC20 tokens and mint shares correctly", async () => {
      const depositAmount = "100000000";
      // Approve the vault to spend tokens on behalf of the deployer
      const approveTx = await want.connect(deployer).approve(vault.address, depositAmount);
      const approveReceipt = await approveTx.wait(2);
      console.log("approveReceipt", approveReceipt);
      
      // Verify the allowance was set correctly
      const allowance = await want.allowance(deployer.address, vault.address);
    
      expect(allowance).to.equal(depositAmount);
      // Check initial balances
      const initialUserBalance = await want.balanceOf(deployer.address);
      const initialVaultBalance = await want.balanceOf(vault.address);
      const initialTotalSupply = await vault.totalSupply();
      
      expect(initialTotalSupply).to.equal(0);
      
      // Perform test deposit
    //   const tx = await vault.connect(deployer).testDeposit(depositAmount, {gasLimit: 3000000});
      const tx = await vault.connect(deployer).deposit(depositAmount, {gasLimit: 3000000});
      const receipt = await tx.wait(2);
      console.log("receipt", receipt);
    
      // Check final balances
      const finalUserBalance = await want.balanceOf(deployer.address);
      const finalVaultBalance = await want.balanceOf(vault.address);
      const finalTotalSupply = await vault.totalSupply();
      
      // deployer balance should decrease by deposit amount
      expect(initialUserBalance.sub(finalUserBalance)).to.equal(depositAmount);
      
      // Vault balance should increase by deposit amount
      expect(finalVaultBalance.sub(initialVaultBalance)).to.equal(depositAmount);
      
      // First deposit should mint shares equal to deposit amount
      expect(finalTotalSupply).to.equal(depositAmount);
      
      // deployer should have received shares
      const userShares = await vault.balanceOf(deployer.address);
      expect(userShares).to.equal(depositAmount);
    });

  });

  // Additional tests for other vault functions could be added here
});
