const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

// --- CONFIGURATION ---
const TARGET_MARKET = "Bitcoin Up or Down - December 2, 3:00PM-3:15PM ET"; // Update this per market
// ---------------------

const colors = {
    reset: '\x1b[0m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', bold: '\x1b[1m'
};

function getLatestHistoryFile() {
    const historyDir = path.join(__dirname, 'history');
    if (!fs.existsSync(historyDir)) {
        console.error(colors.red + "[Error] History directory not found." + colors.reset);
        process.exit(1);
    }

    const files = fs.readdirSync(historyDir)
        .filter(f => f.startsWith('synth_history_FULL_') && f.endsWith('.csv'))
        // Sorts Z->A, so the latest ISO timestamp comes first
        .sort().reverse();

    if (files.length === 0) {
        console.error(colors.red + "[Error] No history CSV files found." + colors.reset);
        process.exit(1);
    }

    return path.join(historyDir, files[0]);
}

async function analyzeMarket() {
    // Dynamically get the latest file
    const latestFile = getLatestHistoryFile();
    console.log(colors.gray + `[System] Reading latest file: ${path.basename(latestFile)}` + colors.reset);

    const rows = [];

    fs.createReadStream(latestFile)
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', () => {
            processData(rows);
        });
}

function processData(rows) {
    console.log(colors.cyan + `\n[Analysis] Analyzing Market: "${TARGET_MARKET}"` + colors.reset);

    const marketRows = rows.filter(r => r.market === TARGET_MARKET);

    if (marketRows.length === 0) {
        console.log(colors.yellow + "No trades found for this market. Check exact spelling." + colors.reset);
        return;
    }

    // Sort by timestamp (Oldest -> Newest)
    marketRows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const outcomes = [...new Set(marketRows.map(r => r.outcome))];
    let marketNetCashFlow = 0;

    outcomes.forEach(outcome => {
        const outcomeRows = marketRows.filter(r => r.outcome === outcome);

        let sharesOwned = 0;
        let buyShares = 0;
        let buyCost = 0;
        let sellShares = 0;
        let sellValue = 0;
        let redeemValue = 0;

        outcomeRows.forEach(row => {
            const size = parseFloat(row.size);
            const value = parseFloat(row.valueUSDC);

            if (row.type === 'TRADE') {
                if (row.side === 'BUY') {
                    sharesOwned += size;
                    buyShares += size;
                    buyCost += value;
                } else if (row.side === 'SELL') {
                    // --- JIT INVENTORY FIX (Backfill Missing History) ---
                    if (sharesOwned < size) {
                        const missing = size - sharesOwned;
                        // Assume acquired at $0.50 mint cost
                        const impliedCost = missing * 0.50;

                        sharesOwned += missing;
                        buyShares += missing;
                        buyCost += impliedCost;
                    }
                    // ----------------------------------------------------

                    sharesOwned -= size;
                    sellShares += size;
                    sellValue += value;
                }
            }
            else if (row.type === 'SPLIT') {
                // SPLIT = MINTING
                sharesOwned += size;
                buyShares += size;
                buyCost += value;
            }
            else if (row.type === 'MERGE') {
                // MERGE = BURNING
                sharesOwned -= size;
                sellShares += size;
                sellValue += value;
            }
            else if (row.type === 'REDEEM') {
                // FIX: Redemption clears all inventory
                sharesOwned = 0;
                redeemValue += value;
            }
        });

        const avgBuyPrice = buyShares > 0 ? buyCost / buyShares : 0;
        const avgSellPrice = sellShares > 0 ? sellValue / sellShares : 0;
        const netCashFlow = (sellValue + redeemValue) - buyCost;
        marketNetCashFlow += netCashFlow;

        console.log(colors.bold + `\nOutcome: [${outcome}]` + colors.reset);
        console.log(`  --------------------------------------------------`);
        console.log(`  Buys:      ${buyShares.toFixed(2).padStart(8)} shares  @ Avg $${avgBuyPrice.toFixed(3)}  (Cost: $${buyCost.toFixed(2)})`);
        console.log(`  Sells:     ${sellShares.toFixed(2).padStart(8)} shares  @ Avg $${avgSellPrice.toFixed(3)}  (Rev:  $${sellValue.toFixed(2)})`);

        if (redeemValue > 0) {
            console.log(colors.green + `  Redeems:   + $${redeemValue.toFixed(2)}` + colors.reset);
        } else {
            console.log(`  Redeems:   $0.00`);
        }

        const pnlColor = netCashFlow >= 0 ? colors.green : colors.red;
        console.log(`  --------------------------------------------------`);
        console.log(`  Net Cash Flow: ${pnlColor}$${netCashFlow.toFixed(2)}${colors.reset}`);
        console.log(`  (Implied Remaining Inventory from Window: ${sharesOwned.toFixed(2)} shares)`);
    });

    console.log(colors.bold + `\n==================================================` + colors.reset);
    const totalColor = marketNetCashFlow >= 0 ? colors.green : colors.red;
    console.log(`TOTAL MARKET PnL: ${totalColor}$${marketNetCashFlow.toFixed(2)}${colors.reset}`);
    console.log(colors.bold + `==================================================\n` + colors.reset);
}

try {
    require.resolve('csv-parser');
    analyzeMarket();
} catch (e) {
    console.log(colors.red + "[Error] Missing dependency 'csv-parser'" + colors.reset);
}