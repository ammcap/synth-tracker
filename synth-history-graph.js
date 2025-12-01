const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const SYNTH_ADDRESS = '0x557bed924a1bb6f62842c5742d1dc789b8d480d4'.toLowerCase();
const HOURS_TO_LOOK_BACK = 1; // Kept at 1 hour as requested
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Official Goldsky Orderbook Subgraph (TRADES)
const ORDERBOOK_URL = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn';

// Official Goldsky Activity Subgraph (REDEMPTIONS)
const ACTIVITY_URL = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/activity-subgraph/0.0.4/gn';

const colors = {
    reset: '\x1b[0m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', gray: '\x1b[90m'
};

const api = axios.create({ timeout: 20000 });

async function fetchHistory() {
    console.log(colors.cyan + `[History] Fetching data for Synth (${HOURS_TO_LOOK_BACK}h lookback)...` + colors.reset);

    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - (HOURS_TO_LOOK_BACK * 60 * 60);

    // Cache to store Market Info.
    const marketCache = new Map();

    // --- 1. FETCH TRADES (Orderbook Subgraph) ---
    async function fetchSubgraphOrders() {
        console.log(colors.gray + "   ...querying Trades (Orderbook Subgraph)..." + colors.reset);
        let allOrders = [];
        let lastTimestamp = endTime;
        let keepFetching = true;

        const queryTemplate = `
        query GetOrders($user: String!, $minTime: BigInt!, $maxTime: BigInt!) {
            maker: orderFilledEvents(
                where: { maker: $user, timestamp_gte: $minTime, timestamp_lt: $maxTime }
                orderBy: timestamp, orderDirection: desc, first: 1000
            ) {
                id transactionHash timestamp maker taker makerAssetId takerAssetId makerAmountFilled takerAmountFilled
            }
            taker: orderFilledEvents(
                where: { taker: $user, timestamp_gte: $minTime, timestamp_lt: $maxTime }
                orderBy: timestamp, orderDirection: desc, first: 1000
            ) {
                id transactionHash timestamp maker taker makerAssetId takerAssetId makerAmountFilled takerAmountFilled
            }
        }`;

        while (keepFetching) {
            try {
                const variables = { user: SYNTH_ADDRESS, minTime: String(startTime), maxTime: String(lastTimestamp) };
                const response = await api.post(ORDERBOOK_URL, { query: queryTemplate, variables });

                if (response.data.errors) throw new Error(JSON.stringify(response.data.errors));

                const data = response.data.data;
                const batch = [...(data.maker || []), ...(data.taker || [])];

                if (batch.length === 0) {
                    keepFetching = false;
                } else {
                    const uniqueBatch = batch.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
                    allOrders = allOrders.concat(uniqueBatch);
                    const minBatchTime = Math.min(...uniqueBatch.map(o => parseInt(o.timestamp)));
                    if (minBatchTime <= startTime || uniqueBatch.length < 10) keepFetching = false;
                    else lastTimestamp = minBatchTime;
                }
            } catch (e) {
                console.log(colors.red + `      [Trades Error] ${e.message}` + colors.reset);
                keepFetching = false;
            }
        }
        return allOrders;
    }

    // --- 2. FETCH REDEMPTIONS (Activity Subgraph) ---
    async function fetchRedemptions() {
        console.log(colors.gray + "   ...querying Redemptions (Activity Subgraph)..." + colors.reset);
        let allRedemptions = [];
        let lastTimestamp = endTime;
        let keepFetching = true;

        const queryTemplate = `
        query GetRedemptions($user: String!, $minTime: BigInt!, $maxTime: BigInt!) {
            redemptions(
                where: { redeemer: $user, timestamp_gte: $minTime, timestamp_lt: $maxTime }
                orderBy: timestamp, orderDirection: desc, first: 1000
            ) {
                id timestamp redeemer payout condition indexSets
            }
        }`;

        while (keepFetching) {
            try {
                const variables = { user: SYNTH_ADDRESS, minTime: String(startTime), maxTime: String(lastTimestamp) };
                const response = await api.post(ACTIVITY_URL, { query: queryTemplate, variables });

                if (response.data.errors) throw new Error(JSON.stringify(response.data.errors));

                const batch = response.data.data.redemptions || [];

                if (batch.length === 0) {
                    keepFetching = false;
                } else {
                    allRedemptions = allRedemptions.concat(batch);
                    const minBatchTime = Math.min(...batch.map(o => parseInt(o.timestamp)));
                    if (minBatchTime <= startTime || batch.length < 100) keepFetching = false;
                    else lastTimestamp = minBatchTime;
                }
            } catch (e) {
                console.log(colors.red + `      [Redemption Error] ${e.message}` + colors.reset);
                keepFetching = false;
            }
        }
        return allRedemptions;
    }

    const [rawTrades, rawRedemptions] = await Promise.all([fetchSubgraphOrders(), fetchRedemptions()]);

    const totalEvents = rawTrades.length + rawRedemptions.length;
    if (totalEvents === 0) {
        console.log(colors.red + "[Error] No events found. Check address/time." + colors.reset);
        return;
    }

    console.log(colors.green + `[Success] Found ${rawTrades.length} trades and ${rawRedemptions.length} redemptions.` + colors.reset);

    // --- 3. METADATA LOOKUP (Gamma API) ---
    const tokenIdsToFetch = new Set();
    const conditionIdsToFetch = new Set();

    rawTrades.forEach(o => {
        if (o.makerAssetId) tokenIdsToFetch.add(o.makerAssetId);
        if (o.takerAssetId) tokenIdsToFetch.add(o.takerAssetId);
    });

    rawRedemptions.forEach(r => {
        if (r.condition) conditionIdsToFetch.add(r.condition);
    });

    const uniqueTokens = Array.from(tokenIdsToFetch).filter(x => x && x !== "0");
    const uniqueConditions = Array.from(conditionIdsToFetch);

    console.log(colors.gray + `   ...resolving names for ${uniqueTokens.length} tokens and ${uniqueConditions.length} conditions...` + colors.reset);

    // Helper to fetch markets individually to avoid API chunking errors
    async function fetchMarketMetadata(ids, paramName) {
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (i % 5 === 0) process.stdout.write(colors.gray + `.` + colors.reset);
            try {
                // Rate limit
                await new Promise(r => setTimeout(r, 50));

                // Fetch individually
                const params = {};
                params[paramName] = id;
                const resp = await api.get(`${GAMMA_API_URL}/markets`, { params: params });

                if (resp.data && Array.isArray(resp.data)) {
                    resp.data.forEach(m => {
                        const tokens = JSON.parse(m.clobTokenIds || '[]');
                        const outcomes = JSON.parse(m.outcomes || '[]');

                        // Map by Token ID
                        tokens.forEach((tokenId, index) => {
                            marketCache.set(String(tokenId), {
                                question: m.question,
                                outcome: outcomes[index] || 'Unknown',
                                conditionId: m.conditionId,
                                outcomes: outcomes
                            });
                        });

                        // Map by Condition ID (for Redemptions)
                        marketCache.set(String(m.conditionId), {
                            question: m.question,
                            outcomes: outcomes
                        });
                    });
                }
            } catch (e) {
                console.log(colors.yellow + `\n[Warning] Failed to fetch metadata for ${paramName}=${id}` + colors.reset);
            }
        }
        console.log("");
    }

    await fetchMarketMetadata(uniqueTokens, 'clob_token_ids');
    await fetchMarketMetadata(uniqueConditions, 'condition_ids');

    // --- 4. PROCESS TRADES ---
    const processedTrades = rawTrades.map(o => {
        const isMaker = o.maker.toLowerCase() === SYNTH_ADDRESS;
        let marketName = "Unknown";
        let outcomeName = "Unknown";
        let side = "UNKNOWN";

        const makerInfo = marketCache.get(String(o.makerAssetId));
        const takerInfo = marketCache.get(String(o.takerAssetId));

        let outcomeAmount, moneyAmount;

        if (makerInfo) {
            outcomeAmount = parseFloat(o.makerAmountFilled) / 1e6;
            moneyAmount = parseFloat(o.takerAmountFilled) / 1e6;
            marketName = makerInfo.question;
            outcomeName = makerInfo.outcome;
            side = isMaker ? "SELL" : "BUY";
        } else if (takerInfo) {
            outcomeAmount = parseFloat(o.takerAmountFilled) / 1e6;
            moneyAmount = parseFloat(o.makerAmountFilled) / 1e6;
            marketName = takerInfo.question;
            outcomeName = takerInfo.outcome;
            side = isMaker ? "BUY" : "SELL";
        } else {
            // Only return null if we truly can't identify the market
            return null;
        }

        const price = outcomeAmount > 0 ? moneyAmount / outcomeAmount : 0;

        return {
            timestamp: parseInt(o.timestamp),
            type: "TRADE",
            side: side,
            market: marketName,
            outcome: outcomeName,
            size: outcomeAmount,
            price: price,
            value: moneyAmount,
            hash: o.transactionHash
        };
    }).filter(x => x !== null);

    // --- 5. PROCESS REDEMPTIONS ---
    const processedRedemptions = rawRedemptions.map(r => {
        const marketInfo = marketCache.get(String(r.condition));
        let marketName = "Unknown";
        let outcomeName = "Unknown";

        // Split by '_' or '-' to get clean hash from ID (e.g. "0xHash_0xLogIndex")
        const txHash = r.id.split(/[-_]/)[0];

        const payout = parseFloat(r.payout) / 1e6;

        if (marketInfo && r.indexSets && r.indexSets.length > 0) {
            marketName = marketInfo.question;
            const indexSetVal = parseInt(r.indexSets[0]);
            const outcomeIndex = Math.log2(indexSetVal);

            if (marketInfo.outcomes && marketInfo.outcomes[outcomeIndex]) {
                outcomeName = marketInfo.outcomes[outcomeIndex];
            }
        }

        return {
            timestamp: parseInt(r.timestamp),
            type: "REDEEM",
            side: "REDEEM",
            market: marketName,
            outcome: outcomeName,
            size: payout,
            price: 1.0,
            value: payout,
            hash: txHash
        };
    });

    // --- 6. MERGE AND SAVE ---
    const finalData = [...processedTrades, ...processedRedemptions];
    finalData.sort((a, b) => b.timestamp - a.timestamp);

    const historyDir = path.join(__dirname, 'history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir);
    const nowStr = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(historyDir, `synth_history_FULL_${nowStr}.csv`);

    const header = "timestamp,type,side,market,outcome,size,price,valueUSDC,hash";
    const rows = finalData.map(d => {
        const safeMarket = `"${d.market.replace(/"/g, '""')}"`;
        const safeOutcome = `"${d.outcome.replace(/"/g, '""')}"`;
        const timeStr = new Date(d.timestamp * 1000).toISOString();
        return `${timeStr},${d.type},${d.side},${safeMarket},${safeOutcome},${d.size.toFixed(2)},${d.price.toFixed(3)},${d.value.toFixed(2)},${d.hash}`;
    });

    const csvContent = [header, ...rows].join('\n');
    fs.writeFileSync(filename, csvContent);
    console.log(colors.green + `[Done] Saved ${finalData.length} rows to ${filename}` + colors.reset);
}

fetchHistory();