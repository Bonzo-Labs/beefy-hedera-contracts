import hardhat, { ethers, web3 } from "hardhat";
import BeefyOracleAbi from "../../data/abi/BeefyOracle.json";
import UniswapV3FactoryAbi from "../../data/abi/UniswapV3Factory.json";
import UniswapV2FactoryAbi from "../../data/abi/UniswapV2Factory.json";
import VelodromeFactoryAbi from "../../data/abi/VelodromeFactory.json";
import { addressBook } from "blockchain-addressbook";
import { IBeefyOracle } from "../../typechain-types";
const {
  platforms: { beefyfinance },
  tokens: {
    USDC: { address: USDC},
    WETH: { address: ETH},
    TOKE: {address: TOKE}
  },
} = addressBook.ethereum;

const SAUCE = "0x0000000000000000000000000000000000120f46";
const WHBAR = "0x0000000000000000000000000000000000003ad2";

const ethers = hardhat.ethers;

const nullAddress = "0x0000000000000000000000000000000000000000";
const uniswapV3Factory = "0xAAA32926fcE6bE95ea2c51cB4Fcb60836D320C42";
const uniswapV2Factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const velodromeFactory = "0x92aF10c685D2CF4CD845388C5f45aC5dc97C5024";
const saucerSwapV2Factory = "0x00000000000000000000000000000000001243ee"; // SaucerSwapV2 Factory address

const beefyfinanceOracle = "0x3f1DDEd53Ab55520698d11e4D3295F8dAE2a834f";
const chainlinkOracle = "0x3DC71AAb800C5Acfe521d5bD86c06b2EfF477062";
const uniswapV3Oracle = "0xc26314091EB7a9c75E5536f7f54A8F63e829547D";
// const uniswapV2Oracle = beefyfinance.beefyOracleUniswapV2;
const solidlyOracle = "0xE6e5732245b3e886DD8897a93D21D29bb652d683";
const supraOracle = "0xA55d9ac9aca329f5687e1cC286d0847e3f02062e"; // Supra Oracle address testnet

const config = {
  type: "supra",
  chainlink: {
   // token: wstETH,
    feed: "0xe428fbdbd61CC1be6C273dC0E27a1F43124a86F3",
  },
  uniswapV3: {
 //   path: [[ETH, SCR, 3000]],
    twaps: [300],
    factory: uniswapV3Factory,
  },
  uniswapV2: {
    path: [ETH, TOKE],
    twaps: [7200],
    factory: uniswapV2Factory,
  },
  solidly: {
  //  path: [[ETH, TKN, false]],
    twaps: [4],
    factory: velodromeFactory,
  },
  supra: {
    path: [[WHBAR, SAUCE, 3000]], // SaucerSwapV2 path with fee tier
    twaps: [300],
    factory: saucerSwapV2Factory,
  },
};

async function main() {
  switch(config.type) {
    case 'chainlink':
      await chainlink();
      break;
    case 'uniswapV3':
      await uniswapV3();
      break;
    case 'uniswapV2':
      await uniswapV2();
      break;
    case 'solidly':
      await solidly();
      break;
    case 'supra':
      await supra();
      break;
  }
};

async function chainlink() {
  const data = ethers.utils.defaultAbiCoder.encode(
    ["address"],
    [config.chainlink.feed]
  );

  await setOracle(config.chainlink.token, chainlinkOracle, data);
};

async function uniswapV3() {
  const factory = await ethers.getContractAt(UniswapV3FactoryAbi, config.uniswapV3.factory);
  const tokens = [];
  const pairs = [];
  for (let i = 0; i < config.uniswapV3.path.length; i++) {
    tokens.push(config.uniswapV3.path[i][0]);
    const pair = await factory.getPool(
      config.uniswapV3.path[i][0],
      config.uniswapV3.path[i][1],
      config.uniswapV3.path[i][2]
    );
    pairs.push(pair);
  }
  tokens.push(config.uniswapV3.path[config.uniswapV3.path.length - 1][1]);

  const data = ethers.utils.defaultAbiCoder.encode(
    ["address[]","address[]","uint256[]"],
    [tokens, pairs, config.uniswapV3.twaps]
  );

  await setOracle(tokens[tokens.length - 1], uniswapV3Oracle, data);
};

