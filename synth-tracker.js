const { ethers } = require('ethers');
const axios = require('axios');
const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');
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
const DATA_API_URL = 'https://data-api.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const PHANTOM_POLYGON_WALLET_PRIVATE_KEY = process.env.PHANTOM_POLYGON_WALLET_PRIVATE_KEY;
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const API_PASSPHRASE = process.env.API_PASSPHRASE;

// [CONFIRMED] Type 2 is correct for Owner (EOA) -> Proxy execution
const SIGNATURE_TYPE = 2;

const LEGACY_EXCHANGE = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e'.toLowerCase();
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'.toLowerCase();

const EXECUTION_THRESHOLD = 5;
const MIN_TRADE_DOLLAR_VALUE = 1.10;
const POLL_INTERVAL_MS = 30000;
const REDEEM_INTERVAL_MS = 60000;
const RECONCILE_INTERVAL_MS = 10000;

const ORDER_FILLED_TOPIC = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'));

// ABIs
const USDC_ABI = [
    { "inputs": [{ "name": "account", "type": "address" }], "name": "balanceOf", "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "name": "spender", "type": "address" }, { "name": "amount", "type": "uint256" }], "name": "approve", "outputs": [{ "name": "", "type": "bool" }], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "name": "owner", "type": "address" }, { "name": "spender", "type": "address" }], "name": "allowance", "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
];
const CTF_ABI = [
    { "inputs": [{ "name": "account", "type": "address" }, { "name": "id", "type": "uint256" }], "name": "balanceOf", "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "name": "collateralToken", "type": "address" }, { "name": "parentCollectionId", "type": "bytes32" }, { "name": "conditionId", "type": "bytes32" }, { "name": "partition", "type": "uint256[]" }, { "name": "amount", "type": "uint256" }], "name": "splitPosition", "outputs": [], "stateMutability": "nonpayable", "type": "function" },
    { "inputs": [{ "name": "collateralToken", "type": "address" }, { "name": "parentCollectionId", "type": "bytes32" }, { "name": "conditionId", "type": "bytes32" }, { "name": "indexSets", "type": "uint256[]" }], "name": "redeemPositions", "outputs": [], "stateMutability": "nonpayable", "type": "function" }
];
const PROXY_ABI = [
    { "inputs": [{ "internalType": "address", "name": "to", "type": "address" }, { "internalType": "uint256", "name": "value", "type": "uint256" }, { "internalType": "bytes", "name": "data", "type": "bytes" }, { "internalType": "enum Enum.Operation", "name": "operation", "type": "uint8" }, { "internalType": "uint256", "name": "safeTxGas", "type": "uint256" }, { "internalType": "uint256", "name": "baseGas", "type": "uint256" }, { "internalType": "uint256", "name": "gasPrice", "type": "uint256" }, { "internalType": "address", "name": "gasToken", "type": "address" }, { "internalType": "address payable", "name": "refundReceiver", "type": "address" }, { "internalType": "bytes", "name": "signatures", "type": "bytes" }], "name": "execTransaction", "outputs": [{ "internalType": "bool", "name": "success", "type": "bool" }], "stateMutability": "payable", "type": "function" }
];

// --- GLOBAL STATE ---
let provider, signer, clobClient;
let userCollateral = 0;
let userPositionsValue = 0;
let userTotalEquity = 0;
let synthTotalEquity = 20000;

let marketCache = new Map();
let activeConditions = new Set();
let initialSynthMarkets = new Set();
let logStream;
let myOnChainPositions = new Map();
let pendingOrders = new Set();

function logJson(type, data) {
    if (!logStream) return;
    const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: type,
        ...data
    });
    logStream.write(entry + '\n');
}

// --- SHADOW PORTFOLIO (FIXED) ---
class ShadowPortfolio {
    constructor() {
        this.positions = new Map();
    }

