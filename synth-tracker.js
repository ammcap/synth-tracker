const { ethers } = require('ethers');
const axios = require('axios');
const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

// ANSI colors for terminal
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m'
};



// --- CONFIGURATION ---
const SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE = '0x557bed924a1bb6f62842c5742d1dc789b8d480d4'.toLowerCase();
const POLYMARKET_PROXY_ADDRESS_LOWER_CASE = '0x2ddc093099a5722dc017c70e756dd3ea5586951e'.toLowerCase();
const PHANTOM_POLYGON_WALLET_ADDRESS_LOWER_CASE = '0xf37bcCB3e7a4c9999c0D67dc618cDf8CB5C69016'.toLowerCase();
const USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'.toLowerCase();
const CTF_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045'.toLowerCase();

// [CHANGE 1] Free Public RPC (Official Polygon Bor Node)
const POLYGON_WS_URL = 'wss://polygon-bor-rpc.publicnode.com';

const DATA_API_URL = 'https://data-api.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const PHANTOM_POLYGON_WALLET_PRIVATE_KEY = process.env.PHANTOM_POLYGON_WALLET_PRIVATE_KEY;
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const API_PASSPHRASE = process.env.API_PASSPHRASE;
const SIGNATURE_TYPE = 2; // Gnosis Safe / Smart Wallet

const LEGACY_EXCHANGE = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e'.toLowerCase();
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'.toLowerCase();

// --- STRATEGY SETTINGS ---
const SLIPPAGE_BUFFER = 0.03;   
const POLL_INTERVAL_MS = 60000; // Keep checking every 60s for NEW markets (11:15, 11:30 etc)
const REDEEM_INTERVAL_MS = 60000; // [CHANGE 2] Relaxed to 5 mins to save RPC calls

