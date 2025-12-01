const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
// Paste the exact market name you want to analyze here:
const TARGET_MARKET = "Bitcoin Up or Down - November 30, 10:45PM-11:00PM ET";

// ANSI Colors
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m',
    gray: '\x1b[90m'
};

function parseCSVLine(text) {
    // Robust CSV parser that handles quoted commas
    const result = [];
    let curr = '';
    let inQuote = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            // Handle escaped quotes ("") inside quotes
            if (inQuote && text[i + 1] === '"') {
                curr += '"';
                i++;
            } else {
                inQuote = !inQuote;
            }
        } else if (char === ',' && !inQuote) {
            result.push(curr);
            curr = '';
        } else {
            curr += char;
        }
    }
    result.push(curr);
    return result;
}

function analyze() {
    const historyDir = path.join(__dirname, 'history');

    // 1. Find the latest CSV file
    if (!fs.existsSync(historyDir)) {
        console.log(colors.red + "No 'history' folder found. Run synth-history.js first." + colors.reset);
        return;
    }

    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.csv'));
    if (files.length === 0) {
        console.log(colors.red + "No CSV files found in 'history' folder." + colors.reset);
        return;
    }

    // Sort by time (newest last) so we pick the last one
    files.sort((a, b) => {
        return fs.statSync(path.join(historyDir, a)).mtime.getTime() -
            fs.statSync(path.join(historyDir, b)).mtime.getTime();
    });

    const latestFile = files[files.length - 1];
    const filePath = path.join(historyDir, latestFile);
    console.log(colors.gray + `Analyzing file: ${latestFile}` + colors.reset);

    // 2. Read and Parse CSV
    const content = fs.readFileSync(filePath, 'utf8');
    // Remove empty lines
    const lines = content.split('\n').filter(l => l.trim() !== '');

    // Parse all lines
    const allRows = lines.slice(1).map(parseCSVLine); // Skip header

    // 3. Filter for Target Market
    // Columns: timestamp, type, side, market, outcome, size, price, valueUSDC, hash
    let trades = [];

    for (const cols of allRows) {
        if (cols.length < 8) continue;
        const market = cols[3];
        if (market === TARGET_MARKET) {
            trades.push({
                timestamp: cols[0],
                type: cols[1],
                side: cols[2],
                market: cols[3],
                size: parseFloat(cols[5]),
                price: parseFloat(cols[6]),
                value: parseFloat(cols[7])
            });
        }
    }

    if (trades.length === 0) {
        console.log(colors.yellow + "No trades found for this market." + colors.reset);
        return;
    }

    // 4. Sort Oldest to Newest for chronological PnL calculation
    trades.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // 5. Run Logic (Weighted Average Cost Basis)
    let holdings = 0;
    let totalCostBasis = 0; // Total $ spent on *current* holdings
    let totalRealizedPnL = 0;
    let totalSpent = 0;
    let totalRevenue = 0;

    console.log(`\n${colors.cyan}--- Detailed Ledger for: "${TARGET_MARKET}" ---${colors.reset}`);
    console.log(`Type    | Side   | Size      | Price  | Value ($) | Trade PnL | Avg Buy Price`);
    console.log(`-------------------------------------------------------------------------------`);

    trades.forEach(t => {
        let displayColor = colors.reset;
        let pnlText = "-";
        let avgPriceText = "-";

        if (t.side === 'BUY') {
            displayColor = colors.green;
            totalSpent += t.value;

            // Update Average Cost
            totalCostBasis += t.value;
            holdings += t.size;

            const avgPrice = holdings > 0 ? (totalCostBasis / holdings) : 0;
            avgPriceText = `$${avgPrice.toFixed(3)}`;

        } else if (t.side === 'SELL' || t.side === 'REDEEM') {
            displayColor = t.side === 'REDEEM' ? colors.yellow : colors.red;
            totalRevenue += t.value;

            // Calculate Realized PnL for this specific chunk
            const avgPrice = holdings > 0 ? (totalCostBasis / holdings) : 0;
            const costOfTheseShares = t.size * avgPrice;
            const tradePnL = t.value - costOfTheseShares;

            totalRealizedPnL += tradePnL;

            // Reduce holdings and cost basis proportionally
            totalCostBasis -= costOfTheseShares;
            holdings -= t.size;

            // Handle tiny floating point errors near zero
            if (Math.abs(holdings) < 0.001) {
                holdings = 0;
                totalCostBasis = 0;
            }

            const tradePnLColor = tradePnL >= 0 ? colors.green : colors.red;
            pnlText = `${tradePnLColor}$${tradePnL.toFixed(2)}${displayColor}`;
            avgPriceText = `$${avgPrice.toFixed(3)}`;
        }

        console.log(
            `${displayColor}${t.type.padEnd(7)} | ${t.side.padEnd(6)} | ${t.size.toFixed(1).padEnd(9)} | $${t.price.toFixed(3)} | $${t.value.toFixed(2).padEnd(8)} | ${pnlText.padEnd(19)} | ${colors.gray}${avgPriceText}${colors.reset}`
        );
    });

    // 6. Summary
    const netCashFlow = totalRevenue - totalSpent;
    const netColor = netCashFlow >= 0 ? colors.green : colors.red;
    const realizedColor = totalRealizedPnL >= 0 ? colors.green : colors.red;

    console.log(`\n${colors.bold}--- PERFORMANCE SUMMARY ---${colors.reset}`);
    console.log(`Total Spent (Buys):         $${totalSpent.toFixed(2)}`);
    console.log(`Total Returned (Sell/Redeem): $${totalRevenue.toFixed(2)}`);
    console.log(`Net Cash Flow:              ${netColor}$${netCashFlow.toFixed(2)}${colors.reset}`);
    console.log(`-----------------------------------`);
    console.log(`Realized PnL (Closed Trades): ${realizedColor}$${totalRealizedPnL.toFixed(2)}${colors.reset}`);
    console.log(`Remaining Position:           ${holdings.toFixed(1)} shares`);

    if (holdings > 0) {
        console.log(`${colors.gray}(Note: Net Cash Flow includes the cost of shares you still hold. Realized PnL is profit purely from sold/redeemed shares.)${colors.reset}`);
    }
}

analyze();