    update(tokenId, sharesDelta, pricePaid, marketInfo) {
        if (!this.positions.has(tokenId)) {
            this.positions.set(tokenId, { netShares: 0, totalCost: 0, avgEntry: 0, market: marketInfo });
        }

        const pos = this.positions.get(tokenId);
        const prevShares = pos.netShares;
        pos.netShares += sharesDelta;

        const isAdding = (prevShares >= 0 && sharesDelta > 0) || (prevShares <= 0 && sharesDelta < 0);

        if (isAdding) {
            pos.totalCost += (Math.abs(sharesDelta) * pricePaid);
            pos.avgEntry = pos.totalCost / Math.abs(pos.netShares);
        } else {
            if (prevShares !== 0) {
                const reduceRatio = (Math.abs(pos.netShares) / Math.abs(prevShares));
                pos.totalCost = pos.totalCost * reduceRatio;
            }
        }
        // [CHANGE] Pass the LATEST price (pricePaid) to the trigger logic
        this.checkTrigger(tokenId, pricePaid);
    }

    async checkTrigger(tokenId, currentMarketPrice) {
        const shadow = this.positions.get(tokenId);
        if (!shadow) return;

        if (pendingOrders.has(tokenId)) return;

        // Sync memory with reality
        // try {
        //     const ctfContract = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
        //     const rawBalance = await ctfContract.balanceOf(POLYMARKET_PROXY_ADDRESS_LOWER_CASE, tokenId);
        //     const trueBalance = parseFloat(ethers.utils.formatUnits(rawBalance, 6));
        //     myOnChainPositions.set(tokenId, trueBalance);
        // } catch (e) {
        //     return;
        // }

        if (pendingOrders.has(tokenId)) return;

        const effectiveUserEquity = userTotalEquity > 0 ? userTotalEquity : 530;
        const scaleRatio = effectiveUserEquity / synthTotalEquity;
        const targetSize = shadow.netShares * scaleRatio;

        const currentSize = myOnChainPositions.get(tokenId) || 0;
        const diff = targetSize - currentSize;
        const absDiff = Math.abs(diff);

        // Value check
        const estimatedValue = absDiff * currentMarketPrice; // [CHANGE] Use current price for value est

        const decision = (absDiff >= EXECUTION_THRESHOLD && estimatedValue >= MIN_TRADE_DOLLAR_VALUE) ? "TRIGGER" : "ACCUMULATING";

        logJson('BRAIN', {
            market: shadow.market.outcomeLabel,
            tokenId: tokenId,
            synthShares: shadow.netShares,
            myTarget: targetSize,
            myActual: currentSize,
            diff: diff,
            estValue: estimatedValue,
            decision: decision
        });

        if (decision === "ACCUMULATING") {
            return;
        }

        console.log(colors.magenta + `[TRIGGER] ${shadow.market.outcomeLabel}: Diff ${diff.toFixed(2)} ($${estimatedValue.toFixed(2)}) > $${MIN_TRADE_DOLLAR_VALUE}. Executing!` + colors.reset);

        // [CHANGE] Pass currentMarketPrice instead of shadow.avgEntry
        this.execute(tokenId, diff, currentMarketPrice, shadow.market);
    }

    forceSync(tokenId, actualNetShares, marketInfo) {
        if (!this.positions.has(tokenId)) {
            this.positions.set(tokenId, {
                netShares: actualNetShares,
                totalCost: 0, // We lose cost basis tracking on sync, but position accuracy is more important
                avgEntry: 0,
                market: marketInfo
            });
        } else {
            const pos = this.positions.get(tokenId);
            pos.netShares = actualNetShares; // <--- CRITICAL: Overwrite memory with API reality
        }
    }

