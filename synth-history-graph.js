const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const SYNTH_ADDRESS = '0x557bed924a1bb6f62842c5742d1dc789b8d480d4'.toLowerCase();
const HOURS_TO_LOOK_BACK = 168;
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

const ORDERBOOK_URL = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn';
const ACTIVITY_URL = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/activity-subgraph/0.0.4/gn';

const colors = {
    reset: '\x1b[0m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', gray: '\x1b[90m'
};

const api = axios.create({ timeout: 30000 });

// Generic function to fetch paginated data for a single entity type
async function fetchStream(url, queryName, fieldPath, variables) {
    let allItems = [];
    let lastTimestamp = Math.floor(Date.now() / 1000) + 60;
    const startTime = lastTimestamp - (HOURS_TO_LOOK_BACK * 60 * 60);
    let keepFetching = true;
    const seenIds = new Set();

    console.log(colors.gray + `   ...querying ${queryName}...` + colors.reset);

    const query = `
    query Get${queryName}($user: String!, $minTime: BigInt!, $maxTime: BigInt!) {
        ${fieldPath}(
            where: { ${variables.userField}: $user, timestamp_gte: $minTime, timestamp_lte: $maxTime }
            orderBy: timestamp, orderDirection: desc, first: 1000
        ) {
            ${variables.fields}
        }
    }`;

    while (keepFetching) {
        try {
            const vars = { user: SYNTH_ADDRESS, minTime: String(startTime), maxTime: String(lastTimestamp) };
            const response = await api.post(url, { query: query, variables: vars });

            if (response.data.errors) throw new Error(JSON.stringify(response.data.errors));

            const rawData = response.data.data[fieldPath];

            // Print a dot to show aliveness
            process.stdout.write(colors.gray + '.' + colors.reset);

            if (!rawData || rawData.length === 0) {
                keepFetching = false;
            } else {
                const newItems = rawData.filter(item => !seenIds.has(item.id));
                newItems.forEach(item => seenIds.add(item.id));
                allItems = allItems.concat(newItems);

                const minTimeInBatch = Math.min(...rawData.map(i => parseInt(i.timestamp)));

                // CRITICAL FIX: Stop if we hit the time limit OR if we got a partial page
                if (minTimeInBatch <= startTime || rawData.length < 1000) {
                    keepFetching = false;
                } else {
                    lastTimestamp = minTimeInBatch;
                }

                // If full page but no new items (stuck on massive block), force step back
                if (newItems.length === 0 && rawData.length === 1000) {
                    lastTimestamp = minTimeInBatch - 1;
                }
            }
            await new Promise(r => setTimeout(r, 50));
        } catch (e) {
            console.log(colors.red + `\n      [Error ${queryName}] ${e.message}` + colors.reset);
            keepFetching = false;
        }
    }
    console.log(""); // New line after dots
    return allItems;
}

