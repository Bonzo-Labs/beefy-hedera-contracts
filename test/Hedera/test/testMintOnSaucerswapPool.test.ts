import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { IERC20Upgradeable } from "../../typechain-types";

describe("SaucerSwap Mint Functionality", function () {
  // Set timeout to 60 seconds for all tests in this suite
  this.timeout(1000000);

  let positionManager: any;
  let deployer: SignerWithAddress;
  let token0: IERC20Upgradeable | any;
  let token1: IERC20Upgradeable | any;

  // Test addresses - replace with actual addresses
  const POSITION_MANAGER_ADDRESS = "0x000000000000000000000000000000000013f618";
  const TOKEN0_ADDRESS = "0x0000000000000000000000000000000000003ad2"; // HBAR (native)
  const TOKEN1_ADDRESS = "0x0000000000000000000000000000000000120f46"; // USDC
  const POOL_FEE = 3000; // 0.3%
  const POOL_ADDRESS = "0x37814edc1ae88cf27c0c346648721fb04e7e0ae7";
  const SAUCER_SWAP_FACTORY_ADDRESS = "0x00000000000000000000000000000000001243ee";

  before(async () => {
    [deployer] = await ethers.getSigners();
    console.log("Testing with account:", deployer.address);

    // Connect to the position manager
    positionManager = await ethers.getContractAt("INonfungiblePositionManager", POSITION_MANAGER_ADDRESS);
    console.log("Connected to position manager at:", POSITION_MANAGER_ADDRESS);

    // Connect to tokens
    token0 = await ethers.getContractAt("IERC20Upgradeable", TOKEN0_ADDRESS);
    token1 = await ethers.getContractAt("IERC20Upgradeable", TOKEN1_ADDRESS);
  });

  describe("Mint Position", function () {
    it("should mint a new position successfully", async function () {
        const amount0Desired = 1000000;
        const amount1Desired = 6000000;
      // Define mint parameters
      const mintParams = {
        token0: TOKEN0_ADDRESS,
        token1: TOKEN1_ADDRESS,
        fee: POOL_FEE,
        tickLower: -887220, // Full range
        tickUpper: 887220,  // Full range
        amount0Desired: amount0Desired, 
        amount1Desired: amount1Desired,
        amount0Min: amount0Desired * (1 - 0.10),
        amount1Min: amount1Desired * (1 - 0.10),
        recipient: deployer.address,
        deadline: Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
      };

      // Get initial balances
    //   const initialToken0Balance = await token0.balanceOf(deployer.address);
      const initialToken1Balance = await token1.balanceOf(deployer.address);

    //   console.log("Initial token0 balance:", ethers.utils.formatUnits(initialToken0Balance, 8));
      console.log("Initial token1 balance:", ethers.utils.formatUnits(initialToken1Balance, 6));

      //call mintFee function on saucerswap factory
      const saucerswapFactory = await ethers.getContractAt("IUniswapV3Factory", SAUCER_SWAP_FACTORY_ADDRESS);
      const mintFee = await saucerswapFactory.mintFee();
      console.log("Mint fee:", mintFee.toString());

      //approve token1 to position manager
      const approveTx = await token1.approve(POSITION_MANAGER_ADDRESS, "674848000000", { gasLimit: 10000000 });
      const approveReceipt = await approveTx.wait();
      console.log("Approve transaction hash:", approveReceipt.transactionHash);

      // Mint the position // 10000000000000000000
      const mintTx = await positionManager.mint(mintParams, { value: 1 * 10**10, gasLimit: 10000000 });
      const mintReceipt = await mintTx.wait();

      console.log("Mint transaction hash:", mintReceipt.transactionHash);

    //   // Get the mint event
    //   const mintEvent = mintReceipt.events?.find((event: any) => event.event === "IncreaseLiquidity");
    //   expect(mintEvent).to.not.be.undefined;

    //   const [tokenSN, liquidity, amount0, amount1] = mintEvent.args;
    //   console.log("Minted token SN:", tokenSN.toString());
    //   console.log("Liquidity:", liquidity.toString());
    //   console.log("Amount0 used:", ethers.utils.formatEther(amount0));
    //   console.log("Amount1 used:", ethers.utils.formatUnits(amount1, 6));

    //   // Verify the position was created
    //   const position = await positionManager.positions(tokenSN);
    //   console.log("Position:", position);


    });
  });
});

