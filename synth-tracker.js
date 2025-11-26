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

const SLIPPAGE_BUFFER = 0.03;
const EXECUTION_THRESHOLD = 5;
const POLL_INTERVAL_MS = 120000;
const REDEEM_INTERVAL_MS = 60000;
const RECONCILE_INTERVAL_MS = 45000;

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

function logJson(type, data) {
    if (!logStream) return;
    const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: type,
        ...data
    });
    logStream.write(entry + '\n');
}

// --- SHADOW PORTFOLIO ---
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
        this.checkTrigger(tokenId);
    }

    checkTrigger(tokenId) {
        const shadow = this.positions.get(tokenId);
        if (!shadow) return;

        const effectiveUserEquity = userTotalEquity > 0 ? userTotalEquity : 530;
        const scaleRatio = effectiveUserEquity / synthTotalEquity;
        const targetSize = shadow.netShares * scaleRatio;

        const currentSize = myOnChainPositions.get(tokenId) || 0;
        const diff = targetSize - currentSize;
        const absDiff = Math.abs(diff);

        // [LOGGING] Capture the state of the brain
        const decision = absDiff < EXECUTION_THRESHOLD ? "ACCUMULATING" : "TRIGGER";

        logJson('BRAIN', {
            market: shadow.market.outcomeLabel,
            tokenId: tokenId,
            synthShares: shadow.netShares,
            myTarget: targetSize,
            myActual: currentSize,
            diff: diff,
            threshold: EXECUTION_THRESHOLD,
            decision: decision
        });

        if (absDiff < EXECUTION_THRESHOLD) {
            console.log(colors.gray + `[Accumulating] ${shadow.market.outcomeLabel}: ShadowTarget=${targetSize.toFixed(1)} | Actual=${currentSize.toFixed(1)} | Diff=${diff.toFixed(2)}` + colors.reset);
            return;
        }

        console.log(colors.magenta + `[TRIGGER] ${shadow.market.outcomeLabel}: Diff ${diff.toFixed(2)} exceeds threshold!` + colors.reset);
        this.execute(tokenId, diff, shadow.avgEntry, shadow.market);
    }

    async execute(tokenId, sizeToFill, avgEntryPrice, market) {
        const side = sizeToFill > 0 ? Side.BUY : Side.SELL;
        let finalSize = Math.abs(sizeToFill);

        // [UPDATE] Dynamic Wallet Balance Check
        if (side === Side.BUY) {
            const estimatedCost = finalSize * avgEntryPrice;

            // Check if we can afford this trade
            if (estimatedCost > userCollateral) {
                console.log(colors.yellow + `[ADJUST] Target cost $${estimatedCost.toFixed(2)} exceeds wallet balance $${userCollateral.toFixed(2)}.` + colors.reset);

                // Recalculate max shares we can buy with available funds (leaving 1% buffer for rounding)
                const affordableSize = (userCollateral * 0.99) / avgEntryPrice;

                if (affordableSize < 1) {
                    console.log(colors.red + `[SKIP] Available funds ($${userCollateral.toFixed(2)}) too low for minimum trade.` + colors.reset);
                    return;
                }

                console.log(colors.yellow + `[ADJUST] Resizing order from ${finalSize.toFixed(1)} -> ${affordableSize.toFixed(1)} shares.` + colors.reset);
                finalSize = affordableSize;
            }
        }

        // [FIX] HARD SELL CHECK
        // If we are trying to SELL, check if we actually have the shares.
        if (side === Side.SELL) {
            const owned = myOnChainPositions.get(tokenId) || 0;
            if (owned < 0.1) {
                console.log(colors.red + `[SKIP SELL] Shadow wants to sell ${finalSize}, but on-chain balance is ${owned}. Ignoring.` + colors.reset);
                return;
            }
            // If we try to sell more than we own (drift error), cap it to what we own
            if (finalSize > owned) {
                console.log(colors.yellow + `[ADJUST] Cap sell size from ${finalSize} to owned balance ${owned}.` + colors.reset);
                finalSize = owned;
            }
        }

        let limitPrice = sizeToFill > 0 ? (avgEntryPrice + SLIPPAGE_BUFFER) : (avgEntryPrice - SLIPPAGE_BUFFER);
        limitPrice = Math.min(Math.max(limitPrice, 0.05), 0.95);

        try {
            // Use finalSize instead of sizeToFill
            await placeOrder(tokenId, limitPrice, finalSize, side, market);

            // SUCCESS: Update local state to reflect what we actually did
            const current = myOnChainPositions.get(tokenId) || 0;
            const signedChange = side === Side.BUY ? finalSize : -finalSize;
            myOnChainPositions.set(tokenId, current + signedChange);

            // Update collateral estimate locally so we don't try to double-spend before the next API refresh
            if (side === Side.BUY) {
                userCollateral -= (finalSize * limitPrice);
            } else {
                userCollateral += (finalSize * limitPrice);
            }

        } catch (e) {
            // Failure is logged in placeOrder
        }
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
    price = Math.min(Math.max(price, 0.02), 0.98);
    size = Math.floor(size * 10) / 10;
    const sideStr = side === Side.BUY ? "BUY" : "SELL";

    // [LOGGING] Log the attempt
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
        };

        console.log(colors.yellow + `>>> PLACING ORDER: ${sideStr} ${size} @ $${price.toFixed(2)}` + colors.reset);

        const order = await clobClient.createAndPostOrder(orderParams, { tickSize: marketInfo.tickSize, negRisk: marketInfo.negRisk });

        if (order && order.orderID) {
            console.log(colors.green + `[SUCCESS] Order ID: ${order.orderID}` + colors.reset);

            // [LOGGING] Log success
            logJson('EXECUTION_SUCCESS', {
                orderID: order.orderID,
                market: marketInfo.outcomeLabel
            });
        } else {
            console.log(colors.red + `[FAILURE] API returned success but no Order ID. Raw: ${JSON.stringify(order)}` + colors.reset);
            throw new Error("API returned no Order ID");
        }
    } catch (e) {
        console.error(colors.red + `[ORDER FAILED] ${e.message}` + colors.reset);

        // [LOGGING] Log the specific error
        logJson('EXECUTION_ERROR', {
            market: marketInfo.outcomeLabel,
            error: e.message,
            stack: e.stack
        });
        throw e;
    }
}

