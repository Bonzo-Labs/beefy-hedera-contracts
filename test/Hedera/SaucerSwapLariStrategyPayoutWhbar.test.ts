import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Contract } from "ethers";

// Storage slots from .openzeppelin/unknown-295.json layout of SaucerSwapLariRewardsCLMStrategy
const OWNER_SLOT = 51; // OwnableUpgradeable._owner
const NATIVE_SLOT = 221; // nativeToken (renamed from native)
const WHBAR = "0x0000000000000000000000000000000000163B5a";

/**
 * payoutWhbar flag: lets BonzoVaultConcLiq clone vaults pay WHBAR instead of unwrapping to HBAR,
 * because the WHBAR contract's 2300-gas HBAR push no longer reaches a clone since Hedera v0.77.
 */
describe("SaucerSwapLariRewardsCLMStrategy payoutWhbar", function () {
  let strategy: Contract;
  let deployer: string;

  function slotHex(n: number) {
    return ethers.utils.hexZeroPad(ethers.utils.hexlify(n), 32);
  }
  function wordAddr(a: string) {
    return ethers.utils.hexZeroPad(a, 32);
  }

  before(async function () {
    [{ address: deployer }] = await ethers.getSigners();
    const clmLib = await (await ethers.getContractFactory("SaucerSwapCLMLib")).deploy();
    await clmLib.deployed();
    const lariLib = await (
      await ethers.getContractFactory("SaucerSwapLariLib", { libraries: { SaucerSwapCLMLib: clmLib.address } })
    ).deploy();
    await lariLib.deployed();
    const factory = await ethers.getContractFactory("SaucerSwapLariRewardsCLMStrategy", {
      libraries: { SaucerSwapCLMLib: clmLib.address, SaucerSwapLariLib: lariLib.address },
    });
    strategy = await factory.deploy();
    await strategy.deployed();
    // Simulate an initialized mainnet strategy: native token set, deployer as owner.
    await network.provider.send("hardhat_setStorageAt", [strategy.address, slotHex(NATIVE_SLOT), wordAddr(WHBAR)]);
  });

  it("reports the real native token by default", async function () {
    expect(await strategy.payoutWhbar()).to.equal(false);
    expect((await strategy.native()).toLowerCase()).to.equal(WHBAR.toLowerCase());
    expect((await strategy.nativeToken()).toLowerCase()).to.equal(WHBAR.toLowerCase());
  });

  it("rejects setPayoutWhbar from a non-owner", async function () {
    await expect(strategy.setPayoutWhbar(true)).to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("reports address(0) to the vault while payoutWhbar is set, keeping the internal token", async function () {
    await network.provider.send("hardhat_setStorageAt", [strategy.address, slotHex(OWNER_SLOT), wordAddr(deployer)]);
    await expect(strategy.setPayoutWhbar(true)).to.emit(strategy, "PayoutWhbarUpdated").withArgs(true);

    expect(await strategy.payoutWhbar()).to.equal(true);
    expect(await strategy.native()).to.equal(ethers.constants.AddressZero);
    expect((await strategy.nativeToken()).toLowerCase()).to.equal(WHBAR.toLowerCase());
  });

  it("is reversible", async function () {
    await strategy.setPayoutWhbar(false);
    expect((await strategy.native()).toLowerCase()).to.equal(WHBAR.toLowerCase());
  });
});