    async executeAggr(tokenId, sizeToFill, basePrice, market) {
        let attempt = 0;
        const maxRetries = 3; // Don't loop forever
        let currentPrice = basePrice;

        while (attempt < maxRetries) {
            attempt++;

            // Dynamic Slippage: Increase aggression on every fail
            // Attempt 1: 2% buffer
            // Attempt 2: 5% buffer
            // Attempt 3: 10% buffer
            const aggression = [0.02, 0.05, 0.10];
            const buffer = aggression[attempt - 1] || 0.05;

            // Calculate Limit
            let limitPrice = sizeToFill > 0
                ? currentPrice * (1 + buffer)
                : currentPrice * (1 - buffer);

            // Clamp
            limitPrice = Math.min(Math.max(limitPrice, 0.02), 0.99);

            console.log(colors.yellow + `[Attempt ${attempt}] Executing ${sizeToFill} @ limit $${limitPrice.toFixed(3)}` + colors.reset);

            const success = await placeOrder(tokenId, limitPrice, sizeToFill, sizeToFill > 0 ? Side.BUY : Side.SELL, market);

            if (success) {
                return true; // We are done
            }

            // If we failed, it's likely because price moved away. 
            // We need to fetch the NEW price to re-anchor our next bid.
            // Quickest way is to just assume we need to step up our bid.
            // Or, do a quick JIT price check (adds latency but ensures accuracy).
        }
        console.log(colors.red + `[GAVE UP] Failed to fill after ${maxRetries} attempts.` + colors.reset);
    }

    async execute(tokenId, sizeToFill, basePrice, market) {
        pendingOrders.add(tokenId);

        // --- 1. PRE-FLIGHT SAFETY CHECKS (From your old code) ---
        const side = sizeToFill > 0 ? Side.BUY : Side.SELL;
        let finalSize = Math.abs(sizeToFill);

        // Wallet Balance Check
        if (side === Side.BUY) {
            // Use basePrice for estimation (it will be close enough)
            const estimatedCost = finalSize * basePrice;
            if (estimatedCost > userCollateral) {
                console.log(colors.yellow + `[ADJUST] Target cost $${estimatedCost.toFixed(2)} exceeds wallet balance $${userCollateral.toFixed(2)}.` + colors.reset);
                // Calculate max affordable size with a tiny buffer for price moves
                let affordableSize = (userCollateral * 0.95) / basePrice;
                affordableSize = Math.floor(affordableSize * 100) / 100;

                if (affordableSize < 1) {
                    console.log(colors.red + `[SKIP] Funds low (Can afford ${affordableSize}).` + colors.reset);
                    pendingOrders.delete(tokenId);
                    return;
                }
                finalSize = affordableSize;
            }
        }

        // Sell Check (Strict)
        if (side === Side.SELL) {
            const owned = myOnChainPositions.get(tokenId) || 0;
            if (owned < 0.1) {
                console.log(colors.red + `[SKIP SELL] No shares owned.` + colors.reset);
                pendingOrders.delete(tokenId);
                return;
            }
            if (finalSize > owned) {
                finalSize = owned;
            }
        }

        // --- 2. THE CHASER LOOP (From the new code) ---
        let attempt = 0;
        const maxRetries = 3;

        // Define aggression levels (2%, 5%, 10%)
        const aggression = [0.02, 0.05, 0.10];

        while (attempt < maxRetries) {
            attempt++;
            const buffer = aggression[attempt - 1] || 0.10;

            // Calculate Limit Price based on side
            // If BUY: Price + Buffer. If SELL: Price - Buffer.
            let limitPrice = side === Side.BUY
                ? basePrice * (1 + buffer)
                : basePrice * (1 - buffer);

            // Hard Clamp (0.02 to 0.98)
            limitPrice = Math.min(Math.max(limitPrice, 0.02), 0.98);

            console.log(colors.yellow + `[Attempt ${attempt}/${maxRetries}] Executing ${side === Side.BUY ? "BUY" : "SELL"} ${finalSize} @ $${limitPrice.toFixed(3)}` + colors.reset);

            // Execute
            const success = await placeOrder(tokenId, limitPrice, finalSize, side, market);

            if (success) {
                // --- 3. POST-FLIGHT STATE UPDATE ---
                if (side === Side.BUY) {
                    userCollateral -= (finalSize * limitPrice);
                }

                const currentPos = myOnChainPositions.get(tokenId) || 0;
                const newPos = side === Side.BUY ? (currentPos + finalSize) : (currentPos - finalSize);
                myOnChainPositions.set(tokenId, newPos);

                // Break the loop, we are done
                pendingOrders.delete(tokenId);
                return;
            }

            // If we are here, the order failed/killed.
            // Short pause before retrying prevents API spam limits
            await new Promise(r => setTimeout(r, 200));
        }

        console.log(colors.red + `[GAVE UP] Failed to fill after ${maxRetries} attempts.` + colors.reset);
        pendingOrders.delete(tokenId);
    }
}
const shadowPortfolio = new ShadowPortfolio();