// --- ABIs ---
const USDC_ABI = [
  {"inputs": [{"name": "account", "type": "address"}],"name": "balanceOf","outputs": [{"name": "", "type": "uint256"}],"stateMutability": "view","type": "function"},
  {"inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],"name": "approve","outputs": [{"name": "", "type": "bool"}],"stateMutability": "nonpayable","type": "function"},
  {"inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],"name": "allowance","outputs": [{"name": "", "type": "uint256"}],"stateMutability": "view","type": "function"}
];

const CTF_ABI = [
  {"inputs": [{"name": "account", "type": "address"}, {"name": "id", "type": "uint256"}],"name": "balanceOf","outputs": [{"name": "", "type": "uint256"}],"stateMutability": "view","type": "function"},
  {"inputs": [{"name": "collateralToken", "type": "address"},{"name": "parentCollectionId", "type": "bytes32"},{"name": "conditionId", "type": "bytes32"},{"name": "partition", "type": "uint256[]"},{"name": "amount", "type": "uint256"}],"name": "splitPosition","outputs": [],"stateMutability": "nonpayable","type": "function"},
  {"inputs": [{"name": "collateralToken", "type": "address"},{"name": "parentCollectionId", "type": "bytes32"},{"name": "conditionId", "type": "bytes32"},{"name": "indexSets", "type": "uint256[]"}],"name": "redeemPositions","outputs": [],"stateMutability": "nonpayable","type": "function"}
];

const PROXY_ABI = [
  {"inputs": [{"internalType": "address", "name": "to", "type": "address"},{"internalType": "uint256", "name": "value", "type": "uint256"},{"internalType": "bytes", "name": "data", "type": "bytes"},{"internalType": "enum Enum.Operation", "name": "operation", "type": "uint8"},{"internalType": "uint256", "name": "safeTxGas", "type": "uint256"},{"internalType": "uint256", "name": "baseGas", "type": "uint256"},{"internalType": "uint256", "name": "gasPrice", "type": "uint256"},{"internalType": "address", "name": "gasToken", "type": "address"},{"internalType": "address payable", "name": "refundReceiver", "type": "address"},{"internalType": "bytes", "name": "signatures", "type": "bytes"}],"name": "execTransaction","outputs": [{"internalType": "bool", "name": "success", "type": "bool"}],"stateMutability": "payable","type": "function"}
];

const ORDER_FILLED_TOPIC = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'));

// --- GLOBAL STATE ---
let provider, signer, clobClient;
let userCollateral = 0;
let userPositionsValue = 0;
let pendingTxs = new Map();

let marketCache = new Map(); 
let activeConditions = new Set(); 
let initialSynthMarkets = new Set(); 
let logFilePath;

// --- INITIALIZATION ---
function initLogging() {
  const logsDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
  const now = new Date().toISOString().replace(/[:\-]/g, '').split('.')[0];
  logFilePath = path.join(logsDir, `synth-tracker-${now}.log`);
}

// --- HELPER: PARSE MARKET DATA ---
function parseAndCacheMarket(m) {
    if (!m || activeConditions.has(m.conditionId)) return null;

    // Double check logic: Only Cache if it's Crypto related (Redundancy)
    const title = m.question ? m.question.toLowerCase() : "";
    const isCrypto = title.includes("bitcoin") || title.includes("ethereum") || title.includes("solana");
    if (!isCrypto) return null;

    const tokenIds = JSON.parse(m.clobTokenIds || '[]');
    const outcomes = JSON.parse(m.outcomes || '[]');
    
    tokenIds.forEach((tid, index) => {
        marketCache.set(tid.toString(), {
            conditionId: m.conditionId,
            marketTitle: m.question,
            outcomeLabel: outcomes[index],
            myTokenId: tid.toString(),
            oppositeTokenId: tokenIds[index === 0 ? 1 : 0].toString(), 
            tickSize: m.orderPriceMinTickSize || "0.01",
            negRisk: m.negRisk
        });
    });
    activeConditions.add(m.conditionId);
    return m; 
}

// --- [CHANGE 3] OPTIMIZED CACHE LOGIC ---
async function updateMarketCache() {
  try {
      // Instead of limit:5000, we fire 2 specific requests for the tags we care about.
      // This is much lighter on the API and your CPU.
      
      const tags = ['bitcoin', 'ethereum']; // You can add 'solana' if Synth trades it
      let newCount = 0;

      for (const tag of tags) {
        const resp = await axios.get(`${GAMMA_API_URL}/markets`, {
            params: { 
                closed: false, 
                active: true, 
                tag_slug: tag,
                limit: 100 // We only need the top 100 active markets per coin, not 5000
            } 
        });

        for (const m of resp.data) {
            if (parseAndCacheMarket(m)) newCount++;
        }
      }

      if (newCount > 0) console.log(colors.gray + `[Cache] Updated. Found ${newCount} new Crypto markets.` + colors.reset);
  } catch (e) {
      console.error("Cache Update Failed:", e.message);
  }
}

// --- BLACKLIST LOGIC (Kept same, just runs faster now) ---
async function fetchSynthPositions() {
    console.log(colors.yellow + "Checking Synth's existing positions to ignore..." + colors.reset);
    try {
        const response = await axios.get(`${DATA_API_URL}/positions`, { 
            params: { user: SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE } 
        });
        
        const activePos = response.data.filter(p => parseFloat(p.size) > 0);
        
        for (const p of activePos) {
            let market = marketCache.get(p.asset);
            if (!market) {
                // If it's not in our filtered cache, we try to fetch it specifically
                market = await fetchMarketByTokenId(p.asset);
            }
            
            if (market) {
                initialSynthMarkets.add(market.conditionId);
                initialSynthMarkets.add(p.asset); 
            }
        }
        
        console.log(colors.yellow + `[Blacklist] Found ${initialSynthMarkets.size} existing items. We will IGNORE these.` + colors.reset);
    } catch (e) {
        console.error(`[Blacklist Error] Could not fetch Synth positions: ${e.message}`);
    }
}

async function fetchMarketByTokenId(tokenId) {
    try {
        const resp = await axios.get(`${GAMMA_API_URL}/markets`, {
            params: { clob_token_ids: tokenId }
        });
        
        if (resp.data && resp.data.length > 0) {
            const m = resp.data[0];
            // We force cache this even if it's not "crypto" just so the blacklist works
            const tokenIds = JSON.parse(m.clobTokenIds || '[]');
            const outcomes = JSON.parse(m.outcomes || '[]');
            tokenIds.forEach((tid, index) => {
                marketCache.set(tid.toString(), {
                    conditionId: m.conditionId,
                    marketTitle: m.question,
                    outcomeLabel: outcomes[index],
                    myTokenId: tid.toString(),
                    oppositeTokenId: tokenIds[index === 0 ? 1 : 0].toString(), 
                    tickSize: m.orderPriceMinTickSize || "0.01",
                    negRisk: m.negRisk
                });
            });
            return marketCache.get(tokenId);
        }
    } catch (e) {
        console.error(`[JIT Error] Could not fetch market for token ${tokenId}`);
    }
    return null;
}

// --- DATA FETCHING ---
async function getCollateral(address) {
  try {
    const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
    const rawBalance = await usdcContract.balanceOf(address);
    return parseFloat(ethers.utils.formatUnits(rawBalance, 6));
  } catch (error) { return 0; }
}

async function refreshTotals() {
  try {
      userCollateral = await getCollateral(POLYMARKET_PROXY_ADDRESS_LOWER_CASE);
      
      const response = await axios.get(`${DATA_API_URL}/value`, { params: { user: POLYMARKET_PROXY_ADDRESS_LOWER_CASE } });
      userPositionsValue = parseFloat(response.data[0]?.value || 0);

      console.log(`${colors.cyan}User Balance: $${userCollateral.toFixed(2)} | Positions: $${userPositionsValue.toFixed(2)}${colors.reset}`);
  } catch(e) { console.error("Error refreshing totals:", e.message); }
}

// --- HOT PATH: EVENT PROCESSING ---
async function handleTradeLog(log) {
  const logAddress = log.address.toLowerCase();
  if (logAddress !== LEGACY_EXCHANGE && logAddress !== NEG_RISK_EXCHANGE) return;

  if (log.topics[0] !== ORDER_FILLED_TOPIC) return;

  // Manual fast decoding to avoid interface overhead if possible, but keeping it safe for now
  const iface = new ethers.utils.Interface([`event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)`]);
  const decoded = iface.parseLog(log);

  const maker = decoded.args.maker.toLowerCase();
  const taker = decoded.args.taker.toLowerCase();
  
  if (maker !== SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE && taker !== SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE) return;
  
  console.log(colors.blue + `[${log.exchangeTag || 'UNKNOWN'}] Trace found: ${log.transactionHash}` + colors.reset);
  
  const txHash = log.transactionHash;
  if (!pendingTxs.has(txHash)) {
    pendingTxs.set(txHash, { 
        fills: [], 
        timeout: setTimeout(() => processTxGroup(txHash), 1000) 
    });
  }
  const group = pendingTxs.get(txHash);
  group.fills.push(decoded.args);
}

async function processTxGroup(txHash) {
  const group = pendingTxs.get(txHash);
  if (!group) return;
  pendingTxs.delete(txHash);
  clearTimeout(group.timeout);

  let netFlows = new Map(); 

  for (const fill of group.fills) {
    const maker = fill.maker.toLowerCase();
    const isSynthMaker = maker === SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE;
    const makerAsset = fill.makerAssetId.toString();
    const takerAsset = fill.takerAssetId.toString();

    let tradedTokenId, isBuy, amountShares, pricePaid;

    if (makerAsset === "0") {
        tradedTokenId = takerAsset;
        isBuy = isSynthMaker; 
        amountShares = parseFloat(ethers.utils.formatUnits(fill.takerAmountFilled, 6));
        pricePaid = parseFloat(ethers.utils.formatUnits(fill.makerAmountFilled, 6)) / amountShares;
    } else {
        tradedTokenId = makerAsset;
        isBuy = !isSynthMaker;
        amountShares = parseFloat(ethers.utils.formatUnits(fill.makerAmountFilled, 6));
        pricePaid = parseFloat(ethers.utils.formatUnits(fill.takerAmountFilled, 6)) / amountShares;
    }

    let market = marketCache.get(tradedTokenId);
    if (!market) {
        console.log(colors.yellow + `[Cache Miss] JIT Fetching for token: ${tradedTokenId}...` + colors.reset);
        market = await fetchMarketByTokenId(tradedTokenId);
        if (!market) continue;
    }

    if (initialSynthMarkets.has(market.conditionId) || initialSynthMarkets.has(tradedTokenId)) {
        console.log(colors.gray + `[Skip] Market ${market.marketTitle.substring(0,30)}... is in pre-existing blacklist.` + colors.reset);
        continue; 
    }

    const key = market.conditionId + "_" + market.outcomeLabel;
    if (!netFlows.has(key)) netFlows.set(key, { qty: 0, market: market, totalVol: 0 });
    const flow = netFlows.get(key);
    
    if (isBuy) {
        flow.qty += amountShares;
        flow.totalVol += (amountShares * pricePaid);
    } else {
        flow.qty -= amountShares;
        flow.totalVol += (amountShares * pricePaid);
    }
  }

  for (const [key, flow] of netFlows) {
      const absQty = Math.abs(flow.qty);
      if (absQty < 1) continue; 
      
      const synthAvgPrice = flow.totalVol / absQty; 
      const synthCollateral = 20000; 
      const myScale = userCollateral > 0 ? (userCollateral / synthCollateral) : (500 / synthCollateral); 
      let mySize = absQty * myScale;

      const estimatedCost = mySize * synthAvgPrice;

      if (estimatedCost < 1) {
          if (estimatedCost > 0.50) {
              mySize = 1.05 / synthAvgPrice; 
              mySize = Math.ceil(mySize * 10) / 10;
          } else {
              console.log(colors.gray + `[Skip] Trade value $${estimatedCost.toFixed(2)} is below $1 min.` + colors.reset);
              continue;
          }
      }

      const isSynthLong = flow.qty > 0;
      let targetTokenId, limitPrice;

      if (isSynthLong) {
          targetTokenId = flow.market.myTokenId;
          limitPrice = synthAvgPrice + SLIPPAGE_BUFFER;
          console.log(colors.green + `[COPY BUY] Synth Bought ${flow.market.outcomeLabel} @ ${synthAvgPrice.toFixed(2)}` + colors.reset);
      } else {
          targetTokenId = flow.market.oppositeTokenId;
          const inversePrice = 1 - synthAvgPrice; 
          limitPrice = inversePrice + SLIPPAGE_BUFFER;
          console.log(colors.red + `[COPY SHORT] Synth Sold ${flow.market.outcomeLabel}. Switching to OPPOSITE.` + colors.reset);
      }

      await placeOrder(targetTokenId, limitPrice, mySize, flow.market);
  }
  refreshTotals();
}

async function placeOrder(tokenId, price, size, marketInfo) {
    price = Math.min(Math.max(price, 0.02), 0.98);
    size = Math.floor(size * 10) / 10; 

    try {
        const orderParams = {
            tokenID: tokenId,
            price: price,
            side: Side.BUY, 
            size: size,
            feeRateBps: 0,
        };

        console.log(colors.magenta + `>>> PLACING ORDER: Buy ${size} of ${tokenId} @ $${price.toFixed(2)}` + colors.reset);

        const order = await clobClient.createAndPostOrder(orderParams, { 
            tickSize: marketInfo.tickSize, 
            negRisk: marketInfo.negRisk 
        });
        
        console.log(colors.green + `[SUCCESS] Order ID: ${order.orderID}` + colors.reset);
    } catch (e) {
        console.error(colors.red + `[ORDER FAILED] ${e.message}` + colors.reset);
    }
}

async function checkAndRedeem() {
    console.log(colors.gray + `[Redeem] Checking for resolved positions...` + colors.reset);
    let allPositions = [];
    try {
        const response = await axios.get(`${DATA_API_URL}/positions`, { params: { user: POLYMARKET_PROXY_ADDRESS_LOWER_CASE } });
        allPositions = response.data.filter(p => parseFloat(p.size) > 0);
    } catch (e) { return; }

    const proxyContract = new ethers.Contract(POLYMARKET_PROXY_ADDRESS_LOWER_CASE, PROXY_ABI, signer);
    const ctfInterface = new ethers.utils.Interface(CTF_ABI);

    for (const pos of allPositions) {
        try {
             // We can rely on JIT here or cache. Using JIT to be safe since redeem is rare.
             const m = await axios.get(`${GAMMA_API_URL}/markets`, { params: { clob_token_ids: pos.asset } });
             if(m.data.length === 0) continue;
             const market = m.data[0];

             if (!market.closed || !market.outcomePrices) continue;
             const prices = JSON.parse(market.outcomePrices);
             if(!prices.includes("1") && !prices.includes(1)) continue;

             console.log(colors.green + `[Redeem] Redeeming resolved market: ${market.question}` + colors.reset);
             
             const outcomes = JSON.parse(market.outcomes);
             const index = outcomes.indexOf(pos.outcome);
             const indexSet = 1 << index;

             const innerData = ctfInterface.encodeFunctionData("redeemPositions", [
                 USDC_ADDRESS, ethers.constants.HashZero, market.conditionId, [indexSet]
             ]);
             
             const signature = ethers.utils.solidityPack(["uint256", "uint256", "uint8"], [signer.address, 0, 1]);

             const tx = await proxyContract.execTransaction(
                 CTF_ADDRESS, 0, innerData, 0, 0, 0, 0,
                 ethers.constants.AddressZero, ethers.constants.AddressZero, signature,
                 { gasLimit: 500000, maxPriorityFeePerGas: ethers.utils.parseUnits('35', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('300', 'gwei') }
             );
             await tx.wait();
             console.log(colors.cyan + `[Redeem] Success. Capital recycled.` + colors.reset);
        } catch(e) { console.error(`Redeem Error: ${e.message}`); }
    }
}

async function startTracker() {
  initLogging();
  console.log(colors.green + "Initializing Synth Tracker (Crypto-Only Mode)..." + colors.reset);

  // [CHANGE 4] WebSocket Reconnection Logic
  function connectWs() {
    provider = new ethers.providers.WebSocketProvider(POLYGON_WS_URL);
    
    provider._websocket.on('open', async () => {
        console.log(colors.green + "[WS] Connected to Public Node." + colors.reset);
        
        // RE-ATTACH LISTENERS ON RECONNECT
        const legacyFilter = { address: LEGACY_EXCHANGE, topics: [ORDER_FILLED_TOPIC] };
        provider.on(legacyFilter, (log) => { log.exchangeTag = "LEGACY"; handleTradeLog(log); });
        
        const negRiskFilter = { address: NEG_RISK_EXCHANGE, topics: [ORDER_FILLED_TOPIC] };
        provider.on(negRiskFilter, (log) => { log.exchangeTag = "NEGRISK"; handleTradeLog(log); });
    });

    provider._websocket.on('close', () => {
        console.log(colors.red + "[WS] Disconnected. Reconnecting in 3s..." + colors.reset);
        setTimeout(connectWs, 3000);
    });

    provider._websocket.on('error', (err) => {
        console.error("WS Error:", err.message);
    });
  }

  // Initial Connect
  connectWs();

  signer = new ethers.Wallet(PHANTOM_POLYGON_WALLET_PRIVATE_KEY, provider);
  clobClient = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      signer,
      { key: API_KEY, secret: API_SECRET, passphrase: API_PASSPHRASE },
      SIGNATURE_TYPE,
      POLYMARKET_PROXY_ADDRESS_LOWER_CASE
  );

  console.log("\nWarming up targeted cache (Bitcoin/Ethereum only)...");
  await updateMarketCache();
  
  await fetchSynthPositions(); 
  
  // Heartbeat logging
  setInterval(() => {
     process.stdout.write(colors.gray + "." + colors.reset);
  }, 5000);

  setInterval(updateMarketCache, POLL_INTERVAL_MS);
  await refreshTotals();
  setInterval(checkAndRedeem, REDEEM_INTERVAL_MS);
  
  console.log(colors.green + "Bot Running." + colors.reset);
}

startTracker();