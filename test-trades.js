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
const MARKET_SLUG = 'eth-updown-15m-1763560800';  // Updated market slug
const OUTCOME = 'Up';  // Low-priced outcome for sub-$1 test
const AMOUNT_USDC = 0.5;  // Sub-$1 test trade
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

  // Load creds from env
  const API_KEY = process.env.API_KEY;
  const API_SECRET = process.env.API_SECRET;
  const API_PASSPHRASE = process.env.API_PASSPHRASE;

  if (!API_KEY || !API_SECRET || !API_PASSPHRASE) {
    console.error('Missing env vars: API_KEY, API_SECRET, and API_PASSPHRASE required for creds.');
    return;
  }

  const creds = {
    key: API_KEY,
    secret: API_SECRET,
    passphrase: API_PASSPHRASE
  };

  // Initialize ClobClient with creds
  const clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER_ADDRESS);
  console.log('Initialized ClobClient with creds.');

  // Get best ask to calculate approximate size (shares = USDC / best_ask)
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
    console.log('No valid sell orders available.');
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

  // For passive limit buy: Set price just below bestAsk to avoid crossing (non-marketable)
  const passivePrice = bestAsk - parseFloat(tickSize);  // Subtract tickSize for passive; adjust epsilon if needed
  if (passivePrice <= 0) {
    console.error('Passive price would be non-positive; adjust market or epsilon.');
    return;
  }

  console.log(`Placing $${AMOUNT_USDC} passive limit buy for ~${buySize.toFixed(4)} shares of ${OUTCOME} at $${passivePrice.toFixed(4)} (below best ask $${bestAsk.toFixed(4)})...`);

  const buyParams = {
    tokenID: tokenId,
    price: passivePrice,  // Passive price < bestAsk
    side: Side.BUY,
    size: buySize,
  };
  const marketParams = { tickSize, negRisk };

  let buyResponse;
  try {
    buyResponse = await clobClient.createAndPostOrder(buyParams, marketParams, OrderType.GTC);  // Changed to GTC
    console.log('Buy order response:');
    console.log(buyResponse);
    console.log('Order placed successfully! It will rest until filled or canceled. Check status via clobClient.getOrder(buyResponse.orderID)');
  } catch (error) {
    console.error('Error placing buy:', error.message);
    return;
  }

  // Check if buy was successful (use success and status from response)
  if (!buyResponse.success || buyResponse.status !== 'matched') {
    console.log('Buy likely not immediately filled; skipping sell for this test. Monitor for fills.');
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

  // For passive limit sell: Get best bid and set price just above it
  let bestBid;
  try {
    const priceUrl = `${CLOB_HOST}/price?token_id=${tokenId}&side=buy`;
    const resp = await axios.get(priceUrl);
    bestBid = parseFloat(resp.data.price);
  } catch (error) {
    console.error('Error fetching best bid:', error.message);
    return;
  }

  if (isNaN(bestBid) || bestBid <= 0) {
    console.log('No valid buy orders available for sell.');
    return;
  }

  const passiveSellPrice = bestBid + parseFloat(tickSize);  // Add tickSize for passive sell > bestBid

  console.log(`Placing passive limit sell for ${sharesToSell.toFixed(6)} shares of ${OUTCOME} at $${passiveSellPrice.toFixed(4)} (above best bid $${bestBid.toFixed(4)})...`);

  const sellParams = {
    tokenID: tokenId,
    price: passiveSellPrice,  // Passive price > bestBid
    side: Side.SELL,
    size: sharesToSell,
  };

  let sellResponse;
  try {
    sellResponse = await clobClient.createAndPostOrder(sellParams, marketParams, OrderType.GTC);  // Changed to GTC
    console.log('Sell order response:');
    console.log(sellResponse);
  } catch (error) {
    console.error('Error placing sell:', error.message);
  }
}

main().catch(error => console.error('Unexpected error:', error));