function initLogging() {
    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

    // Create a flight recorder file
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(logsDir, `flight_recorder_${now}.jsonl`);

    logStream = fs.createWriteStream(filename, { flags: 'a' });
    console.log(colors.cyan + `[Logger] Recording flight data to ${filename}` + colors.reset);
}

function parseAndCacheMarket(m) {
    if (!m || activeConditions.has(m.conditionId)) return null;

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

async function scanUpcomingMarkets() {
    console.log(colors.cyan + "[Scanner] Pre-fetching upcoming Bitcoin & Ethereum markets..." + colors.reset);
    try {
        // Specific queries to target Synth's markets
        const queries = [
            'Bitcoin Up or Down',
            'Ethereum Up or Down'
        ];

        // Run requests in parallel for speed
        const requests = queries.map(q =>
            axios.get(`${GAMMA_API_URL}/markets`, {
                params: {
                    q: q,           // Text search
                    closed: false,  // Only open markets
                    active: true,   // Active markets (even if start date is in future)
                    limit: 50       // Grab a wide batch to catch 15m, 30m, 1h, 4h
                }
            })
        );

        const responses = await Promise.all(requests);
        let newCount = 0;

        for (const resp of responses) {
            if (resp.data && Array.isArray(resp.data)) {
                for (const m of resp.data) {
                    if (parseAndCacheMarket(m)) newCount++;
                }
            }
        }

        if (newCount > 0) {
            console.log(colors.green + `[Scanner] Successfully pre-cached ${newCount} new markets.` + colors.reset);
        } else {
            console.log(colors.gray + `[Scanner] No new markets found this cycle.` + colors.reset);
        }

    } catch (e) {
        console.error(colors.red + "[Scanner Error] Failed to fetch upcoming markets: " + e.message + colors.reset);
    }
}

async function fetchSynthPositions() {
    console.log(colors.yellow + "Checking Synth's existing positions to ignore..." + colors.reset);
    try {
        const response = await axios.get(`${DATA_API_URL}/positions`, {
            params: { user: SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE }
        });

        const activePos = response.data.filter(p => parseFloat(p.size) > 0);
        for (const p of activePos) {
            let market = marketCache.get(p.asset);
            if (!market) market = await fetchMarketByTokenId(p.asset);
            if (market) {
                initialSynthMarkets.add(market.conditionId);
                initialSynthMarkets.add(p.asset);
            }
        }
        console.log(colors.yellow + `[Blacklist] Found ${initialSynthMarkets.size} existing items.` + colors.reset);
    } catch (e) {
        console.error(`[Blacklist Error] ${e.message}`);
    }
}

// [NEW] Fetch MY positions so we don't try to sell air
async function fetchMyPositions() {
    console.log(colors.cyan + "Syncing MY on-chain positions..." + colors.reset);
    try {
        const response = await axios.get(`${DATA_API_URL}/positions`, {
            params: { user: POLYMARKET_PROXY_ADDRESS_LOWER_CASE }
        });
        const activePos = response.data.filter(p => parseFloat(p.size) > 0);

        myOnChainPositions.clear();
        activePos.forEach(p => {
            const size = parseFloat(p.size);
            myOnChainPositions.set(p.asset, size);
            console.log(colors.gray + `[Sync] Found ${size} of ${p.asset}` + colors.reset);
        });
        console.log(colors.cyan + `[Sync] Loaded ${activePos.length} existing positions.` + colors.reset);
    } catch (e) {
        console.error(`[Sync Error] Could not fetch my positions: ${e.message}`);
    }
}

async function fetchMarketByTokenId(tokenId) {
    if (!tokenId || tokenId === "0") return null;

    try {
        console.log(colors.gray + `[JIT] Fetching info for unknown token: ${tokenId}` + colors.reset);
        const resp = await axios.get(`${GAMMA_API_URL}/markets`, { params: { clob_token_ids: tokenId } });
        if (resp.data && resp.data.length > 0) {
            const m = resp.data[0];
            return parseAndCacheMarket(m) ? marketCache.get(tokenId) : null;
        }
    } catch (e) {
        console.error(`[JIT Error] ${e.message}`);
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
        const userResp = await axios.get(`${DATA_API_URL}/value`, { params: { user: POLYMARKET_PROXY_ADDRESS_LOWER_CASE } });
        userPositionsValue = parseFloat(userResp.data[0]?.value || 0);
        userTotalEquity = userCollateral + userPositionsValue;

        const synthCash = await getCollateral(SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE);
        const synthResp = await axios.get(`${DATA_API_URL}/value`, { params: { user: SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE } });
        const synthPosValue = parseFloat(synthResp.data[0]?.value || 0);
        const currentSynthTotal = synthCash + synthPosValue;
        if (currentSynthTotal > 1000) synthTotalEquity = currentSynthTotal;

        console.log(`[Equity] User: $${userTotalEquity.toFixed(2)} | Synth: $${synthTotalEquity.toFixed(2)}`);

        logJson('HEALTH', {
            userEquity: userTotalEquity,
            synthEquity: synthTotalEquity,
            userCollateral: userCollateral
        });
    } catch (e) { }
}

// --- HOT PATH: EVENT PROCESSING ---
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

    // 1. Check if we can identify the market
    let marketInfo = marketCache.get(makerAsset) || marketCache.get(takerAsset);
    if (!marketInfo) {
        if (makerAsset !== "0") marketInfo = await fetchMarketByTokenId(makerAsset);
        if (!marketInfo && takerAsset !== "0") marketInfo = await fetchMarketByTokenId(takerAsset);
    }

    if (!marketInfo) return;

    // 2. Check Blacklist
    if (initialSynthMarkets.has(marketInfo.conditionId) || initialSynthMarkets.has(makerAsset) || initialSynthMarkets.has(takerAsset)) {
        return;
    }

    // 3. Identify Risk Token
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

    console.log(colors.blue + `[DETECTED] Synth ${synthBought ? "BOUGHT" : "SOLD"} ${shareAmount.toFixed(1)} shares @ $${pricePaid.toFixed(2)} in "${marketInfo.outcomeLabel}"` + colors.reset);

    logJson('STIMULUS', {
        market: marketInfo.outcomeLabel,
        tokenId: riskTokenId,
        action: synthBought ? "BUY" : "SELL",
        shares: shareAmount,
        price: pricePaid,
        maker: maker,
        taker: taker,
        txHash: log.transactionHash
    });

    const signedDelta = synthBought ? shareAmount : -shareAmount;
    shadowPortfolio.update(riskTokenId, signedDelta, pricePaid, marketInfo);
}

