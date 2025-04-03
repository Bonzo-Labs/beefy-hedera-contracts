import { ethers } from "hardhat";
import ERC20Abi from "../../data/abi/ERC20.json";

// Configuration
const SAUCE = "0x0000000000000000000000000000000000120f46";
const HBARX = "0x0000000000000000000000000000000000220ced";
const routerAddress = "0x000000000000000000000000000000000046ff9b";
const amountToSwap = "10000"; // 100000 SAUCE with 6 decimals

async function main() {
  console.log("Testing UniswapRouter swap function for SAUCE to HBARX...");
  
  // Create signer using private key from environment variables
  const provider = new ethers.providers.JsonRpcProvider(process.env.HEDERA_TESTNET_RPC);
  if(!process.env.KEEPER_PK) {
    throw new Error("KEEPER_PK is not set");
  }
  const deployer = new ethers.Wallet(process.env.KEEPER_PK, provider);
  console.log("Deployer:", deployer.address);

  // Get token contracts
  const sauceToken = await ethers.getContractAt(ERC20Abi, SAUCE, deployer);
  const hbarxToken = await ethers.getContractAt(ERC20Abi, HBARX, deployer);


  // Check balances before swap
  const sauceBalanceBefore = await sauceToken.balanceOf(deployer.address);
  const hbarxBalanceBefore = await hbarxToken.balanceOf(deployer.address);
  console.log(`Balance before swap - SAUCE: ${ethers.utils.formatUnits(sauceBalanceBefore, 6)}`);
  console.log(`Balance before swap - HBARX: ${ethers.utils.formatUnits(hbarxBalanceBefore, 8)}`);

  // Create router interface
  const routerAbi = [
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)"
  ];
  const router = new ethers.Contract(routerAddress, routerAbi, deployer);

  try {
    // Approve router to spend SAUCE tokens
    console.log("Approving router to spend SAUCE tokens...");
    const approveTx = await sauceToken.approve(routerAddress, amountToSwap);
    await approveTx.wait();
    console.log("Approval successful");

    // Set swap parameters
    const amountOutMin = 0; // Set a minimum amount based on your requirements
    const path = [SAUCE, HBARX];
    const to = deployer.address;
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

    console.log(`Swapping ${ethers.utils.formatUnits(amountToSwap, 6)} SAUCE to HBARX...`);
    console.log("Swap parameters:");
    console.log("  Amount In:", ethers.utils.formatUnits(amountToSwap, 6));
    console.log("  Amount Out Min:", amountOutMin);
    console.log("  Path:", path);
    console.log("  Recipient:", to);
    console.log("  Deadline:", deadline);

    // Execute the swap
    const swapTx = await router.swapExactTokensForTokens(
      amountToSwap,
      amountOutMin,
      ["0x0000000000000000000000000000000000120f46","0x00000000000000000000000000000000000014F5","0x0000000000000000000000000000000000001599","0x0000000000000000000000000000000000220cED"],
      to,
      deadline,
      { gasLimit: 3000000 }
    );

    console.log("Swap transaction submitted:", swapTx);
    
    console.log(`Swap transaction submitted: ${swapTx.hash}`);
    const receipt = await swapTx.wait();
    console.log(`Swap completed with status: ${receipt.status === 1 ? 'Success' : 'Failed'}`);
    
    // Check balances after swap
    const sauceBalanceAfter = await sauceToken.balanceOf(deployer.address);
    const hbarxBalanceAfter = await hbarxToken.balanceOf(deployer.address);
    console.log(`Balance after swap - SAUCE: ${ethers.utils.formatUnits(sauceBalanceAfter, 6)}`);
    console.log(`Balance after swap - HBARX: ${ethers.utils.formatUnits(hbarxBalanceAfter, 8)}`);
    
    // Calculate differences
    const sauceDiff = sauceBalanceBefore.sub(sauceBalanceAfter);
    const hbarxDiff = hbarxBalanceAfter.sub(hbarxBalanceBefore);
    console.log(`SAUCE spent: ${ethers.utils.formatUnits(sauceDiff, 6)}`);
    console.log(`HBARX received: ${ethers.utils.formatUnits(hbarxDiff, 8)}`);
    
  } catch (error) {
    console.error("Error during swap:", error);
    
    // Try to get more detailed error information
    if (error instanceof Error && 'data' in error) {
      const errorReason = (error as any).data.toString();
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

