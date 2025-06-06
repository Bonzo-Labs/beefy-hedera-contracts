const { ethers } = require("hardhat");

async function approveToken(tokenAddress, spenderAddress, amount) {
    try {
        // Get the signer
        const [signer] = await ethers.getSigners();
        
        // Create contract instance for the token
        const token = await ethers.getContractAt("@openzeppelin-4/contracts/token/ERC20/IERC20.sol:IERC20", tokenAddress);
        
        // Approve the spender to spend tokens
        const approveTx = await token.approve(spenderAddress, amount);
        await approveTx.wait();
        
        console.log(`Successfully approved ${amount} tokens for ${spenderAddress}`);
        
        // Verify the allowance
        const allowance = await token.allowance(signer.address, spenderAddress);
        console.log(`New allowance: ${allowance}`);
        
        return approveTx;
    } catch (error) {
        console.error("Error approving token:", error);
        throw error;
    }
}

// Example usage:
approveToken("0x00000000000000000000000000000000000cba44", "0x0000000000000000000000000000000000158d97", ethers.utils.parseUnits("1", 8))
