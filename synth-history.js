const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const SYNTH_ADDRESS = '0x557bed924a1bb6f62842c5742d1dc789b8d480d4'.toLowerCase();
const HOURS_TO_LOOK_BACK = 1;
const DATA_API_URL = 'https://data-api.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// ANSI Colors
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    gray: '\x1b[90m'
};

// Axios instance with timeout
const api = axios.create({
    timeout: 15000
});

async function fetchHistory() {
    console.log(colors.cyan + `[History] Fetching history for Synth (${HOURS_TO_LOOK_BACK} hours ago)...` + colors.reset);

    // 1. Calculate Timestamps
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - (HOURS_TO_LOOK_BACK * 60 * 60);

    const marketCache = new Map();

    // --- HELPER: Fetch Trades (The "Buy/Sell" actions) ---
    async function getTrades() {
        console.log(colors.gray + "   ...querying CLOB trades..." + colors.reset);
        let tradeList = [];
        let offset = 0;
        const limit = 500;
        let keepFetching = true;
        let page = 1;
        const MAX_PAGES = 100; // Increased safety limit

        while (keepFetching && page <= MAX_PAGES) {
            try {
                process.stdout.write(colors.gray + `      > Fetching page ${page} (offset ${offset})... ` + colors.reset);

                const response = await api.get(`${DATA_API_URL}/trades`, {
                    params: {
                        user: SYNTH_ADDRESS,
                        limit: limit,
                        offset: offset
                    }
                });

                const data = response.data;
                if (!Array.isArray(data) || data.length === 0) {
                    console.log("Done (Empty).");
                    keepFetching = false;
                } else {
                    // Filter this batch for valid time range
                    const freshData = data.filter(t => t.timestamp >= startTime);

                    console.log(`Found ${freshData.length} relevant items.`);
                    tradeList = tradeList.concat(freshData);

                    // LOGIC FIX:
                    // Only stop if the LAST item in the batch is older than our start time.
                    // This handles cases where data inside the batch is slightly out of order.
                    const lastItem = data[data.length - 1];
                    const lastTimestamp = lastItem.timestamp;

                    if (lastTimestamp < startTime) {
                        console.log(colors.green + "      > Reached time limit (Last item too old). Stopping fetch." + colors.reset);
                        keepFetching = false;
                    } else {
                        // If we got fewer items than the limit, we reached the end of all data
                        if (data.length < limit) {
                            console.log("Done (End of data).");
                            keepFetching = false;
                        } else {
                            // Otherwise, keep digging
                            offset += data.length;
                            page++;
                        }
                    }
                }
            } catch (e) {
                console.log(colors.yellow + `\n      [Trades] Page ${page} failed: ${e.message}` + colors.reset);
                keepFetching = false;
            }
        }

        return tradeList.map(t => ({
            type: 'TRADE',
            timestamp: t.timestamp,
            asset: t.asset,
            side: t.side,
            size: parseFloat(t.size),
            price: parseFloat(t.price),
            amountUSDC: parseFloat(t.size) * parseFloat(t.price),
            hash: t.transactionHash || t.transaction_hash || t.hash || 'undefined'
        }));
    }

    // --- HELPER: Fetch Redeems (The "Claim Winnings" actions) ---
    async function getRedeems() {
        console.log(colors.gray + "   ...querying on-chain redemptions..." + colors.reset);
        let redeemList = [];
        let offset = 0;
        let keepFetching = true;
        let page = 1;
        const limit = 100;

        while (keepFetching && page <= 20) {
            try {
                const response = await api.get(`${DATA_API_URL}/activity`, {
                    params: {
                        user: SYNTH_ADDRESS,
                        limit: limit,
                        offset: offset,
                        type: 'REDEEM'
                    }
                });

                const data = response.data;
                if (Array.isArray(data) && data.length > 0) {
                    // Filter relevant items
                    const freshRedeems = data.filter(r => r.timestamp >= startTime);
                    redeemList = redeemList.concat(freshRedeems);

                    // LOGIC FIX: Same check as above
                    const lastItem = data[data.length - 1];
                    if (lastItem.timestamp < startTime) {
                        keepFetching = false;
                    } else {
                        if (data.length < limit) keepFetching = false;
                        else {
                            offset += data.length;
                            page++;
                        }
                    }
                } else {
                    keepFetching = false;
                }
            } catch (e) {
                console.log(colors.yellow + `      [Redeems] Request failed: ${e.message}` + colors.reset);
                keepFetching = false;
            }
        }

        return redeemList.map(r => ({
            type: 'REDEEM',
            timestamp: r.timestamp,
            asset: r.conditionId || r.market || r.asset,
            side: 'REDEEM',
            size: parseFloat(r.size),
            price: 1.00,
            amountUSDC: parseFloat(r.amount) || parseFloat(r.size),
            hash: r.transactionHash || r.hash || 'undefined'
        }));
    }

    // 2. Execute Fetches
    const trades = await getTrades();
    const redeems = await getRedeems();

    const merged = [...trades, ...redeems];

    if (merged.length === 0) {
        console.log(colors.red + "[Error] Still no activity found. Double check the address or time range." + colors.reset);
        return;
    }

    console.log(colors.green + `[Success] Found ${merged.length} events (${trades.length} trades, ${redeems.length} redeems). Enriching...` + colors.reset);

    // 3. Enrich with Market Data
    const tokenIds = new Set(merged.map(x => x.asset));
    const uniqueTokens = Array.from(tokenIds).filter(x => x);

    console.log(colors.gray + `   ...resolving names for ${uniqueTokens.length} items (One-by-One)...` + colors.reset);

    let successCount = 0;

    for (let i = 0; i < uniqueTokens.length; i++) {
        const id = String(uniqueTokens[i]);
        if (i % 5 === 0) process.stdout.write(colors.gray + `.` + colors.reset);

        try {
            await new Promise(r => setTimeout(r, 100)); // Rate limit protection

            let params = {};
            if (id.startsWith('0x')) {
                params = { condition_ids: id };
            } else {
                params = { clob_token_ids: id };
            }

            const resp = await api.get(`${GAMMA_API_URL}/markets`, { params });

            if (resp.data && Array.isArray(resp.data)) {
                resp.data.forEach(m => {
                    if (m.conditionId) {
                        marketCache.set(m.conditionId, {
                            question: m.question,
                            outcome: "Winning Position"
                        });
                    }
                    const tokens = JSON.parse(m.clobTokenIds || '[]');
                    const outcomes = JSON.parse(m.outcomes || '[]');
                    tokens.forEach((tokenId, index) => {
                        marketCache.set(String(tokenId), {
                            question: m.question,
                            outcome: outcomes[index] || 'Unknown'
                        });
                    });
                });
                successCount++;
            }
        } catch (e) {
            if (e.response && e.response.status !== 404) {
                console.log(colors.yellow + `\n   [Warning] ID ${id} failed` + colors.reset);
            }
        }
    }
    console.log(colors.gray + `\n   Resolved ${successCount}/${uniqueTokens.length} items.` + colors.reset);

    // 4. Sort and Format
    merged.sort((a, b) => b.timestamp - a.timestamp);

    const finalData = merged.map(item => {
        const info = marketCache.get(String(item.asset));
        let marketName = info ? info.question : `Unknown (${item.asset})`;
        let outcomeName = info ? info.outcome : "Unknown";

        return {
            timestamp: new Date(item.timestamp * 1000).toISOString(),
            type: item.type,
            side: item.side,
            market: marketName,
            outcome: outcomeName,
            size: item.size.toFixed(1),
            price: item.price.toFixed(3),
            value: item.amountUSDC.toFixed(2),
            hash: item.hash
        };
    });

    // 5. Save to File
    const historyDir = path.join(__dirname, 'history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir);
    const nowStr = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(historyDir, `synth_history_FIXED_${nowStr}.csv`);

    const header = "timestamp,type,side,market,outcome,size,price,valueUSDC,hash";
    const rows = finalData.map(d => {
        const safeMarket = `"${d.market.replace(/"/g, '""')}"`;
        const safeOutcome = `"${d.outcome.replace(/"/g, '""')}"`;
        return `${d.timestamp},${d.type},${d.side},${safeMarket},${safeOutcome},${d.size},${d.price},${d.value},${d.hash}`;
    });

    const csvContent = [header, ...rows].join('\n');
    fs.writeFileSync(filename, csvContent);
    console.log(colors.green + `[Done] Saved to ${filename}` + colors.reset);
}

fetchHistory();