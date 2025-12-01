const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const SYNTH_ADDRESS = '0x557bed924a1bb6f62842c5742d1dc789b8d480d4'.toLowerCase();
const HOURS_TO_LOOK_BACK = 1;
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Official Goldsky Orderbook Subgraph
const SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn';

const colors = {
    reset: '\x1b[0m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', gray: '\x1b[90m'
};

const api = axios.create({ timeout: 20000 });

async function fetchHistory() {
    console.log(colors.cyan + `[History] Fetching Subgraph data for Synth (${HOURS_TO_LOOK_BACK}h lookback)...` + colors.reset);

    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - (HOURS_TO_LOOK_BACK * 60 * 60);
    const marketCache = new Map();

    async function fetchSubgraphOrders() {
        console.log(colors.gray + "   ...querying Goldsky Subgraph (orderFilledEvents)..." + colors.reset);

        let allOrders = [];
        let lastTimestamp = endTime;
        let keepFetching = true;

        // FIXED: Using 'orderFilledEvents' based on your diagnostic output
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
                process.stdout.write(colors.gray + `      > Fetching batch ending @ ${lastTimestamp}... ` + colors.reset);

                const variables = {
                    user: SYNTH_ADDRESS,
                    minTime: String(startTime),
                    maxTime: String(lastTimestamp)
                };

                const response = await api.post(SUBGRAPH_URL, { query: queryTemplate, variables });

                if (response.data.errors) {
                    console.error(colors.red + "\n[GraphQL Error] " + JSON.stringify(response.data.errors) + colors.reset);
                    keepFetching = false;
                    break;
                }

                const data = response.data.data;
                const batch = [...(data.maker || []), ...(data.taker || [])];

                if (batch.length === 0) {
                    console.log("Done (No more data).");
                    keepFetching = false;
                } else {
                    // Filter duplicates by ID
                    const uniqueBatch = batch.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);

                    console.log(`Found ${uniqueBatch.length} items.`);
                    allOrders = allOrders.concat(uniqueBatch);

                    // Find oldest timestamp in this batch for the next cursor
                    const minBatchTime = Math.min(...uniqueBatch.map(o => parseInt(o.timestamp)));

                    if (minBatchTime <= startTime || uniqueBatch.length < 10) {
                        keepFetching = false;
                    } else {
                        lastTimestamp = minBatchTime;
                    }
                }
            } catch (e) {
                console.log(colors.red + `\n[Fetch Error] ${e.message}` + colors.reset);
                keepFetching = false;
            }
        }
        return allOrders;
    }

    const rawOrders = await fetchSubgraphOrders();

    if (rawOrders.length === 0) {
        console.log(colors.red + "[Error] No events found. Check address/time." + colors.reset);
        return;
    }

    console.log(colors.green + `[Success] Processing ${rawOrders.length} raw events...` + colors.reset);

    // --- ENRICHMENT LOGIC ---
    // Identify Tokens needed for Lookup
    const tokenIds = new Set();
    const processed = rawOrders.map(order => {
        const isMaker = order.maker.toLowerCase() === SYNTH_ADDRESS;
        tokenIds.add(order.makerAssetId);
        tokenIds.add(order.takerAssetId);
        return { raw: order, isMaker };
    });

    const uniqueTokens = Array.from(tokenIds).filter(x => x && x !== "0");
    console.log(colors.gray + `   ...resolving names for ${uniqueTokens.length} tokens...` + colors.reset);

    for (let i = 0; i < uniqueTokens.length; i++) {
        const id = String(uniqueTokens[i]);
        if (i % 10 === 0) process.stdout.write(colors.gray + `.` + colors.reset);
        try {
            await new Promise(r => setTimeout(r, 50));
            const resp = await api.get(`${GAMMA_API_URL}/markets`, { params: { clob_token_ids: id } });
            if (resp.data && Array.isArray(resp.data)) {
                resp.data.forEach(m => {
                    const tokens = JSON.parse(m.clobTokenIds || '[]');
                    const outcomes = JSON.parse(m.outcomes || '[]');
                    tokens.forEach((tokenId, index) => {
                        marketCache.set(String(tokenId), {
                            question: m.question,
                            outcome: outcomes[index] || 'Unknown'
                        });
                    });
                });
            }
        } catch (e) { }
    }
    console.log("");

    const finalData = processed.map(p => {
        const o = p.raw;
        let marketName = "Unknown";
        let outcomeName = "Unknown";
        let side = "UNKNOWN";

        const makerInfo = marketCache.get(String(o.makerAssetId));
        const takerInfo = marketCache.get(String(o.takerAssetId));

        let outcomeAmount, moneyAmount;

        // Logic: Whichever asset we found in Gamma is the Outcome Token. The other is Money (USDC).
        if (makerInfo) {
            // Maker gave Outcome (AssetId matches Gamma) -> SOLD
            outcomeAmount = parseFloat(o.makerAmountFilled) / 1e6;
            moneyAmount = parseFloat(o.takerAmountFilled) / 1e6;
            marketName = makerInfo.question;
            outcomeName = makerInfo.outcome;
            side = p.isMaker ? "SELL" : "BUY";
        } else if (takerInfo) {
            // Taker gave Outcome (AssetId matches Gamma) -> SOLD
            outcomeAmount = parseFloat(o.takerAmountFilled) / 1e6;
            moneyAmount = parseFloat(o.makerAmountFilled) / 1e6;
            marketName = takerInfo.question;
            outcomeName = takerInfo.outcome;
            side = p.isMaker ? "BUY" : "SELL";
        } else {
            return null;
        }

        const price = outcomeAmount > 0 ? moneyAmount / outcomeAmount : 0;

        return {
            timestamp: new Date(parseInt(o.timestamp) * 1000).toISOString(),
            type: "TRADE",
            side: side,
            market: marketName,
            outcome: outcomeName,
            size: outcomeAmount.toFixed(1),
            price: price.toFixed(3),
            value: moneyAmount.toFixed(2),
            hash: o.transactionHash
        };
    }).filter(x => x !== null);

    finalData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const historyDir = path.join(__dirname, 'history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir);
    const nowStr = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(historyDir, `synth_history_GRAPH_${nowStr}.csv`);

    const header = "timestamp,type,side,market,outcome,size,price,valueUSDC,hash";
    const rows = finalData.map(d => {
        const safeMarket = `"${d.market.replace(/"/g, '""')}"`;
        const safeOutcome = `"${d.outcome.replace(/"/g, '""')}"`;
        return `${d.timestamp},${d.type},${d.side},${safeMarket},${safeOutcome},${d.size},${d.price},${d.value},${d.hash}`;
    });

    const csvContent = [header, ...rows].join('\n');
    fs.writeFileSync(filename, csvContent);
    console.log(colors.green + `[Done] Saved ${finalData.length} rows to ${filename}` + colors.reset);
}

fetchHistory();