async function checkAndRedeem() {
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

// [NEW] Truth Loop: Fixes State Drift between WebSocket and Reality
async function reconcileShadowPortfolio() {
    // console.log(colors.gray + "[Truth Loop] Checking for state drift..." + colors.reset);
    try {
        // 1. Fetch Synth's Current Reality
        const response = await axios.get(`${DATA_API_URL}/positions`, {
            params: { user: SYNTH_POLYMARKET_PROXY_ADDRESS_LOWER_CASE }
        });

        // Filter out dust (< 0.1 shares)
        const synthActualPositions = response.data.filter(p => parseFloat(p.size) > 0.1);
        const synthMap = new Map(); // Keep track of what Synth currently holds

        // 2. Sync Reality -> Shadow
        for (const p of synthActualPositions) {
            const tokenId = p.asset;
            const realSize = parseFloat(p.size);
            synthMap.set(tokenId, realSize);

            // STRICTLY IGNORE BLACKLISTED MARKETS
            if (initialSynthMarkets.has(tokenId)) continue;

            // Ensure we have market data
            let market = marketCache.get(tokenId);
            if (!market) market = await fetchMarketByTokenId(tokenId);
            if (!market) continue;

            // Calculate Drift
            const shadowPos = shadowPortfolio.positions.get(tokenId);
            const currentShadowSize = shadowPos ? shadowPos.netShares : 0;
            const delta = realSize - currentShadowSize;

            // If drift exceeds threshold, force correct it
            if (Math.abs(delta) > EXECUTION_THRESHOLD) {
                console.log(colors.magenta + `[Reconcile] Drift detected on ${market.outcomeLabel}. Shadow: ${currentShadowSize.toFixed(1)} -> Real: ${realSize.toFixed(1)}` + colors.reset);
                logJson('RECONCILIATION', {
                    market: market.outcomeLabel,
                    tokenId: tokenId,
                    synthReal: realSize,
                    shadowLocal: currentShadowSize,
                    drift: delta,
                    action: "FORCE_UPDATE"
                });

                // If we are catching up a BUY (delta > 0), we use a high price (0.95) for the update.
                // This ensures the subsequent 'execute' logic sets a high enough limit price to actually enter.
                // If we are SELLING (delta < 0), the price param is ignored by the logic anyway.
                const catchUpPrice = delta > 0 ? 0.95 : 0;

                // This updates the shadow state AND triggers 'checkTrigger', which forces the bot to trade
                shadowPortfolio.update(tokenId, delta, catchUpPrice, market);
            }
        }

        // 3. Kill Ghosts (Positions Shadow thinks we have, but Synth has sold)
        for (const [tokenId, shadow] of shadowPortfolio.positions) {
            // If shadow thinks we have shares (> 0.1) AND Synth does NOT have this token anymore
            if (shadow.netShares > 0.1 && !synthMap.has(tokenId)) {

                // Double check blacklist to be safe (shouldn't happen, but safety first)
                if (initialSynthMarkets.has(tokenId)) continue;

                console.log(colors.magenta + `[Reconcile] Ghost position detected on ${shadow.market.outcomeLabel}. Force closing.` + colors.reset);

                // Create a negative delta exactly equal to current shares to zero it out
                const delta = -shadow.netShares;
                shadowPortfolio.update(tokenId, delta, 0, shadow.market);
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

    setInterval(reconcileShadowPortfolio, RECONCILE_INTERVAL_MS);

    setInterval(checkAndRedeem, REDEEM_INTERVAL_MS);
    setInterval(scanUpcomingMarkets, POLL_INTERVAL_MS);
    setInterval(refreshTotals, 60000);
    setInterval(fetchMyPositions, 120000);
}

startTracker();