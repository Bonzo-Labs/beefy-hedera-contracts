import { ethers } from "hardhat";
import { expect } from "chai";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { MockStaking, IERC20Upgradeable } from "../../typechain-types";
import { BigNumber } from "ethers";

describe("MockStaking", function () {
  let staking: MockStaking | any;
  let owner: SignerWithAddress;
  let hbarx: IERC20Upgradeable  | any;
  const HBARX_TOKEN_ADDRESS = "0x0000000000000000000000000000000000220ced"; // HBARX token

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    
    // Deploy MockStaking contract
    const MockStaking = await ethers.getContractFactory("MockStaking");
    staking = await MockStaking.deploy(HBARX_TOKEN_ADDRESS);
    await staking.deployed();
    console.log("MockStaking contract deployed to:", staking.address);

    // Transfer some HBARX to the staking contract for testing
    hbarx = await ethers.getContractAt("IERC20Upgradeable", HBARX_TOKEN_ADDRESS);
    const tx = await hbarx.transfer(staking.address, "1000000");
    const receipt = await tx.wait();

  });

  describe("Staking", function () {
    it.skip("should allow users to stake HBAR and receive HBARX", async function () {
      const stakeAmount = "10000000000"; 

      // Get initial balances
      const initialHbarxBalance = await (await ethers.getContractAt("@openzeppelin-4/contracts/token/ERC20/IERC20.sol:IERC20", HBARX_TOKEN_ADDRESS)).balanceOf(owner.address);

      // Stake HBAR
      const stakeTx = await staking.connect(owner).stake({ value: stakeAmount });
      const stakeReceipt = await stakeTx.wait();
      console.log("Staking transaction:", stakeReceipt);

      // Check balances after staking
      const finalHbarxBalance = await (await ethers.getContractAt("@openzeppelin-4/contracts/token/ERC20/IERC20.sol:IERC20", HBARX_TOKEN_ADDRESS)).balanceOf(owner.address);
      console.log("Final HBARX balance:", finalHbarxBalance);
      console.log("Initial HBARX balance:", initialHbarxBalance);
      // Verify HBAR was deducted and HBARX was received
    });

    it.skip("should revert if staking 0 HBAR", async function () {
      await expect(
        staking.connect(owner).stake({ value: 0 })
      ).to.be.revertedWith("Must send HBAR");
    });
  });

  describe("Unstaking", function () {
    it("should allow users to unstake HBARX and receive HBAR", async function () {
      // First stake some HBAR
      const stakeAmount = "1330000000000";
      const stakeTx = await staking.connect(owner).stake({ value: stakeAmount });
      const stakeReceipt = await stakeTx.wait();
      console.log("Staking transaction hash:", stakeReceipt.transactionHash);

      // Get initial balances
      const initialHbarxBalance = await hbarx.balanceOf(owner.address);
      console.log("Initial HBARX balance:", BigNumber.from(initialHbarxBalance).toString());

      // Unstake HBARX
      const unstakeAmount = "10";

      const approveTx = await hbarx.connect(owner).approve(staking.address, unstakeAmount, {gasLimit: 3000000});
      await approveTx.wait();

      const unstakeTx = await staking.connect(owner).unStake(unstakeAmount);
      const unstakeReceipt = await unstakeTx.wait();
      
      // Get Debug event
      const debugEvents = unstakeReceipt.events?.filter((e: any) => e.event === "Debug");
      if (debugEvents && debugEvents.length > 0) {
        const debugEvent = debugEvents[0];
        console.log("Debug Event Values:");
        console.log("  HBARX Amount:", debugEvent.args.hbarxAmount.toString());
        console.log("  HBAR Amount:", debugEvent.args.hbarAmount.toString());
        console.log("  Contract Balance:", debugEvent.args.contractBalance.toString());
        console.log("  Exchange Rate:", debugEvent.args.exchangeRate.toString());
      }


    });

    it.skip("should revert if unstaking 0 HBARX", async function () {
      await expect(
        staking.connect(owner).unStake(0)
      ).to.be.revertedWith("Amount must be greater than 0");
    });
  });

  describe("Exchange Rate", function () {
    it.skip("should return the correct exchange rate", async function () {
      const exchangeRate = await staking.getExchangeRate();
      expect(exchangeRate).to.equal(133000000); // 1.33 HBAR = 1 HBARX
    });
  });
});
