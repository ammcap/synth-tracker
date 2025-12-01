const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const SYNTH_ADDRESS = '0x557bed924a1bb6f62842c5742d1dc789b8d480d4'.toLowerCase();
const HOURS_TO_LOOK_BACK = 2;
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

// Axios instance with timeout to prevent hanging
const api = axios.create({
    timeout: 15000 // 15 seconds timeout
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
        const MAX_PAGES = 50;

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
                    console.log("Done.");
                    keepFetching = false;
                } else {
                    // --- MANUAL TIME FILTER ---
                    const freshData = [];
                    let reachedOldData = false;

                    for (const t of data) {
                        if (t.timestamp >= startTime) {
                            freshData.push(t);
                        } else {
                            reachedOldData = true;
                        }
                    }

                    console.log(`Found ${freshData.length} relevant items.`);
                    tradeList = tradeList.concat(freshData);

                    if (reachedOldData) {
                        console.log(colors.green + "      > Reached time limit. Stopping fetch." + colors.reset);
                        keepFetching = false;
                    } else {
                        offset += data.length;
                        page++;
                        if (data.length < limit) keepFetching = false;
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

        while (keepFetching && page <= 10) {
            try {
                const response = await api.get(`${DATA_API_URL}/activity`, {
                    params: {
                        user: SYNTH_ADDRESS,
                        limit: 100,
                        offset: offset,
                        type: 'REDEEM'
                    }
                });

                const data = response.data;
                if (Array.isArray(data) && data.length > 0) {
                    // --- MANUAL TIME FILTER ---
                    const freshRedeems = [];
                    let reachedOldData = false;

                    for (const r of data) {
                        if (r.timestamp >= startTime) {
                            freshRedeems.push(r);
                        } else {
                            reachedOldData = true;
                        }
                    }

                    redeemList = redeemList.concat(freshRedeems);

                    if (reachedOldData) {
                        keepFetching = false;
                    } else {
                        offset += data.length;
                        if (data.length < 100) keepFetching = false;
                        page++;
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
            // UPDATED: Check conditionId/market first for redeems, as they are often not 'asset'
            asset: r.conditionId || r.market || r.asset,
            side: 'REDEEM',
            size: parseFloat(r.size),
            price: 1.00,
            amountUSDC: parseFloat(r.amount) || parseFloat(r.size),
            hash: r.transactionHash || r.hash || 'undefined'
        }));
    }

    // 2. Execute Fetches Sequentially
    const trades = await getTrades();
    const redeems = await getRedeems();

    // Combine
    const merged = [...trades, ...redeems];

    if (merged.length === 0) {
        console.log(colors.red + "[Error] Still no activity found. Double check the address or time range." + colors.reset);
        return;
    }

    console.log(colors.green + `[Success] Found ${merged.length} events (${trades.length} trades, ${redeems.length} redeems). Enriching...` + colors.reset);

    // 3. Enrich with Market Data (SERIAL MODE - 1 by 1)
    const tokenIds = new Set(merged.map(x => x.asset));
    // Filter out undefined assets
    const uniqueTokens = Array.from(tokenIds).filter(x => x);

    console.log(colors.gray + `   ...resolving names for ${uniqueTokens.length} items (One-by-One)...` + colors.reset);

    let successCount = 0;

    for (let i = 0; i < uniqueTokens.length; i++) {
        const id = String(uniqueTokens[i]);

        // Progress indicator
        if (i % 5 === 0) process.stdout.write(colors.gray + `.` + colors.reset);

        try {
            // Small delay to be polite
            await new Promise(r => setTimeout(r, 100));

            // Determine if it's a Condition ID (Redeem) or Token ID (Trade)
            let params = {};
            if (id.startsWith('0x')) {
                // Hex strings are Condition IDs (Markets)
                params = { condition_ids: id };
            } else {
                // Numeric strings are Clob Token IDs (Outcomes)
                params = { clob_token_ids: id };
            }

            const resp = await api.get(`${GAMMA_API_URL}/markets`, { params });

            if (resp.data && Array.isArray(resp.data)) {
                resp.data.forEach(m => {
                    // Cache by Condition ID (for Redeems)
                    if (m.conditionId) {
                        marketCache.set(m.conditionId, {
                            question: m.question,
                            outcome: "Winning Position" // Redeems imply the winner
                        });
                    }

                    // Cache by Token IDs (for Trades)
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
            // Only log if it's NOT a 404 (which just means data is missing)
            if (e.response && e.response.status !== 404) {
                console.log(colors.yellow + `\n   [Warning] ID ${id} failed (${e.response ? e.response.status : e.message})` + colors.reset);
            }
        }
    }
    console.log(colors.gray + `\n   Resolved ${successCount}/${uniqueTokens.length} items.` + colors.reset);

    // 4. Sort and Format
    merged.sort((a, b) => b.timestamp - a.timestamp);

    const finalData = merged.map(item => {
        // Ensure lookup uses string key
        const info = marketCache.get(String(item.asset));

        let marketName = "Unknown Market";
        let outcomeName = "Unknown";

        if (info) {
            marketName = info.question;
            outcomeName = info.outcome;
        } else {
            marketName = `Unknown (${item.asset})`;
        }

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

    // 5. Save to File (CSV Format)
    const historyDir = path.join(__dirname, 'history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir);
    const nowStr = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(historyDir, `synth_history_DUAL_${nowStr}.csv`);

    // CSV Header
    const header = "timestamp,type,side,market,outcome,size,price,valueUSDC,hash";

    // CSV Rows
    const rows = finalData.map(d => {
        // Escape quotes in text fields to prevent CSV breakage
        const safeMarket = `"${d.market.replace(/"/g, '""')}"`;
        const safeOutcome = `"${d.outcome.replace(/"/g, '""')}"`;
        return `${d.timestamp},${d.type},${d.side},${safeMarket},${safeOutcome},${d.size},${d.price},${d.value},${d.hash}`;
    });

    const csvContent = [header, ...rows].join('\n');

    fs.writeFileSync(filename, csvContent);
    console.log(colors.green + `[Done] Saved to ${filename}` + colors.reset);

    // Preview
    console.log("\n--- LATEST 5 EVENTS ---");
    finalData.slice(0, 5).forEach(d => {
        const color = d.side === 'BUY' ? colors.green : (d.side === 'REDEEM' ? colors.yellow : colors.red);
        console.log(`${d.timestamp} | ${color}${d.side.padEnd(6)}${colors.reset} | ${d.size} sh @ $${d.price} | ${d.market.substring(0, 40)}...`);
    });
}

fetchHistory();