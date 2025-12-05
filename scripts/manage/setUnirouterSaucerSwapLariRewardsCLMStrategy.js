const hardhat = require("hardhat");

/**
 * Script to set unirouter for SaucerSwapLariRewardsCLMStrategy
 * 
 * Usage:
 * STRATEGY_ADDRESS=0x... UNIROUTER_ADDRESS=0x... npx hardhat run scripts/manage/setUnirouterSaucerSwapLariRewardsCLMStrategy.js --network hedera_mainnet
 * STRATEGY_ADDRESS=0x... UNIROUTER_ADDRESS=0x... npx hardhat run scripts/manage/setUnirouterSaucerSwapLariRewardsCLMStrategy.js --network hedera_testnet
 * 
 * The setUnirouter function:
 * - Removes allowances from the old unirouter
 * - Sets the new unirouter address
 * - Gives allowances to the new unirouter
 * - Emits SetUnirouter event
 */

const ethers = hardhat.ethers;

// Get addresses from environment variables or use defaults
const STRATEGY_ADDRESS =  "0x07A66c6F7cF1a8353Df3e51dB8396BaCceF1FFF1";
const UNIROUTER_ADDRESS = "0x00000000000000000000000000000000003c437a";

async function main() {
  if (!STRATEGY_ADDRESS) {
    throw new Error("STRATEGY_ADDRESS is required. Set it as environment variable or pass as first argument.");
  }

  if (!UNIROUTER_ADDRESS) {
    throw new Error("UNIROUTER_ADDRESS is required. Set it as environment variable.");
  }

  // Validate address format
  if (!ethers.utils.isAddress(UNIROUTER_ADDRESS)) {
    throw new Error(`Invalid UNIROUTER_ADDRESS: ${UNIROUTER_ADDRESS}`);
  }

  const [signer] = await ethers.getSigners();
  console.log("Account:", signer.address);
  console.log("Account balance:", ethers.utils.formatEther(await signer.getBalance()), "HBAR");
  console.log("Strategy address:", STRATEGY_ADDRESS);
  console.log("New Unirouter address:", UNIROUTER_ADDRESS);
  console.log("");

  // Connect to the strategy contract
  const strategy = await ethers.getContractAt(
    "SaucerSwapLariRewardsCLMStrategy",
    STRATEGY_ADDRESS,
    signer
  );

  // Get current unirouter if available
  try {
    const currentUnirouter = await strategy.unirouter();
    console.log("Current Unirouter:", currentUnirouter);
  
  } catch (error) {
    console.log("⚠️  Could not fetch current unirouter:", error.message);
    console.log("");
  }

  // Verify the signer is the owner
  try {
    const owner = await strategy.owner();
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      console.log("⚠️  Warning: Signer is not the owner!");
      console.log("   Owner:", owner);
      console.log("   Signer:", signer.address);
      console.log("");
    } else {
      console.log("✅ Signer is the owner");
      console.log("");
    }
  } catch (error) {
    console.log("⚠️  Could not verify ownership:", error.message);
    console.log("");
  }

  // Call setUnirouter function
  console.log("Calling setUnirouter()...");
  try {
    const tx = await strategy.setUnirouter(UNIROUTER_ADDRESS, {
      gasLimit:5000000, // Sufficient gas limit for allowance operations
    });

    console.log("Transaction hash:", tx.hash);
    console.log("Waiting for confirmation...");

    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      console.log("✅ setUnirouter successful!");
      console.log("   Transaction:", receipt.transactionHash);
      console.log("   Gas used:", receipt.gasUsed.toString());
      
      // Verify new unirouter is set
      try {
        const newUnirouter = await strategy.unirouter();
        console.log("   New Unirouter:", newUnirouter);
        
        if (newUnirouter.toLowerCase() === UNIROUTER_ADDRESS.toLowerCase()) {
          console.log("   ✅ Unirouter successfully updated!");
        } else {
          console.log("   ⚠️  Warning: Unirouter address mismatch!");
        }
      } catch (error) {
        console.log("   Could not verify new unirouter");
      }

      // Check for SetUnirouter event
      try {
        const SetUnirouterEvent = receipt.events?.find(
          (e) => e.event === "SetUnirouter"
        );
        if (SetUnirouterEvent) {
          console.log("   Event SetUnirouter emitted with unirouter:", SetUnirouterEvent.args[0]);
        }
      } catch (error) {
        console.log("   Could not find SetUnirouter event");
      }
    } else {
      console.log("❌ setUnirouter transaction failed!");
      console.log("   Transaction:", receipt.transactionHash);
    }
  } catch (error) {
    console.error("❌ Error calling setUnirouter():", error.message);
    if (error.reason) {
      console.error("   Reason:", error.reason);
    }
    if (error.data) {
      console.error("   Data:", error.data);
    }
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