async function placeOrder(tokenId, price, size, side, marketInfo) {
    // 1. Price Safety
    price = Math.min(Math.max(price, 0.02), 0.98);

    // 2. Precision Fix
    size = Math.floor(size);

    if (size < 1) {
        console.log(colors.red + `[SKIP] Size ${size} too small after integer rounding.` + colors.reset);
        return false; // RETURN FALSE
    }

    const sideStr = side === Side.BUY ? "BUY" : "SELL";

    logJson('EXECUTION_ATTEMPT', {
        market: marketInfo.outcomeLabel,
        tokenId: tokenId,
        side: sideStr,
        size: size,
        price: price
    });

    try {
        const orderParams = {
            tokenID: tokenId,
            price: price,
            side: side,
            size: size,
            feeRateBps: 0,
            expiration: 0,
        };

        console.log(colors.yellow + `>>> PLACING FAK ORDER: ${sideStr} ${size} @ $${price.toFixed(2)}` + colors.reset);
        const type = OrderType.FAK;

        const order = await clobClient.createAndPostOrder(orderParams, { tickSize: marketInfo.tickSize, negRisk: marketInfo.negRisk }, type);

        // CHECK SUCCESS
        if (order && (order.orderID || (order.orderIds && order.orderIds.length > 0))) {
            const id = order.orderID || order.orderIds[0];
            console.log(colors.green + `[SUCCESS] Order ID: ${id}` + colors.reset);

            logJson('EXECUTION_SUCCESS', {
                orderID: id,
                market: marketInfo.outcomeLabel
            });
            return true; // <--- CRITICAL: Return Success
        }

        // CHECK FAILURE (Kill)
        const msg = JSON.stringify(order);
        if (msg.includes("fully filled") || msg.includes("killed")) {
            console.log(colors.gray + `[MISSED] Order killed (no liquidity).` + colors.reset);
            return false; // <--- CRITICAL: Return Failure
        }

        throw new Error(`API returned no Order ID. Response: ${msg}`);

    } catch (e) {
        // [CHANGE] Robust error handling to ignore "Closed Market" noise
        const errorMsg = e.message || JSON.stringify(e);

        if (errorMsg.includes("fully filled") || errorMsg.includes("killed") || errorMsg.includes("invalid amounts")) {
            console.log(colors.gray + `[API REJECT] ${errorMsg}` + colors.reset);
        }
        else if (errorMsg.includes("does not exist") || errorMsg.includes("status 400")) {
            // This happens when we try to sell/buy on a market that just resolved.
            // We ignore it and let checkAndRedeem() handle the cleanup.
            console.log(colors.gray + `[SKIP] Market likely closed. Waiting for Redemption.` + colors.reset);
        }
        else {
            console.error(colors.red + `[ORDER FAILED] ${errorMsg}` + colors.reset);
        }

        logJson('EXECUTION_ERROR', {
            market: marketInfo.outcomeLabel,
            error: errorMsg,
            stack: e.stack
        });
        return false; // CRITICAL: Return Failure
    }
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
                {
                    gasLimit: 500000,
                    maxPriorityFeePerGas: ethers.utils.parseUnits('35', 'gwei'),
                    maxFeePerGas: ethers.utils.parseUnits('300', 'gwei')
                }
            );

            console.log(colors.cyan + `[Redeem] Tx Sent. Waiting...` + colors.reset);
            await tx.wait();
            console.log(colors.cyan + `[Redeem] Success. Capital recycled.` + colors.reset);
        } catch (e) {
            console.error(colors.red + `[Redeem Failed] ${e.message}` + colors.reset);
        }
    }
}