async function uniswapV2() {
  const factory = await ethers.getContractAt(UniswapV2FactoryAbi, config.uniswapV2.factory);
  const tokens = [];
  const pairs = [];
  for (let i = 0; i < config.uniswapV2.path.length - 1; i++) {
    tokens.push(config.uniswapV2.path[i]);
    const pair = await factory.getPair(
      config.uniswapV2.path[i],
      config.uniswapV2.path[i + 1]
    );
    pairs.push(pair);
  }
  tokens.push(config.uniswapV2.path[config.uniswapV2.path.length - 1]);

  console.log(tokens, pairs, config.uniswapV2.twaps)

  const data = ethers.utils.defaultAbiCoder.encode(
    ["address[]","address[]","uint256[]"],
    [tokens, pairs, config.uniswapV2.twaps]
  );

  // await setOracle(tokens[tokens.length - 1], uniswapV2Oracle, data);
};

async function solidly() {
  const factory = await ethers.getContractAt(VelodromeFactoryAbi, config.solidly.factory);
  const tokens = [];
  const pairs = [];
  for (let i = 0; i < config.solidly.path.length; i++) {
    tokens.push(config.solidly.path[i][0]);
    const pair = await factory.getPair(
      config.solidly.path[i][0],
      config.solidly.path[i][1],
      config.solidly.path[i][2]
    );
    pairs.push(pair);
  }
  tokens.push(config.solidly.path[config.solidly.path.length - 1][1]);

  const data = ethers.utils.defaultAbiCoder.encode(
    ["address[]","address[]","uint256[]"],
    [tokens, pairs, config.solidly.twaps]
  );

  await setOracle(tokens[tokens.length - 1], solidlyOracle, data);
};

async function supra() {
  // SaucerSwapV2 is a fork of UniswapV3, so we use similar logic
  const factory = await ethers.getContractAt(UniswapV3FactoryAbi, config.supra.factory);
  const tokens = [];
  const pairs = [];
  for (let i = 0; i < config.supra.path.length; i++) {
    tokens.push(config.supra.path[i][0]);
    const pair = await factory.getPool(
      config.supra.path[i][0],
      config.supra.path[i][1],
      config.supra.path[i][2]
    );
    pairs.push(pair);
  }
  tokens.push(config.supra.path[config.supra.path.length - 1][1]);

  // Encode Supra Oracle data
  const supraData = ethers.utils.defaultAbiCoder.encode(
    ["address", "address"],
    [supraOracle, tokens[tokens.length - 1]]
  );

  await setOracle(tokens[tokens.length - 1], supraOracle, supraData);
};

async function setOracle(token, oracle, data) {
  // Create signer using private key from environment variables
  const provider = new ethers.providers.JsonRpcProvider(process.env.HEDERA_TESTNET_RPC);
  const keeper = new ethers.Wallet(process.env.KEEPER_PK, provider);
  console.log("keeper", keeper.address)

  const oracleContract = await ethers.getContractAt(BeefyOracleAbi, beefyfinanceOracle, keeper);
  const owner = await oracleContract.owner();
  console.log("BeefyOracle owner:", owner);
  
  // Check if keeper is the owner
  if (owner.toLowerCase() !== keeper.address.toLowerCase()) {
    console.log("Warning: Keeper is not the owner of the BeefyOracle contract");
    console.log("Keeper:", keeper.address);
  }

  let tx = await oracleContract.setOracle(token, oracle, data, {gasLimit: 1000000});
  tx = await tx.wait();
    tx.status === 1
      ? console.log(`Info set for ${token} with tx: ${tx.transactionHash}`)
      : console.log(`Could not set info for ${token}} with tx: ${tx.transactionHash}`)
};

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
