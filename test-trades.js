const { ethers } = require('ethers');
const axios = require('axios');
const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const dotenv = require('dotenv');

dotenv.config();

// Constants
const CLOB_HOST = 'https://clob.polymarket.com';  // For trading
const GAMMA_HOST = 'https://gamma-api.polymarket.com';  // For fetching markets
const CHAIN_ID = 137;  // Polygon
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || '';  // If empty, defaults to signer.address
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL;
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';  // ConditionalTokens contract
const MARKET_SLUG = 'btc-updown-4h-1763485200';  // Update to a current active market (e.g., from polymarket.com)
const OUTCOME = 'Up';  // Adjust based on actual outcomes (e.g., 'Yes' for binary markets)
const AMOUNT_USDC = 6.0;  // $6 test trade; matches min order size
const SIGNATURE_TYPE = 2;  // 2 for smart contract wallets (EIP-1271)


// ERC1155 balanceOf ABI
const CTF_ABI = [
  {
    "inputs": [{"name": "account", "type": "address"}, {"name": "id", "type": "uint256"}],
    "name": "balanceOf",
    "outputs": [{"name": "", "type": "uint256"}],
    "stateMutability": "view",
    "type": "function"
  }
];

// Function to sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize provider for queries (ethers v5 syntax)
const provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC_URL);

