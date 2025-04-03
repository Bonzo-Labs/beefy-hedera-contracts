import { ethers } from "hardhat";
import {abi as BeefySwapperWithHTSAbi} from "../../artifacts/contracts/BIFI/infra/BeefySwapperWithHTS.sol/BeefySwapperWithHTS.json";
import ERC20Abi from "../../data/abi/ERC20.json";

// Configuration
const beefySwapperAddress = "0x18c96d04d2adCa549C8CcfA1020CC10102546411"; // Replace with actual BeefySwapperWithHTS address
const SAUCE = "0x0000000000000000000000000000000000120f46";
const WHBAR = "0x0000000000000000000000000000000000003ad2";
const HBARX = "0x0000000000000000000000000000000000220ced";
const amountToSwap = "10000"; // Adjust based on token decimals
const routerAddress =  "0x000000000000000000000000000000000046ff9b";
//"0x000000000000000000000000000000000046ff9b"; //"0x0000000000000000000000000000000000159398";

async function main() {
  console.log("Testing BeefySwapperWithHTS swap function...");
  
  // Create signer using private key from environment variables
  const provider = new ethers.providers.JsonRpcProvider(process.env.HEDERA_TESTNET_RPC);
  const deployer = new ethers.Wallet(process.env.KEEPER_PK, provider);
  console.log("Deployer:", deployer.address);

  // Get the BeefySwapperWithHTS contract
  
  const beefySwapper = await ethers.getContractAt(BeefySwapperWithHTSAbi, beefySwapperAddress, deployer);
  console.log("Connected to BeefySwapperWithHTS at:", beefySwapperAddress);

  // Get token contracts
  const fromToken = await ethers.getContractAt(ERC20Abi, SAUCE, deployer);
  const toToken = await ethers.getContractAt(ERC20Abi, HBARX, deployer);
  
  // Check if tokens are HTS tokens
  const isFromHTS = true;
  const isToHTS = true;
  console.log(`SAUCE is HTS token: ${isFromHTS}`);
  console.log(`HBARX is HTS token: ${isToHTS}`);

  // Check if swap info exists, if not, set it up
  const swapInfo = await beefySwapper.swapInfo(SAUCE, HBARX);
  // if (swapInfo.router === ethers.constants.AddressZero) {
  //   console.log("Swap info not set up. Setting up swap info...");
    
  //   // Create swap data - this is an example, adjust according to your router's requirements
  //   const swapData = {
  //     router: routerAddress,
  //     data: ethers.utils.hexConcat([
  //       // Function selector
  //       ethers.utils.id("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)").slice(0, 10),
  //       // Amount in placeholder
  //       ethers.utils.hexZeroPad("0x0", 32),
  //       // Min amount out placeholder
  //       ethers.utils.hexZeroPad("0x0", 32),
  //       // Path encoding - encode the array length and elements
  //       ethers.utils.hexZeroPad(ethers.utils.hexlify(0x20), 32), // offset
  //       ethers.utils.hexZeroPad(ethers.utils.hexlify(2), 32),    // array length
  //       ethers.utils.hexZeroPad(SAUCE, 32),                      // first token
  //       ethers.utils.hexZeroPad(WHBAR, 32),                      // second token
  //       // Recipient address
  //       ethers.utils.hexZeroPad(beefySwapperAddress, 32),
  //       // Deadline
  //       ethers.utils.hexZeroPad(
  //         ethers.BigNumber.from(Math.floor(Date.now() / 1000) + 3600).toHexString(),
  //         32
  //       )
  //     ]),
  //     amountIndex: 4,
  //     minIndex: 36,
  //     minAmountSign: 1,
  //     isFromHTS: isFromHTS,
  //     isToHTS: isToHTS
  //   };
    
  //   // Set swap info
  //   console.log("Setting swap info...");
  //   console.log("Swap data details:");
  //   console.log("Router:", swapData.router);
  //   console.log("Data:", swapData.data);
  //   console.log("Amount Index:", swapData.amountIndex);
  //   console.log("Min Index:", swapData.minIndex);
  //   const setSwapInfoTx = await beefySwapper.setSwapInfo(SAUCE, WHBAR, swapData);
  //   await setSwapInfoTx.wait(1);
  //   console.log("Swap info set successfully");

  // }

  //set swap info
  console.log("Setting swap info...");
  const swapSelector = ethers.utils
  .id("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)")
  .slice(0, 10); // 4-byte selector

  const amountIn = 10000; // 100000 with 6 decimals
  const amountOutMin = 0

  const recipient = beefySwapperAddress; // verify this address
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1-hour validity
  console.log("Amount In:", amountIn);
  console.log("Amount Out Min:", amountOutMin);
  console.log("Recipient:", recipient);
  console.log("Deadline:", deadline);
  const data = ethers.utils.defaultAbiCoder.encode(
    ["uint256", "uint256", "address[]", "address", "uint256"],
    [
      "0", 
      "0",
      // [SAUCE, HBARX], 
      ["0x0000000000000000000000000000000000120f46","0x00000000000000000000000000000000000014F5","0x0000000000000000000000000000000000001599","0x0000000000000000000000000000000000220cED"],
      recipient,
      deadline
    ]
  );

  // Final encoded data with selector
  console.log("Data:", data);
  console.log("Swap selector:", swapSelector);
  const finalData = swapSelector + data.slice(2);
  console.log("Final data:", finalData);
  const swapData = {
    router: routerAddress,
    data: finalData,
    amountIndex: 4,    // 4 (selector) + 32 (first param offset)
    minIndex: 36,       // amountIndex + 32
    minAmountSign: 1,
    isFromHTS,
    isToHTS,
};

  const setSwapInfoTx = await beefySwapper.setSwapInfo(SAUCE, HBARX, swapData);
  await setSwapInfoTx.wait(1);
  console.log("Swap info set successfully");

  // Check swap info again
  const updatedSwapInfo = await beefySwapper.swapInfo(SAUCE, HBARX);
  console.log("Swap Info:");
  console.log("  Router:", updatedSwapInfo.router);
  console.log("  Data:", updatedSwapInfo.data);
  console.log("  Amount Index:", updatedSwapInfo.amountIndex);
  console.log("  Min Index:", updatedSwapInfo.minIndex);
  console.log("  Min Amount Sign:", updatedSwapInfo.minAmountSign);
  console.log("  isFromHTS:", updatedSwapInfo.isFromHTS);
  console.log("  isToHTS:", updatedSwapInfo.isToHTS);

  // Check balances before swap
  const fromTokenBalanceBefore = await fromToken.balanceOf(deployer.address);
  const toTokenBalanceBefore = await toToken.balanceOf(deployer.address);
  console.log(`Balance before swap - SAUCE: ${fromTokenBalanceBefore}`);
  console.log(`Balance before swap - HBARX: ${toTokenBalanceBefore}`);

  // Approve tokens for swapper if not HTS token
    // console.log("Approving tokens for swapper...");
    // const approveTx = await fromToken.approve(beefySwapperAddress, amountToSwap);
    // await approveTx.wait(1);
    // console.log("Tokens approved");

  try {
    console.log(`Swapping ${ethers.utils.formatUnits(amountToSwap, 6)} SAUCE to HBARX...`);
    
    // Execute the swap with a gas limit
    // Using the contract's functions directly
    const swapTx = await beefySwapper["swap(address,address,uint256,uint256)"](
      SAUCE,
      HBARX,
      amountToSwap,
      0,
      { gasLimit: 3000000 } 
    );
    
    console.log(`Swap transaction submitted: ${swapTx.hash}`);
    const receipt = await swapTx.wait();
    console.log(`Swap completed with status: ${receipt.status === 1 ? 'Success' : 'Failed'}`);
    
    // Check for Swap event
    const swapEvent = receipt.events?.find(e => e.event === 'Swap');
    if (swapEvent) {
      console.log("Swap Event Details:");
      console.log(`  From: ${swapEvent.args.fromToken}`);
      console.log(`  To: ${swapEvent.args.toToken}`);
      console.log(`  Amount In: ${ethers.utils.formatUnits(swapEvent.args.amountIn, 6)}`);
      console.log(`  Amount Out: ${ethers.utils.formatUnits(swapEvent.args.amountOut, 8)}`);
    }
    
    // Check balances after swap
    const fromTokenBalanceAfter = await fromToken.balanceOf(deployer.address);
    const toTokenBalanceAfter = await toToken.balanceOf(deployer.address);
    console.log(`Balance after swap - SAUCE: ${ethers.utils.formatUnits(fromTokenBalanceAfter, 6)}`);
    console.log(`Balance after swap - HBARX: ${ethers.utils.formatUnits(toTokenBalanceAfter, 8)}`);
    
    // Calculate differences
    const fromTokenDiff = fromTokenBalanceBefore.sub(fromTokenBalanceAfter);
    const toTokenDiff = toTokenBalanceAfter.sub(toTokenBalanceBefore);
    console.log(`SAUCE spent: ${ethers.utils.formatUnits(fromTokenDiff, 6)}`);
    console.log(`HBARX received: ${ethers.utils.formatUnits(toTokenDiff, 8)}`);
    
  } catch (error) {
    console.error("Error during swap:", error);
    
    // Try to get more detailed error information
    if (error.data) {
      const errorReason = error.data.toString();
      console.error("Error data:", errorReason);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