// [NEW] Sweeper to kill Zombie Orders
async function cancelOpenOrdersForToken(tokenId) {
    try {
        // Fetch open orders specifically for this token
        // Note: The specific filter syntax depends on the clob-client version, 
        // but often we can just cancel all for a market or filter manually.
        const orders = await clobClient.getOpenOrders({ tokenID: tokenId });

        if (orders.length > 0) {
            console.log(colors.magenta + `[Sweeper] Found ${orders.length} open GTC orders for ${tokenId}. Cancelling...` + colors.reset);
            // Cancel them one by one (or use batch if supported)
            for (const order of orders) {
                await clobClient.cancelOrder({ orderID: order.orderID });
            }
        }
    } catch (e) {
        // Ignore "No orders found" errors
    }
}

// [NEW] "Patient Sniper" Reconciliation Loop
// Fixes "Buying the Top" by placing patient limit orders instead of market-panic buys.
async function reconcileShadowPortfolio() {
    try {
        // 1. Fetch Reality
        const [synthResp, myResp] = await Promise.all([
            axios.get(`${DATA_API_URL}/positions`, { params: { user: SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE } }),
            axios.get(`${DATA_API_URL}/positions`, { params: { user: POLYMARKET_PROXY_ADDRESS_LOWER_CASE } })
        ]);

        const synthMap = new Map();
        synthResp.data.filter(p => parseFloat(p.size) > 0.1).forEach(p => {
            synthMap.set(p.asset, parseFloat(p.size));
        });

        const myMap = new Map();
        myResp.data.filter(p => parseFloat(p.size) > 0.1).forEach(p => {
            myMap.set(p.asset, parseFloat(p.size));
        });

        // 2. Process each position
        for (const [tokenId, synthRealSize] of synthMap) {
            if (initialSynthMarkets.has(tokenId)) continue;

            let market = marketCache.get(tokenId);
            if (!market) market = await fetchMarketByTokenId(tokenId);
            if (!market) continue;

            // Calculate Target
            const effectiveUserEquity = userTotalEquity > 0 ? userTotalEquity : 530;
            const scaleRatio = effectiveUserEquity / synthTotalEquity;

            const targetSize = synthRealSize * scaleRatio;
            const actualSize = myMap.get(tokenId) || 0;
            const delta = targetSize - actualSize;

            // Threshold check
            if (Math.abs(delta) > EXECUTION_THRESHOLD) {
                shadowPortfolio.forceSync(tokenId, synthRealSize, market);
                // [CRITICAL] Check if we already have an open Limit order for this token
                // const openOrders = await clobClient.getOpenOrders({ tokenID: tokenId });
                // if (openOrders.length > 0) {
                //     // We already have a fishing line in the water. Don't move it.
                //     // This is "Patience".
                //     console.log(colors.gray + `[Reconcile] Drift ${delta.toFixed(1)} on ${market.outcomeLabel}, but order already active. Waiting.` + colors.reset);
                //     continue;
                // }

                console.log(colors.magenta + `[Reconcile] Drift on ${market.outcomeLabel}. Target: ${targetSize.toFixed(1)} | Actual: ${actualSize.toFixed(1)} | Drift: ${delta.toFixed(1)}` + colors.reset);

                // [STRATEGY UPDATE: Live Market Peg]
                // 1. Fetch CURRENT market price so we don't get locked out if price ripped higher.
                let executionBasisPrice = 0;

                try {
                    const priceResp = await axios.get(`${GAMMA_API_URL}/markets`, { params: { clob_token_ids: tokenId } });
                    if (priceResp.data && priceResp.data[0]) {
                        const m = priceResp.data[0];
                        // Parse JSON fields from API
                        const tokenIds = JSON.parse(m.clobTokenIds);
                        const prices = JSON.parse(m.outcomePrices);

                        const idx = tokenIds.indexOf(tokenId);
                        if (idx !== -1) {
                            executionBasisPrice = parseFloat(prices[idx]);
                        }
                    }
                } catch (e) {
                    // Swallow API errors, we will hit the fallback below
                }

                // 2. Fallback: If API failed, try using Synth's avg entry from memory
                const shadowPos = shadowPortfolio.positions.get(tokenId);
                if (executionBasisPrice === 0 && shadowPos && shadowPos.avgEntry > 0) {
                    executionBasisPrice = shadowPos.avgEntry;
                }

                // 3. Last Resort: 50c default
                if (executionBasisPrice === 0) {
                    executionBasisPrice = 0.50;
                }

                logJson('RECONCILIATION', {
                    market: market.outcomeLabel,
                    tokenId: tokenId,
                    drift: delta,
                    action: "CATCH_UP_FAK",
                    basisPrice: executionBasisPrice
                });

                // 4. Execute
                // We pass the RAW current price. 
                // Your 'execute' function already adds the 5% FAK buffer/slippage on top of this.
                shadowPortfolio.execute(tokenId, delta, executionBasisPrice, market);
            }
        }

        // 3. Kill Ghosts
        for (const [tokenId, mySize] of myMap) {
            if (mySize > 0.1 && !synthMap.has(tokenId)) {
                if (initialSynthMarkets.has(tokenId)) continue;
                let market = marketCache.get(tokenId) || { outcomeLabel: "Unknown" };

                // Kill any pending BUY orders for this ghost
                await cancelOpenOrdersForToken(tokenId);

                const delta = -mySize;
                // Force sell
                shadowPortfolio.execute(tokenId, delta, 0, market);
            }
        }

    } catch (e) {
        console.error(colors.red + `[Reconcile Error] ${e.message}` + colors.reset);
    }
}

