const { ethers } = require('ethers');
const axios = require('axios');
const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

// ANSI colors
const colors = {
    reset: '\x1b[0m',
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

// RPC & API
const POLYGON_WS_URL = 'wss://polygon-bor-rpc.publicnode.com';
const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const DATA_API_URL = 'https://data-api.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

const PHANTOM_POLYGON_WALLET_PRIVATE_KEY = process.env.PHANTOM_POLYGON_WALLET_PRIVATE_KEY;
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const API_PASSPHRASE = process.env.API_PASSPHRASE;

const SIGNATURE_TYPE = 2; // Proxy

const LEGACY_EXCHANGE = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e'.toLowerCase();
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'.toLowerCase();

// STRATEGY SETTINGS
const ACCUMULATOR_THRESHOLD_USD = 1.50;
const POLL_INTERVAL_MS = 30000;
const REDEEM_INTERVAL_MS = 60000;
const RECONCILE_INTERVAL_MS = 5000;

// [STRATEGY UPDATE] "The Capped Chase"
// We will pay up to 5% more than Synth paid. 
// If market is higher than that, we bid at the cap and wait for a dip.
const MAX_CHASE_PREMIUM = 0.05;
const AGGRESSIVE_SLIPPAGE = 0.05; // If within range, add 5% buffer to ensure fill

const ORDER_FILLED_TOPIC = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'));

// ABIs
const USDC_ABI = [{ "inputs": [{ "name": "account", "type": "address" }], "name": "balanceOf", "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "name": "spender", "type": "address" }, { "name": "amount", "type": "uint256" }], "name": "approve", "outputs": [{ "name": "", "type": "bool" }], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "name": "owner", "type": "address" }, { "name": "spender", "type": "address" }], "name": "allowance", "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }];
const CTF_ABI = [{ "inputs": [{ "name": "account", "type": "address" }, { "name": "id", "type": "uint256" }], "name": "balanceOf", "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "name": "collateralToken", "type": "address" }, { "name": "parentCollectionId", "type": "bytes32" }, { "name": "conditionId", "type": "bytes32" }, { "name": "partition", "type": "uint256[]" }, { "name": "amount", "type": "uint256" }], "name": "splitPosition", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "name": "collateralToken", "type": "address" }, { "name": "parentCollectionId", "type": "bytes32" }, { "name": "conditionId", "type": "bytes32" }, { "name": "indexSets", "type": "uint256[]" }], "name": "redeemPositions", "outputs": [], "stateMutability": "nonpayable", "type": "function" }];
const PROXY_ABI = [{ "inputs": [{ "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "value", "type": "uint256" }, { "internalType": "bytes", "name": "data", "type": "bytes" }, { "internalType": "enum Enum.Operation", "name": "operation", "type": "uint8" }, { "internalType": "uint256", "name": "safeTxGas", "type": "uint256" }, { "internalType": "uint256", "name": "baseGas", "type": "uint256" }, { "internalType": "uint256", "name": "gasPrice", "type": "uint256" }, { "internalType": "address", "name": "gasToken", "type": "address" }, { "internalType": "address payable", "name": "refundReceiver", "type": "address" }, { "internalType": "bytes", "name": "signatures", "type": "bytes" }], "name": "execTransaction", "outputs": [{ "internalType": "bool", "name": "success", "type": "bool" }], "stateMutability": "payable", "type": "function" }];

// --- GLOBAL STATE ---
let provider, signer, clobClient;
let logStream;

let userCollateral = 0;
let userPositionsValue = 0;
let userTotalEquity = 500;
let synthTotalEquity = 20000;

let marketCache = new Map();
let activeConditions = new Set();
let initialSynthMarkets = new Set();
let pendingOrders = new Set();
let myOnChainPositions = new Map();

// --- PRICE FEED ---
const priceStore = new Map();

function initPriceFeed() {
    const ws = new WebSocket(CLOB_WS_URL);

    ws.on('open', () => {
        console.log(colors.cyan + "[PriceFeed] Connected to CLOB Market Stream." + colors.reset);
        const assets = Array.from(marketCache.keys());
        if (assets.length > 0) {
            ws.send(JSON.stringify({ type: "market", assets_ids: assets }));
        }
    });

    ws.on('message', (data) => {
        try {
            const parsed = JSON.parse(data);
            const events = Array.isArray(parsed) ? parsed : [parsed];
            for (const msg of events) {
                if (msg.event_type === "price_change" || msg.event_type === "trade") {
                    const price = parseFloat(msg.price);
                    const assetId = msg.asset_id;
                    if (assetId && !isNaN(price)) {
                        priceStore.set(assetId, price);
                    }
                    // Handle nested changes array
                    if (msg.changes && Array.isArray(msg.changes)) {
                        msg.changes.forEach(c => {
                            if (c.price) priceStore.set(c.asset_id, parseFloat(c.price));
                        });
                    }
                }
            }
        } catch (e) { }
    });

    ws.on('error', (err) => console.log(`[PriceFeed Error] ${err.message}`));
    ws.on('close', () => { setTimeout(initPriceFeed, 5000); });
    setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" })); }, 30000);
    return ws;
}
let marketDataWs = initPriceFeed();

// --- SHADOW LEDGER (Updated for Cost Basis) ---
class ShadowLedger {
    constructor() {
        this.synthPositions = new Map(); // TokenID -> { netShares, totalCost, avgPrice, market }
    }

    update(tokenId, sharesDelta, pricePaid, marketInfo) {
        if (!this.synthPositions.has(tokenId)) {
            this.synthPositions.set(tokenId, { netShares: 0, totalCost: 0, avgPrice: 0, market: marketInfo });
            if (marketDataWs && marketDataWs.readyState === WebSocket.OPEN) {
                marketDataWs.send(JSON.stringify({ type: "market", assets_ids: [tokenId] }));
            }
        }

        const pos = this.synthPositions.get(tokenId);

        // Update Weighted Average Cost Basis
        if (sharesDelta > 0) {
            // Buying: Cost goes up, Average might change
            pos.totalCost += (sharesDelta * pricePaid);
            pos.netShares += sharesDelta;
        } else {
            // Selling: Reduce shares, maintain average price (LIFO/FIFO doesn't matter for avg)
            pos.netShares += sharesDelta;
            // Reduce cost proportionally
            if (pos.netShares > 0) {
                pos.totalCost = pos.netShares * pos.avgPrice;
            } else {
                pos.totalCost = 0;
            }
        }

        // Recalculate Average
        if (pos.netShares > 0.1) {
            pos.avgPrice = pos.totalCost / pos.netShares;
        } else {
            pos.avgPrice = 0; // Reset
        }

        if (Math.abs(pos.netShares) < 0.1) pos.netShares = 0;

        evaluateAccumulator(tokenId);
    }
}
const shadowLedger = new ShadowLedger();

// --- LOGGING ---
function logJson(type, data) {
    if (!logStream) return;
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), type, ...data });
    logStream.write(entry + '\n');
}

function initLogging() {
    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    logStream = fs.createWriteStream(path.join(logsDir, `flight_recorder_${now}.jsonl`), { flags: 'a' });
}

// --- HELPER FUNCTIONS ---
function parseAndCacheMarket(m) {
    if (!m || activeConditions.has(m.conditionId)) return null;
    let tokenIds = [];
    try {
        if (Array.isArray(m.clobTokenIds)) tokenIds = m.clobTokenIds;
        else if (typeof m.clobTokenIds === 'string') tokenIds = JSON.parse(m.clobTokenIds);
    } catch (e) { return null; }

    const outcomes = JSON.parse(m.outcomes || '[]');

    tokenIds.forEach((tid, index) => {
        marketCache.set(tid.toString(), {
            conditionId: m.conditionId,
            marketTitle: m.question,
            outcomeLabel: outcomes[index],
            myTokenId: tid.toString(),
            tickSize: m.orderPriceMinTickSize || "0.01",
            negRisk: m.negRisk
        });
    });
    activeConditions.add(m.conditionId);
    return m;
}

// --- CORE LOGIC: THE ACCUMULATOR ---
async function evaluateAccumulator(tokenId) {
    if (pendingOrders.has(tokenId)) return;

    const synthPos = shadowLedger.synthPositions.get(tokenId);
    if (!synthPos) return;

    const equityRatio = userTotalEquity / synthTotalEquity;
    const targetShares = synthPos.netShares * equityRatio;
    const myCurrentShares = myOnChainPositions.get(tokenId) || 0;
    const shareDelta = targetShares - myCurrentShares;

    const currentPrice = priceStore.get(tokenId) || 0.50;
    const driftValueUsd = Math.abs(shareDelta) * currentPrice;

    logJson('ACCUMULATOR', {
        market: synthPos.market.outcomeLabel,
        synthAvgEntry: synthPos.avgPrice,
        myTarget: targetShares,
        driftUsd: driftValueUsd,
        currentPrice: currentPrice
    });

    if (driftValueUsd > ACCUMULATOR_THRESHOLD_USD) {
        console.log(colors.magenta + `[ACCUMULATOR] ${synthPos.market.outcomeLabel}: Drift $${driftValueUsd.toFixed(2)} > Trigger. SynthAvg: $${synthPos.avgPrice.toFixed(2)} | Mkt: $${currentPrice.toFixed(2)}` + colors.reset);

        // Pass Synth's Average Price to execution logic
        executeTrade(tokenId, shareDelta, currentPrice, synthPos.market, synthPos.avgPrice);
    }
}

async function executeTrade(tokenId, shareDelta, marketPrice, market, synthAvgPrice) {
    pendingOrders.add(tokenId);

    try {
        const side = shareDelta > 0 ? Side.BUY : Side.SELL;
        let size = Math.abs(shareDelta);

        // Budget Check (using local marketPrice from WS)
        if (side === Side.BUY) {
            // Assume we might pay up to 5% more
            const estimatedPrice = marketPrice * 1.05;
            const cost = size * estimatedPrice;
            if (cost > userCollateral) {
                console.log(colors.yellow + `[BUDGET] Cost ~$${cost.toFixed(2)} > Cash $${userCollateral.toFixed(2)}. Scaling down.` + colors.reset);
                size = (userCollateral * 0.98) / estimatedPrice;
            }
        } else {
            const owned = myOnChainPositions.get(tokenId) || 0;
            if (size > owned) size = owned;
        }

        size = Math.floor(size);
        if (size < 1) return;

        // --- SMART PRICING LOGIC (No REST Call) ---
        let limitPrice;

        if (side === Side.BUY) {
            // 1. Calculate the absolute maximum we are willing to pay (The Cap)
            //    Example: Synth paid $0.45. We pay max $0.47.
            const maxWillingToPay = synthAvgPrice * (1 + MAX_CHASE_PREMIUM);
            const cap = synthAvgPrice > 0 ? maxWillingToPay : 1.0;

            // 2. Calculate an "Aggressive" bid based on the last known price
            //    This ensures we cross the spread if the price is close
            const aggressiveBid = marketPrice * (1 + AGGRESSIVE_SLIPPAGE);

            // 3. The Bid is the LOWER of the two.
            //    We bid aggressively to catch the move, but NEVER exceed our Cap.
            limitPrice = Math.min(aggressiveBid, cap);

            // Sanity floor
            if (limitPrice < 0.01) limitPrice = 0.01;
            // Ceiling
            if (limitPrice > 0.99) limitPrice = 0.99;

        } else {
            // SELLING: Just get out.
            limitPrice = marketPrice * (1 - AGGRESSIVE_SLIPPAGE);
            if (limitPrice < 0.01) limitPrice = 0.01;
        }

        console.log(colors.yellow + `>>> EXECUTING: ${side === Side.BUY ? "BUY" : "SELL"} ${size} @ Limit $${limitPrice.toFixed(2)}` + colors.reset);

        const order = await clobClient.createAndPostOrder({
            tokenID: tokenId,
            price: limitPrice,
            side: side,
            size: size,
            feeRateBps: 0,
            expiration: 0 // FAK
        }, { tickSize: market.tickSize, negRisk: market.negRisk }, OrderType.FAK);

        if (order && (order.orderID || order.orderIds)) {
            const id = order.orderID || order.orderIds[0];
            console.log(colors.green + `[SUCCESS] Order Filled. ID: ${id}` + colors.reset);

            // Optimistic Update
            if (side === Side.BUY) {
                userCollateral -= (size * limitPrice);
                myOnChainPositions.set(tokenId, (myOnChainPositions.get(tokenId) || 0) + size);
            } else {
                userCollateral += (size * limitPrice);
                myOnChainPositions.set(tokenId, (myOnChainPositions.get(tokenId) || 0) - size);
            }
        } else {
            console.log(colors.gray + `[MISSED] FAK killed. (Price mismatch).` + colors.reset);
        }

    } catch (e) {
        // [FAST FAILURE HANDLING]
        // We removed the slow checks, so we expect 400 errors when the market is too high.
        // This is GOOD. It means the engine protected us from overpaying.
        if (e.message && e.message.includes("400")) {
            console.log(colors.cyan + `[PROTECTED] Market Price > Cap. Order rejected by engine. Waiting for dip...` + colors.reset);
        } else {
            console.error(colors.red + `[EXEC ERROR] ${e.message}` + colors.reset);
        }
    } finally {
        pendingOrders.delete(tokenId);
    }
}

// --- DATA FETCHING ---
async function scanUpcomingMarkets() {
    try {
        const queries = ['Bitcoin Up or Down', 'Ethereum Up or Down'];
        const requests = queries.map(q =>
            axios.get(`${GAMMA_API_URL}/markets`, {
                params: { q: q, closed: false, active: true, limit: 50 }
            })
        );
        const responses = await Promise.all(requests);
        for (const resp of responses) {
            if (resp.data && Array.isArray(resp.data)) {
                for (const m of resp.data) {
                    const parsed = parseAndCacheMarket(m);
                    if (parsed && marketDataWs && marketDataWs.readyState === WebSocket.OPEN) {
                        let tokenIds = [];
                        try {
                            if (Array.isArray(m.clobTokenIds)) tokenIds = m.clobTokenIds;
                            else if (typeof m.clobTokenIds === 'string') tokenIds = JSON.parse(m.clobTokenIds);
                        } catch (e) { }

                        if (tokenIds.length > 0) {
                            marketDataWs.send(JSON.stringify({ type: "market", assets_ids: tokenIds }));
                        }
                    }
                }
            }
        }
    } catch (e) { console.error("[Scanner Error] " + e.message); }
}

async function fetchMarketByTokenId(tokenId) {
    if (!tokenId || tokenId === "0") return null;
    try {
        const resp = await axios.get(`${GAMMA_API_URL}/markets`, { params: { clob_token_ids: tokenId } });
        if (resp.data && resp.data.length > 0) {
            return parseAndCacheMarket(resp.data[0]) ? marketCache.get(tokenId) : null;
        }
    } catch (e) { }
    return null;
}

async function fetchSynthPositions() {
    console.log(colors.yellow + "Checking Synth's blacklisted/historical positions..." + colors.reset);
    try {
        const response = await axios.get(`${DATA_API_URL}/positions`, { params: { user: SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE } });
        const activePos = response.data.filter(p => parseFloat(p.size) > 0);
        for (const p of activePos) {
            initialSynthMarkets.add(p.asset);
        }
    } catch (e) { }
}

async function fetchMyPositions() {
    try {
        const response = await axios.get(`${DATA_API_URL}/positions`, { params: { user: POLYMARKET_PROXY_ADDRESS_LOWER_CASE } });
        myOnChainPositions.clear();
        response.data.filter(p => parseFloat(p.size) > 0).forEach(p => {
            myOnChainPositions.set(p.asset, parseFloat(p.size));
        });
    } catch (e) { }
}

async function refreshTotals() {
    try {
        const [uCash, uVal, sCash, sVal] = await Promise.all([
            getCollateral(POLYMARKET_PROXY_ADDRESS_LOWER_CASE),
            axios.get(`${DATA_API_URL}/value`, { params: { user: POLYMARKET_PROXY_ADDRESS_LOWER_CASE } }),
            getCollateral(SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE),
            axios.get(`${DATA_API_URL}/value`, { params: { user: SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE } })
        ]);

        userCollateral = uCash;
        userPositionsValue = parseFloat(uVal.data[0]?.value || 0);
        userTotalEquity = userCollateral + userPositionsValue;

        const synthVal = parseFloat(sVal.data[0]?.value || 0);
        const synthTot = sCash + synthVal;

        if (synthTot > 5000) synthTotalEquity = synthTot;

        console.log(colors.cyan + `[Equity Sync] Me: $${userTotalEquity.toFixed(2)} | Synth: $${synthTotalEquity.toFixed(2)} | Ratio: ${((userTotalEquity / synthTotalEquity) * 100).toFixed(3)}%` + colors.reset);
    } catch (e) { }
}

async function getCollateral(address) {
    try {
        const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
        const rawBalance = await usdcContract.balanceOf(address);
        return parseFloat(ethers.utils.formatUnits(rawBalance, 6));
    } catch (error) { return 0; }
}

async function handleTradeLog(log) {
    const logAddress = log.address.toLowerCase();
    if (logAddress !== LEGACY_EXCHANGE && logAddress !== NEG_RISK_EXCHANGE) return;
    if (log.topics[0] !== ORDER_FILLED_TOPIC) return;

    const iface = new ethers.utils.Interface([`event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)`]);
    let decoded;
    try { decoded = iface.parseLog(log); } catch (e) { return; }

    const maker = decoded.args.maker.toLowerCase();
    const taker = decoded.args.taker.toLowerCase();
    if (maker !== SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE && taker !== SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE) return;

    const makerAsset = decoded.args.makerAssetId.toString();
    const takerAsset = decoded.args.takerAssetId.toString();
    let marketInfo = marketCache.get(makerAsset) || marketCache.get(takerAsset);
    if (!marketInfo) {
        if (makerAsset !== "0") marketInfo = await fetchMarketByTokenId(makerAsset);
        if (!marketInfo && takerAsset !== "0") marketInfo = await fetchMarketByTokenId(takerAsset);
    }
    if (!marketInfo) return;

    if (initialSynthMarkets.has(marketInfo.conditionId) || initialSynthMarkets.has(makerAsset) || initialSynthMarkets.has(takerAsset)) return;

    let riskTokenId;
    if (marketCache.has(makerAsset)) riskTokenId = makerAsset;
    else if (marketCache.has(takerAsset)) riskTokenId = takerAsset;
    if (!riskTokenId) return;

    let synthBought = false;
    let shareAmount = 0;
    let usdcAmount = 0;

    if (maker === SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE) {
        if (makerAsset === riskTokenId) {
            synthBought = false; // Sold
            shareAmount = parseFloat(ethers.utils.formatUnits(decoded.args.makerAmountFilled, 6));
            usdcAmount = parseFloat(ethers.utils.formatUnits(decoded.args.takerAmountFilled, 6));
        } else {
            synthBought = true; // Bought
            shareAmount = parseFloat(ethers.utils.formatUnits(decoded.args.takerAmountFilled, 6));
            usdcAmount = parseFloat(ethers.utils.formatUnits(decoded.args.makerAmountFilled, 6));
        }
    } else {
        if (takerAsset === riskTokenId) {
            synthBought = false; // Sold
            shareAmount = parseFloat(ethers.utils.formatUnits(decoded.args.takerAmountFilled, 6));
            usdcAmount = parseFloat(ethers.utils.formatUnits(decoded.args.makerAmountFilled, 6));
        } else {
            synthBought = true; // Bought
            shareAmount = parseFloat(ethers.utils.formatUnits(decoded.args.makerAmountFilled, 6));
            usdcAmount = parseFloat(ethers.utils.formatUnits(decoded.args.takerAmountFilled, 6));
        }
    }

    if (shareAmount < 0.1) return;
    const pricePaid = usdcAmount / shareAmount;

    console.log(colors.blue + `[SIGNAL] Synth ${synthBought ? "BUY" : "SELL"} ${shareAmount.toFixed(1)} "${marketInfo.outcomeLabel}" @ $${pricePaid.toFixed(2)}` + colors.reset);
    priceStore.set(riskTokenId, pricePaid);

    const signedDelta = synthBought ? shareAmount : -shareAmount;
    shadowLedger.update(riskTokenId, signedDelta, pricePaid, marketInfo);
}

async function checkAndRedeem() {
    if (!signer) {
        console.log(colors.yellow + "[Redeem] Signer not ready yet. Skipping." + colors.reset);
        return;
    }

    let allPositions = [];
    try {
        const response = await axios.get(`${DATA_API_URL}/positions`, { params: { user: POLYMARKET_PROXY_ADDRESS_LOWER_CASE } });
        allPositions = response.data.filter(p => parseFloat(p.size) > 0);
    } catch (e) { return; }

    if (allPositions.length === 0) return;

    const proxyContract = new ethers.Contract(POLYMARKET_PROXY_ADDRESS_LOWER_CASE, PROXY_ABI, signer);
    const ctfInterface = new ethers.utils.Interface(CTF_ABI);

    for (const pos of allPositions) {
        try {
            const m = await axios.get(`${GAMMA_API_URL}/markets`, { params: { clob_token_ids: pos.asset } });
            if (m.data.length === 0) continue;
            const market = m.data[0];

            if (!market.closed || !market.outcomePrices) continue;
            const prices = JSON.parse(market.outcomePrices);
            if (!prices.includes("1") && !prices.includes(1)) continue;

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
        } catch (e) { }
    }
}

async function reconcileLoop() {
    for (const tokenId of shadowLedger.synthPositions.keys()) {
        evaluateAccumulator(tokenId);
    }
}

async function startTracker() {
    initLogging();
    console.log(colors.green + "Initializing Synth Tracker (Engine v2.0)..." + colors.reset);
    function connectWs() {
        if (provider) { try { provider._websocket.terminate(); } catch (e) { } }
        provider = new ethers.providers.WebSocketProvider(POLYGON_WS_URL);
        provider._websocket.on('open', async () => {
            console.log(colors.green + "[Blockchain WS] Connected." + colors.reset);
            signer = new ethers.Wallet(PHANTOM_POLYGON_WALLET_PRIVATE_KEY, provider);
            clobClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, { key: API_KEY, secret: API_SECRET, passphrase: API_PASSPHRASE }, SIGNATURE_TYPE, POLYMARKET_PROXY_ADDRESS_LOWER_CASE);
            provider.on({ address: LEGACY_EXCHANGE, topics: [ORDER_FILLED_TOPIC] }, handleTradeLog);
            provider.on({ address: NEG_RISK_EXCHANGE, topics: [ORDER_FILLED_TOPIC] }, handleTradeLog);
        });
        provider._websocket.on('close', () => { setTimeout(connectWs, 3000); });
    }
    connectWs();
    await scanUpcomingMarkets();
    await fetchSynthPositions();
    await fetchMyPositions();
    await refreshTotals();
    await checkAndRedeem();
    setInterval(reconcileLoop, RECONCILE_INTERVAL_MS);
    setInterval(checkAndRedeem, REDEEM_INTERVAL_MS);
    setInterval(scanUpcomingMarkets, POLL_INTERVAL_MS);
    setInterval(refreshTotals, 60000);
    setInterval(fetchMyPositions, 15000);
}

process.on('uncaughtException', (err) => {
    console.error(colors.red + `[CRITICAL] ${err.message}` + colors.reset);
});
startTracker();