async function fetchHistory() {
    console.log(colors.cyan + `[History] Fetching data for Synth (${HOURS_TO_LOOK_BACK}h lookback)...` + colors.reset);

    // --- 1. FETCH ALL STREAMS INDEPENDENTLY ---
    const orderFields = `id transactionHash timestamp maker taker makerAssetId takerAssetId makerAmountFilled takerAmountFilled`;

    // We run these in parallel
    const [makerOrders, takerOrders, redemptions, splits, merges] = await Promise.all([
        fetchStream(ORDERBOOK_URL, "MakerOrders", "orderFilledEvents", { userField: "maker", fields: orderFields }),
        fetchStream(ORDERBOOK_URL, "TakerOrders", "orderFilledEvents", { userField: "taker", fields: orderFields }),
        fetchStream(ACTIVITY_URL, "Redemptions", "redemptions", { userField: "redeemer", fields: "id timestamp payout condition indexSets" }),
        fetchStream(ACTIVITY_URL, "Splits", "splits", { userField: "stakeholder", fields: "id timestamp amount condition" }),
        fetchStream(ACTIVITY_URL, "Merges", "merges", { userField: "stakeholder", fields: "id timestamp amount condition" })
    ]);

    const rawTrades = [...makerOrders, ...takerOrders];
    // Dedupe trades (in case self-trading caused overlap, though uncommon with separated queries)
    const uniqueTrades = Array.from(new Map(rawTrades.map(item => [item.id, item])).values());

    const totalActivity = redemptions.length + splits.length + merges.length;

    if (uniqueTrades.length + totalActivity === 0) {
        console.log(colors.red + "[Error] No events found." + colors.reset);
        return;
    }

    console.log(colors.green + `[Success] Found ${uniqueTrades.length} trades and ${totalActivity} activity events.` + colors.reset);

    // --- 2. METADATA LOOKUP ---
    const tokenIdsToFetch = new Set();
    const conditionIdsToFetch = new Set();
    const marketCache = new Map();

    uniqueTrades.forEach(o => {
        if (o.makerAssetId) tokenIdsToFetch.add(o.makerAssetId);
        if (o.takerAssetId) tokenIdsToFetch.add(o.takerAssetId);
    });

    [...redemptions, ...splits, ...merges].forEach(a => {
        if (a.condition) conditionIdsToFetch.add(a.condition);
    });

    const uniqueTokens = Array.from(tokenIdsToFetch).filter(x => x && x !== "0");
    const uniqueConditions = Array.from(conditionIdsToFetch);

    console.log(colors.gray + `   ...resolving names for ${uniqueTokens.length} tokens and ${uniqueConditions.length} conditions...` + colors.reset);

    async function fetchMarketMetadata(ids, paramName) {
        for (let i = 0; i < ids.length; i += 20) {
            const batch = ids.slice(i, i + 20);
            process.stdout.write(colors.gray + `.` + colors.reset);
            try {
                await new Promise(r => setTimeout(r, 100)); // Rate limit buffer
                const params = {}; params[paramName] = batch.join(','); // Fetch batch
                // Note: The API might expect single ID or array. 
                // If Gamma doesn't support comma-separated, we revert to loop 1 by 1. 
                // Assuming 1 by 1 for safety based on your previous code:
                for (const id of batch) {
                    const p = {}; p[paramName] = id;
                    const resp = await api.get(`${GAMMA_API_URL}/markets`, { params: p });
                    if (resp.data && Array.isArray(resp.data)) {
                        resp.data.forEach(m => {
                            let tokens = JSON.parse(m.clobTokenIds || '[]');
                            let outcomes = JSON.parse(m.outcomes || '[]');

                            // --- THE FIX: FORCE 'UP' TO INDEX 0 ---
                            // If the API returns ["Down", "Up"], we swap them back to ["Up", "Down"]
                            // so they match the CTF Slot Order (Long=0, Short=1).
                            if (outcomes.length === 2 && outcomes[1] === "Up" && outcomes[0] === "Down") {
                                // console.log(`[Fix] correcting swapped labels for ${m.question}`);
                                outcomes = ["Up", "Down"];
                                // We don't swap tokens because clobTokenIds are usually usually correct by slot.
                                // But if the API swapped both, this aligns the Label to the Slot.
                            }
                            // --------------------------------------

                            tokens.forEach((tokenId, index) => {
                                marketCache.set(String(tokenId), {
                                    question: m.question, outcome: outcomes[index] || 'Unknown',
                                    conditionId: m.conditionId, outcomes: outcomes
                                });
                            });
                            marketCache.set(String(m.conditionId), {
                                question: m.question, outcomes: outcomes
                            });
                        });
                    }
                }
            } catch (e) { }
        }
        console.log("");
    }

    await fetchMarketMetadata(uniqueTokens, 'clob_token_ids');
    await fetchMarketMetadata(uniqueConditions, 'condition_ids');

    // --- 3. PROCESS EVENTS ---
    let finalData = [];

    // Process Trades
    uniqueTrades.forEach(o => {
        const isMaker = o.maker.toLowerCase() === SYNTH_ADDRESS;
        const makerInfo = marketCache.get(String(o.makerAssetId));
        const takerInfo = marketCache.get(String(o.takerAssetId));
        let marketName = "Unknown", outcomeName = "Unknown", side = "UNKNOWN", size = 0, price = 0, value = 0;

        if (makerInfo) { // Selling
            size = parseFloat(o.makerAmountFilled) / 1e6;
            value = parseFloat(o.takerAmountFilled) / 1e6;
            marketName = makerInfo.question; outcomeName = makerInfo.outcome;
            side = isMaker ? "SELL" : "BUY";
        } else if (takerInfo) { // Buying
            size = parseFloat(o.takerAmountFilled) / 1e6;
            value = parseFloat(o.makerAmountFilled) / 1e6;
            marketName = takerInfo.question; outcomeName = takerInfo.outcome;
            side = isMaker ? "BUY" : "SELL";
        } else return;

        price = size > 0 ? value / size : 0;
        finalData.push({
            timestamp: parseInt(o.timestamp),
            type: "TRADE", side, market: marketName, outcome: outcomeName,
            size, price, value, hash: o.transactionHash
        });
    });

    // Helper for Activity
    const processActivity = (items, type, sideLogic) => {
        items.forEach(a => {
            const marketInfo = marketCache.get(String(a.condition));
            const marketName = marketInfo ? marketInfo.question : "Unknown";
            const txHash = a.id.split(/[-_]/)[0];

            // Special handling for Redemptions
            if (type === "REDEEM") {
                let outcomeName = "Unknown";
                const payout = parseFloat(a.payout) / 1e6;
                if (marketInfo && a.indexSets && a.indexSets.length > 0) {
                    const idx = Math.log2(parseInt(a.indexSets[0]));
                    if (marketInfo.outcomes[idx]) outcomeName = marketInfo.outcomes[idx];
                }
                finalData.push({
                    timestamp: parseInt(a.timestamp),
                    type: "REDEEM", side: "REDEEM", market: marketName, outcome: outcomeName,
                    size: payout, price: 1.0, value: payout, hash: txHash
                });
            } else {
                // Splits (MINT) and Merges (BURN)
                const amount = parseFloat(a.amount) / 1e6;
                if (marketInfo && marketInfo.outcomes) {
                    marketInfo.outcomes.forEach(outcome => {
                        finalData.push({
                            timestamp: parseInt(a.timestamp),
                            type: type,
                            side: sideLogic, // BUY for Split, SELL for Merge
                            market: marketName,
                            outcome: outcome,
                            size: amount,
                            price: 0.50,
                            value: amount / marketInfo.outcomes.length,
                            hash: txHash
                        });
                    });
                }
            }
        });
    };

    processActivity(redemptions, "REDEEM", "REDEEM");
    processActivity(splits, "SPLIT", "BUY");
    processActivity(merges, "MERGE", "SELL");

    // Sort and Save
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

    fs.writeFileSync(filename, [header, ...rows].join('\n'));
    console.log(colors.green + `[Done] Saved ${finalData.length} rows to ${filename}` + colors.reset);
}

fetchHistory();