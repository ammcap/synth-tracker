const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

// CONFIG
const HISTORY_DIR = path.join(__dirname, 'history');
const OUTPUT_HTML = path.join(__dirname, 'synth-performance-dashboard.html');

/**
 * Finds the most recent history CSV file in the history directory.
 */
function getLatestHistoryFile() {
    if (!fs.existsSync(HISTORY_DIR)) throw new Error(`Directory not found: ${HISTORY_DIR}`);
    const files = fs.readdirSync(HISTORY_DIR)
        .filter(f => f.startsWith('synth_history_FULL_') && f.endsWith('.csv'))
        .sort().reverse();
    if (!files.length) throw new Error('No history CSV files found in /history folder.');
    return path.join(HISTORY_DIR, files[0]);
}

/**
 * Aggregates data for the Chart.js visualizations.
 */
function buildStats(validatedMarkets) {
    const hourlyStats = Array(24).fill(0);
    const assetStats = { BTC: 0, ETH: 0, Other: 0 };
    let cumulative = 0;
    const equityCurve = [];

    // Sort chronologically for the equity curve
    const chronological = [...validatedMarkets].sort((a, b) => new Date(a.lastActivity) - new Date(b.lastActivity));

    chronological.forEach(m => {
        cumulative += m.profit;
        equityCurve.push({ t: m.lastActivity, y: cumulative });

        // Hourly Stats (Adjusting to ET)
        const date = new Date(m.lastActivity);
        const etHour = parseInt(new Intl.DateTimeFormat('en-US', { 
            hour: 'numeric', hour12: false, timeZone: 'America/New_York' 
        }).format(date)) % 24;
        hourlyStats[etHour] += m.profit;

        // Asset Stats
        const lowerName = m.name.toLowerCase();
        if (lowerName.includes('bitcoin') || lowerName.includes('btc')) assetStats.BTC += m.profit;
        else if (lowerName.includes('ethereum') || lowerName.includes('eth')) assetStats.ETH += m.profit;
        else assetStats.Other += m.profit;
    });

    return { equityCurve, hourlyStats, assetStats };
}

async function analyzePerformance() {
    console.log('--- Synth Performance Visualizer (Strict Mode) ---');
    try {
        const filePath = getLatestHistoryFile();
        console.log(`[Step 1] Processing: ${path.basename(filePath)}`);
        
        const rawMarkets = new Map();
        const seenHashes = new Set(); 

        return new Promise((resolve, reject) => {
            fs.createReadStream(filePath)
                .on('error', reject)
                .pipe(csv())
                .on('data', (row) => {
                    // 1. PREVENT DOUBLE COUNTING: Skip duplicate transaction hashes
                    if (seenHashes.has(row.hash)) return;
                    seenHashes.add(row.hash);

                    const name = row.market;
                    if (!name || name === "Unknown") return;

                    if (!rawMarkets.has(name)) {
                        rawMarkets.set(name, { 
                            name, cashIn: 0, cashOut: 0, 
                            hasBuy: false, hasResolution: false,
                            lastActivity: row.timestamp 
                        });
                    }

                    const m = rawMarkets.get(name);
                    const val = parseFloat(row.valueUSDC) || 0;
                    const type = (row.type || '').toUpperCase();
                    const side = (row.side || '').toUpperCase();

                    // Logic: Buys/Splits are costs. Sells/Redeems are returns.
                    if (side === 'BUY' || type === 'SPLIT') {
                        m.cashOut += val;
                        m.hasBuy = true; 
                    }
                    if (side === 'SELL' || type === 'REDEEM' || type === 'MERGE') {
                        m.cashIn += val;
                        if (type === 'REDEEM' || type === 'MERGE') m.hasResolution = true;
                    }
                    
                    if (new Date(row.timestamp) > new Date(m.lastActivity)) m.lastActivity = row.timestamp;
                })
                .on('end', () => {
                    // 2. STRICT FILTERING: Only include markets with both an entry and an exit
                    const validatedMarkets = Array.from(rawMarkets.values())
                        .filter(m => m.hasBuy && m.hasResolution)
                        .map(m => ({
                            ...m,
                            profit: m.cashIn - m.cashOut,
                            roi: ((m.cashIn - m.cashOut) / m.cashOut) * 100
                        }));

                    const stats = buildStats(validatedMarkets);
                    generateHtml(validatedMarkets.reverse(), stats);
                    
                    console.log(`[Step 2] Markets in CSV: ${rawMarkets.size}`);
                    console.log(`[Step 3] Markets with full entry/exit: ${validatedMarkets.length}`);
                    console.log(`[Success] Dashboard: ${OUTPUT_HTML}`);
                    resolve();
                });
        });
    } catch (err) { console.error(`[Error] ${err.message}`); }
}