async function startTracker() {
    initLogging();
    console.log(colors.green + "Initializing Synth Tracker (FINAL FIXED VERSION)..." + colors.reset);

    function connectWs() {
        if (provider) { try { provider._websocket.terminate(); } catch (e) { } }
        provider = new ethers.providers.WebSocketProvider(POLYGON_WS_URL);
        provider._websocket.on('open', async () => {
            console.log(colors.green + "[WS] Connected." + colors.reset);
            signer = new ethers.Wallet(PHANTOM_POLYGON_WALLET_PRIVATE_KEY, provider);

            clobClient = new ClobClient(
                CLOB_HOST,
                CHAIN_ID,
                signer,
                { key: API_KEY, secret: API_SECRET, passphrase: API_PASSPHRASE },
                SIGNATURE_TYPE,
                POLYMARKET_PROXY_ADDRESS_LOWER_CASE
            );

            provider.on({ address: LEGACY_EXCHANGE, topics: [ORDER_FILLED_TOPIC] }, handleTradeLog);
            provider.on({ address: NEG_RISK_EXCHANGE, topics: [ORDER_FILLED_TOPIC] }, handleTradeLog);
        });
        provider._websocket.on('close', () => {
            console.log(colors.red + "[WS] Disconnected. Reconnecting..." + colors.reset);
            setTimeout(connectWs, 3000);
        });
    }

    connectWs();
    await scanUpcomingMarkets();
    await fetchSynthPositions();
    await fetchMyPositions();
    await refreshTotals();
    console.log(colors.cyan + "[Startup] Checking for redeems..." + colors.reset);
    await checkAndRedeem();

    setInterval(reconcileShadowPortfolio, RECONCILE_INTERVAL_MS);

    setInterval(checkAndRedeem, REDEEM_INTERVAL_MS);
    setInterval(scanUpcomingMarkets, POLL_INTERVAL_MS);
    setInterval(refreshTotals, 60000);
    setInterval(fetchMyPositions, 15000);
}

// --- CRASH GUARD ---
process.on('uncaughtException', (err) => {
    if (err.message.includes('reading \'callback\'') || err.message.includes('WebSocket')) {
        console.log(colors.yellow + `[Stabilizer] Caught library WebSocket error. Reconnecting...` + colors.reset);
        // We don't need to do anything else; the heartbeat intervals will eventually 
        // fail and trigger the existing 'close' logic, or we can force a restart:
        if (provider && provider._websocket) {
            try { provider._websocket.terminate(); } catch (e) { }
        }
        // The existing 'close' listener in startTracker will handle the reconnect
    } else {
        console.error(colors.red + `[CRITICAL] Uncaught exception: ${err.message}` + colors.reset);
        process.exit(1); // Exit on real logic errors
    }
});

startTracker();