// Main function
async function main() {
  if (!PRIVATE_KEY || !POLYGON_RPC_URL) {
    console.error('Missing env vars: PRIVATE_KEY and POLYGON_RPC_URL required.');
    return;
  }

  const signer = new ethers.Wallet(PRIVATE_KEY, provider);  // Provider optional but useful for queries

  console.log(`Initialized signer for address: ${signer.address}`);

  // Fetch the specific market using Gamma API and slug
  console.log(`Fetching market for slug: ${MARKET_SLUG}...`);
  let market;
  try {
    const response = await axios.get(`${GAMMA_HOST}/markets?slug=${MARKET_SLUG}&limit=1`);
    market = response.data[0];
  } catch (error) {
    console.error('Error fetching market:', error.message);
    return;
  }

  if (!market || !market.active) {
    console.log('Market not found or inactive. Check slug and try an active market (e.g., from polymarket.com).');
    console.log('API response:', market);
    return;
  }

  console.log(`Found market: ${market.question}`);
  console.log('Market details for debug:', market);  // Log full market to inspect endDateIso, etc.

  // Find the token ID for the desired outcome
  const outcomes = JSON.parse(market.outcomes || '[]');
  const clobTokenIds = JSON.parse(market.clobTokenIds || '[]');
  const outcomeIndex = outcomes.indexOf(OUTCOME);
  if (outcomeIndex === -1) {
    console.log(`Outcome '${OUTCOME}' not found in outcomes: ${outcomes}`);
    return;
  }
  const tokenId = clobTokenIds[outcomeIndex];
  console.log(`Token ID for ${OUTCOME}: ${tokenId}`);

  // Get tickSize and negRisk from market
  const tickSize = market.orderPriceMinTickSize || '0.01';  // Use correct field; fallback to common min
  const negRisk = market.negRisk === true || market.negRisk === 'true';  // Boolean

  // Derive or create API key using signer (uncomment to run once, then copy to .env and re-comment)
  let newCreds;
  try {
    console.log('Deriving/creating API key with signer...');
    const tempClobClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, null, SIGNATURE_TYPE, FUNDER_ADDRESS);
    newCreds = await tempClobClient.deriveApiKey();  // Derives existing or creates new
    console.log('New API creds (copy to .env):');
    console.log(`API_KEY=${newCreds.key}`);
    console.log(`API_SECRET=${newCreds.secret}`);
    console.log(`API_PASSPHRASE=${newCreds.passphrase}`);
  } catch (error) {
    console.error('Error deriving/creating API key:', error.message, error.response?.data);
    return;
  }

  // Use the new creds for this run
  const creds = newCreds;

  // Initialize ClobClient with creds
  const clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER_ADDRESS);
  console.log('Initialized ClobClient with new creds.');

  // Place market buy for $AMOUNT_USDC (FOK with price=0.99 to simulate market buy)
  // First, get best ask to calculate approximate size (shares = USDC / best_ask)
  let bestAsk;
  try {
    const priceUrl = `${CLOB_HOST}/price?token_id=${tokenId}&side=sell`;
    const resp = await axios.get(priceUrl);
    bestAsk = parseFloat(resp.data.price);
  } catch (error) {
    console.error('Error fetching best ask:', error.message);
    return;
  }

  if (isNaN(bestAsk) || bestAsk <= 0) {
    console.log('No valid sell orders available for market buy.');
    return;
  }

  let buySize = AMOUNT_USDC / bestAsk;
  buySize = Math.floor(buySize * 10000) / 10000;  // Round down to 4 decimals initially

  console.log(`Initial calculated buySize: ${buySize.toFixed(4)}`);

  // Adjust buySize down by 0.0001 until makerAmount % 10000 == 0 (for 2 decimal precision in USDC)
  const price = 0.99;
  let adjusted = false;
  while (true) {
    const sizeStr = buySize.toFixed(4);
    const sizeBN = ethers.utils.parseUnits(sizeStr, 6);
    const priceBN = ethers.utils.parseUnits(price.toString(), 6);
    const makerBN = sizeBN.mul(priceBN).div(ethers.utils.parseUnits("1", 6));

    if (makerBN.mod(10000).isZero()) {
      break;
    }

    buySize -= 0.0001;
    adjusted = true;
    if (buySize <= 0) {
      console.error('Cannot find valid size for precision requirements.');
      return;
    }
  }

  if (adjusted) {
    console.log(`Adjusted buySize for precision: ${buySize.toFixed(4)}`);
  }

  console.log(`Placing $${AMOUNT_USDC} market buy for ~${buySize.toFixed(4)} shares of ${OUTCOME} (based on best ask $${bestAsk.toFixed(4)})...`);

  const buyParams = {
    tokenID: tokenId,
    price: price,  // Max valid price for market buy (clamped to 0.99)
    side: Side.BUY,
    size: buySize,
  };
  const marketParams = { tickSize, negRisk };

  let buyResponse;
  try {
    buyResponse = await clobClient.createAndPostOrder(buyParams, marketParams, OrderType.FOK);
    console.log('Buy trade response:');
    console.log(buyResponse);
  } catch (error) {
    console.error('Error placing buy:', error.message);
    return;
  }

  // Check if buy was successful (use success and status from response)
  if (!buyResponse.success || buyResponse.status !== 'matched') {
    console.log('Buy likely failed; skipping sell.');
    return;
  }

  // Wait for settlement
  console.log('Waiting 10 seconds for buy to settle...');
  await sleep(10000);

  // Query exact token balance
  const account = FUNDER_ADDRESS || signer.address;
  const ctfContract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
  const rawBalance = await ctfContract.balanceOf(account, ethers.BigNumber.from(tokenId));
  let sharesToSell = parseFloat(ethers.utils.formatUnits(rawBalance, 6));
  sharesToSell = Math.floor(sharesToSell * 10000) / 10000;  // Round down to 4 decimals initially

  // Adjust sharesToSell for sell precision (for SELL, takerAmount = shares * price *1e6 %10000 ==0)
  const sellPrice = 0.01;
  adjusted = false;
  while (true) {
    const sizeStr = sharesToSell.toFixed(4);
    const sizeBN = ethers.utils.parseUnits(sizeStr, 6);
    const priceBN = ethers.utils.parseUnits(sellPrice.toString(), 6);
    const takerBN = sizeBN.mul(priceBN).div(ethers.utils.parseUnits("1", 6));

    if (takerBN.mod(10000).isZero()) {
      break;
    }

    sharesToSell -= 0.0001;
    adjusted = true;
    if (sharesToSell <= 0) {
      console.error('Cannot find valid sell size for precision requirements.');
      return;
    }
  }

  if (adjusted) {
    console.log(`Adjusted sharesToSell for precision: ${sharesToSell.toFixed(4)}`);
  }

  if (sharesToSell <= 0) {
    console.log('No shares available to sell.');
    return;
  }

  console.log(`Exact shares to sell: ${sharesToSell.toFixed(6)}`);

  // Wait additional time (total ~60s from buy)
  console.log('Waiting additional 50 seconds before selling...');
  await sleep(50000);

  // Place market sell for exact shares (FOK with price=0.01 to simulate market sell)
  console.log(`Placing market sell for ${sharesToSell.toFixed(6)} shares of ${OUTCOME}...`);
  const sellParams = {
    tokenID: tokenId,
    price: sellPrice,  // Min valid price for market sell (clamped to 0.01)
    side: Side.SELL,
    size: sharesToSell,
  };

  let sellResponse;
  try {
    sellResponse = await clobClient.createAndPostOrder(sellParams, marketParams, OrderType.FOK);
    console.log('Sell trade response:');
    console.log(sellResponse);
  } catch (error) {
    console.error('Error placing sell:', error.message);
  }
}

main().catch(error => console.error('Unexpected error:', error));