function generateHtml(data, stats) {
    const tableRows = data.map(m => `
        <tr class="market-row resolved" data-profit="${m.profit}" data-resolved="true">
            <td>${m.name}</td>
            <td class="profit-cell ${m.profit >= 0 ? 'pos' : 'neg'}">$${m.profit.toFixed(2)}</td>
            <td>${m.roi.toFixed(1)}%</td>
            <td>$${m.cashOut.toFixed(2)}</td>
            <td>✅ Resolved</td>
            <td>${new Date(m.lastActivity).toLocaleString()}</td>
        </tr>
    `).join('');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Synth Visual Performance</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <style>
            body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; padding: 30px; }
            .grid { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 20px; margin-bottom: 30px; }
            .chart-card { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; height: 300px; }
            .controls { background: #1e293b; padding: 20px; border-radius: 12px; display: flex; gap: 20px; margin-bottom: 20px; align-items: center; border: 1px solid #334155; }
            table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
            th, td { padding: 15px; text-align: left; border-bottom: 1px solid #334155; }
            th { background: #334155; color: #38bdf8; cursor: pointer; }
            .pos { color: #4ade80; } .neg { color: #f87171; }
            input { background: #0f172a; border: 1px solid #475569; color: white; padding: 8px; border-radius: 6px; }
        </style>
    </head>
    <body>
        <h1>Synth Strategy Insights (Strict Mode)</h1>
        <div class="grid">
            <div class="chart-card"><canvas id="equityChart"></canvas></div>
            <div class="chart-card"><canvas id="hourlyChart"></canvas></div>
            <div class="chart-card"><canvas id="assetChart"></canvas></div>
        </div>
        <div class="controls">
            <input type="text" id="search" placeholder="Search markets..." onkeyup="filterTable()">
            <span id="row-count"></span>
        </div>
        <table id="mTable">
            <thead>
                <tr>
                    <th onclick="sortTable(0)">Market</th>
                    <th onclick="sortTable(1)">Net Profit</th>
                    <th onclick="sortTable(2)">ROI</th>
                    <th onclick="sortTable(3)">Invested</th>
                    <th onclick="sortTable(4)">Status</th>
                    <th onclick="sortTable(5)">Last Seen</th>
                </tr>
            </thead>
            <tbody>${tableRows}</tbody>
        </table>
        <script>
            const stats = ${JSON.stringify(stats)};
            new Chart(document.getElementById('equityChart'), {
                type: 'line',
                data: {
                    datasets: [{
                        label: 'Cumulative P&L (USDC)',
                        data: stats.equityCurve.map(p => ({ x: p.t, y: p.y })),
                        borderColor: '#38bdf8',
                        backgroundColor: 'rgba(56, 189, 248, 0.1)',
                        fill: true,
                        tension: 0.3
                    }]
                },
                options: { maintainAspectRatio: false, scales: { x: { display: false } } }
            });
            new Chart(document.getElementById('hourlyChart'), {
                type: 'bar',
                data: {
                    labels: Array.from({length: 24}, (_, i) => i + ':00'),
                    datasets: [{
                        label: 'Profit by Hour (ET)',
                        data: stats.hourlyStats,
                        backgroundColor: stats.hourlyStats.map(v => v >= 0 ? '#4ade80' : '#f87171')
                    }]
                },
                options: { maintainAspectRatio: false }
            });
            new Chart(document.getElementById('assetChart'), {
                type: 'doughnut',
                data: {
                    labels: ['BTC', 'ETH', 'Other'],
                    datasets: [{
                        data: [stats.assetStats.BTC, stats.assetStats.ETH, stats.assetStats.Other],
                        backgroundColor: ['#f59e0b', '#6366f1', '#94a3b8']
                    }]
                },
                options: { maintainAspectRatio: false }
            });

            function filterTable() {
                const search = document.getElementById("search").value.toUpperCase();
                const rows = document.querySelectorAll(".market-row");
                rows.forEach(row => {
                    row.style.display = row.innerText.toUpperCase().includes(search) ? "" : "none";
                });
            }

            function sortTable(n) {
                const table = document.getElementById("mTable");
                const rows = Array.from(table.rows).slice(1);
                const asc = table.getAttribute("data-sort") !== "asc";
                rows.sort((a, b) => {
                    let valA = a.cells[n].innerText.replace('$', '').replace('%', '').replace('✅ ', '');
                    let valB = b.cells[n].innerText.replace('$', '').replace('%', '').replace('✅ ', '');
                    if (!isNaN(valA) && !isNaN(valB)) return asc ? (parseFloat(valA) - parseFloat(valB)) : (parseFloat(valB) - parseFloat(valA));
                    return asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
                });
                rows.forEach(row => table.tBodies[0].appendChild(row));
                table.setAttribute("data-sort", asc ? "asc" : "desc");
            }
        </script>
    </body>
    </html>`;
    fs.writeFileSync(OUTPUT_HTML, html);
}

analyzePerformance();