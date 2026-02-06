const { ethers } = require("hardhat");

const CLM_VAULTS = [
  {
    name: "BONZO-XBONZO",
    vaultAddress: "0xcfba07324bd207C3ED41416a9a36f8184F9a2134",
    strategyAddress: "0x3Dab58797e057878d3cD8f78F28C6967104FcD0c",
    positionWidth: 8,
    maxTickDev: 8,
  },
  {
    name: "SAUCE-XSAUCE",
    vaultAddress: "0x8AEE31dFF6264074a1a3929432070E1605F6b783",
    strategyAddress: "0xE9Ab1D3C3d086A8efA0f153f107B096BEaBDee6f",
    positionWidth: 6,
    maxTickDev: 6,
  },
  {
    name: "USDC-HBAR",
    vaultAddress: "0x724F19f52A3E0e9D2881587C997db93f9613B2C7",
    strategyAddress: "0x157EB9ba35d70560D44394206D4a03885C33c6d5",
    positionWidth: 9,
    maxTickDev: 9,
  },
  {
    name: "USDC-SAUCE",
    vaultAddress: "0x0171baa37fC9f56c98bD56FEB32bC28342944C6e",
    strategyAddress: "0xDC74aC010A60357A89008d5eBDBaF144Cf5BD8C6",
    positionWidth: 9,
    maxTickDev: 9,
  },
];

function normalizeAddress(addressLabel, value) {
  if (!value) {
    throw new Error(`Missing ${addressLabel}. Provide it as an argument or env var.`);
  }

  if (!ethers.utils.isAddress(value)) {
    throw new Error(`Invalid ${addressLabel}: ${value}`);
  }

  return ethers.utils.getAddress(value);
}

async function harvest(strategyAddress, callFeeRecipient, signer) {
  const normalizedStrategy = normalizeAddress("strategy address", strategyAddress);
  const signerOrProvider = signer || (await ethers.getSigners())[0];

  const strategy = await ethers.getContractAt("SaucerSwapLariRewardsCLMStrategy", normalizedStrategy, signerOrProvider);

  // Check if strategy is calm (required for harvest)
  let isCalm = false;
  try {
    isCalm = await strategy.isCalm();
    console.log(`Strategy calm status: ${isCalm}`);
    if (!isCalm) {
      console.warn("⚠️  Warning: Strategy is not in calm period. Harvest may fail.");
    }
  } catch (error) {
    console.warn(`⚠️  Warning: Could not check calm status: ${error.message}`);
  }

  // Get mint fee to calculate required HBAR
  let mintFee;
  try {
    mintFee = await strategy.getMintFee();
    console.log(`Mint fee: ${ethers.utils.formatEther(mintFee)} HBAR`);
  } catch (error) {
    console.error(`Failed to get mint fee: ${error.message}`);
    throw error;
  }

  // Harvest requires msg.value >= 2 * getMintFee()
  const requiredHBAR = mintFee.mul(2);
  const requiredHBARFormatted = ethers.utils.formatEther(requiredHBAR);
  console.log(`Required HBAR for harvest: ${requiredHBARFormatted} HBAR (2 * mintFee)`);

  // Convert to tinybars: getMintFee() returns value in wei (18 decimals),
  // need to convert to tinybars (8 decimals) by multiplying by 10^10
  const requiredTinybars = requiredHBAR.mul(ethers.BigNumber.from(10).pow(10));

  console.log(`Calling harvest on strategy ${normalizedStrategy}...`);
  if (callFeeRecipient) {
    const normalizedRecipient = normalizeAddress("call fee recipient", callFeeRecipient);
    console.log(`Using call fee recipient: ${normalizedRecipient}`);
    const tx = await strategy.harvest(normalizedRecipient, {
      value: requiredTinybars,
      gasLimit: 5000000,
    });
    console.log("Sent transaction:", tx.hash);

    const receipt = await tx.wait();
    console.log("Receipt trx hash:", receipt.transactionHash);
    console.log("Confirmed in block:", receipt.blockNumber);
  } else {
    const tx = await strategy.harvest({
      value: requiredTinybars,
      gasLimit: 5000000,
    });
    console.log("Sent transaction:", tx.hash);

    const receipt = await tx.wait();
    console.log("Receipt trx hash:", receipt.transactionHash);
    console.log("Confirmed in block:", receipt.blockNumber);
  }
}

/**
 * Example CLI usage:
 *
 * Harvest all strategies:
 * npx hardhat run scripts/strategy/harvest.js --network hedera_mainnet
 *
 * Harvest specific strategy:
 * npx hardhat run scripts/strategy/harvest.js --network hedera_mainnet -- --strategy 0x5AE118989CE26Cb78823660d682770c05E607985
 *
 * Harvest with specific call fee recipient:
 * npx hardhat run scripts/strategy/harvest.js --network hedera_mainnet -- --recipient 0xYourAddress
 */
if (require.main === module) {
  (async () => {
    try {
      const signers = await ethers.getSigners();
      const signer = signers[0];

      console.log(`Using signer: ${signer.address}`);

      // Parse command line arguments
      const args = process.argv.slice(2);
      const strategyArg = args.find(arg => arg.startsWith("--strategy="))?.split("=")[1];
      const recipientArg = args.find(arg => arg.startsWith("--recipient="))?.split("=")[1];

      if (strategyArg) {
        // Harvest specific strategy
        const strategyAddress = normalizeAddress("strategy address", strategyArg);
        const recipient = recipientArg ? normalizeAddress("call fee recipient", recipientArg) : null;
        console.log(`\nHarvesting strategy: ${strategyAddress}`);
        await harvest(strategyAddress, recipient, signer);
      } else {
        // Harvest all strategies
        for (const vault of CLM_VAULTS) {
          console.log(`\nProcessing ${vault.name} (Strategy: ${vault.strategyAddress})`);
          try {
            const recipient = recipientArg ? normalizeAddress("call fee recipient", recipientArg) : null;
            await harvest(vault.strategyAddress, recipient, signer);
          } catch (error) {
            console.error(`Failed to harvest ${vault.name}:`, error.message);
          }
        }
      }

      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  })();
}

module.exports = { harvest };
