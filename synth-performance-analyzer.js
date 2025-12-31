const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const HISTORY_DIR = path.join(__dirname, 'history');
const OUTPUT_HTML = path.join(__dirname, 'synth-performance-dashboard.html');

function getLatestHistoryFile() {
    if (!fs.existsSync(HISTORY_DIR)) throw new Error(`Directory not found: ${HISTORY_DIR}`);
    const files = fs.readdirSync(HISTORY_DIR)
        .filter(f => f.startsWith('synth_history_FULL_') && f.endsWith('.csv'))
        .sort().reverse();
    if (!files.length) throw new Error('No history CSV files found.');
    return path.join(HISTORY_DIR, files[0]);
}

function extractMarketTags(marketName) {
    const name = marketName.toLowerCase();
    let asset = "Other";
    if (name.includes("bitcoin") || name.includes("btc")) asset = "BTC";
    else if (name.includes("ethereum") || name.includes("eth")) asset = "ETH";

    let suffix = "Other";
    const suffixMatch = marketName.match(/(\d+(?:AM|PM)\s+ET|Daily|Weekly)/i);
    if (suffixMatch) suffix = suffixMatch[1].toUpperCase();

    return { asset, suffix, clusterKey: `${asset} ${suffix}` };
}

function buildStats(validatedMarkets) {
    const assetStats = { BTC: 0, ETH: 0, Other: 0 };
    const clusterMap = new Map();
    const heatmapData = Array(7).fill(0).map(() => Array(24).fill(0));
    const equityCurve = [];
    let cumulative = 0;

    const chronological = [...validatedMarkets].sort((a, b) => new Date(a.lastActivity) - new Date(b.lastActivity));

    chronological.forEach(m => {
        cumulative += m.profit;
        equityCurve.push({ t: m.lastActivity, y: cumulative });

        const date = new Date(m.lastActivity);
        const day = date.getDay();
        const hour = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(date)) % 24;

        heatmapData[day][hour] += m.profit;

        const tags = extractMarketTags(m.name);
        if (!clusterMap.has(tags.clusterKey)) {
            clusterMap.set(tags.clusterKey, { name: tags.clusterKey, profit: 0, count: 0, wins: 0 });
        }
        const cluster = clusterMap.get(tags.clusterKey);
        cluster.profit += m.profit;
        cluster.count++;
        if (m.profit > 0) cluster.wins++;

        assetStats[tags.asset] = (assetStats[tags.asset] || 0) + m.profit;
    });

    return {
        equityCurve,
        assetStats,
        heatmapData,
        clusters: Array.from(clusterMap.values()).sort((a, b) => b.profit - a.profit)
    };
}

async function analyzePerformance() {
    try {
        const filePath = getLatestHistoryFile();
        const rawMarkets = new Map();
        const seenHashes = new Set();

        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                // RESTORED: Row processing logic
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
                const type = (row.type || "").toUpperCase();
                const side = (row.side || "").toUpperCase();

                // Logic to categorize entry vs exit
                if (side === 'BUY' || type === 'SPLIT') {
                    m.cashOut += val;
                    m.hasBuy = true;
                }
                if (side === 'SELL' || type === 'REDEEM' || type === 'MERGE') {
                    m.cashIn += val;
                    if (type === 'REDEEM' || type === 'MERGE') m.hasResolution = true;
                }

                if (new Date(row.timestamp) > new Date(m.lastActivity)) {
                    m.lastActivity = row.timestamp;
                }
            })
            .on('end', () => {
                // Filter for completed trades only
                const validated = Array.from(rawMarkets.values())
                    .filter(m => m.hasBuy && m.hasResolution)
                    .map(m => ({
                        ...m,
                        profit: m.cashIn - m.cashOut,
                        roi: ((m.cashIn - m.cashOut) / m.cashOut) * 100
                    }));

                if (validated.length === 0) {
                    console.log("\x1b[31m[Error] No completed trades found in the CSV.\x1b[0m");
                    return;
                }

                const stats = buildStats(validated);

                // 1. Generate the HTML Dashboard
                generateHtml(validated.reverse(), stats);
                console.log(`[Success] Dashboard: ${OUTPUT_HTML}`);

                // 2. Print the NEAT TERMINAL REPORT
                console.log("\n" + "=".repeat(60));
                console.log("       SYNTH SUFFIX CORRELATION REPORT");
                console.log("=".repeat(60));
                console.log("Cluster Name         | Trades | Win %  | P&L (USDC)");
                console.log("-".repeat(60));

                stats.clusters.forEach(c => {
                    const imbalanced = m.cashIn > (m.cashOut * 2) && m.cashIn > 100;
                    if (imbalanced) {
                        console.log(`\x1b[33m[Warning] Possible Missing Cost Basis: ${m.name}`);
                        console.log(`          In: $${m.cashIn.toFixed(2)} | Out: $${m.cashOut.toFixed(2)}\x1b[0m`);
                    }

                    const name = c.name.padEnd(20);
                    const trades = String(c.count).padEnd(6);
                    const winRate = ((c.wins / c.count) * 100).toFixed(1).padStart(5) + "%";
                    const pnl = (c.profit >= 0 ? "+" : "") + c.profit.toFixed(2).padStart(10);

                    const color = c.profit >= 0 ? '\x1b[32m' : '\x1b[31m';
                    console.log(`${name} | ${trades} | ${winRate} | ${color}${pnl}\x1b[0m`);
                });
                console.log("=".repeat(60));
            });
    } catch (err) {
        console.error(`[Error] ${err.message}`);
    }
}

function generateHtml(data, stats) {
    const clusterRows = stats.clusters.map(c => `
        <tr>
            <td><strong>${c.name}</strong></td>
            <td>${c.count}</td>
            <td>${((c.wins / c.count) * 100).toFixed(1)}%</td>
            <td class="${c.profit >= 0 ? 'pos' : 'neg'}">$${c.profit.toFixed(2)}</td>
        </tr>
    `).join('');

    const marketRows = data.map(m => `
        <tr class="market-row" data-profit="${m.profit}">
            <td>${m.name}</td>
            <td class="${m.profit >= 0 ? 'pos' : 'neg'}">$${m.profit.toFixed(2)}</td>
            <td>${m.roi.toFixed(1)}%</td>
            <td>$${m.cashOut.toFixed(2)}</td>
            <td>${new Date(m.lastActivity).toLocaleDateString()}</td>
        </tr>
    `).join('');

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Synth Diagnostic</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
        <style>
            body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; }
            .top-grid { display: grid; grid-template-columns: 3fr 1fr; gap: 20px; margin-bottom: 20px; align-items: stretch; }
            .centered-grid { display: flex; flex-direction: column; align-items: center; gap: 20px; margin-bottom: 20px; }
            .wide-card { width: 100%; max-width: 1000px; }
            .card { background: #1e293b; padding: 15px; border-radius: 12px; border: 1px solid #334155; }
            .heatmap { display: grid; grid-template-columns: 50px repeat(24, 1fr); gap: 2px; margin-top: 10px; }
            .hm-cell { height: 20px; border-radius: 2px; }
            .hm-label { font-size: 10px; color: #94a3b8; text-align: center; display: flex; align-items: center; justify-content: center; }
            .chart-wrap { position: relative; height: 180px; width: 100%; margin: 0 auto; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.85rem; }
            th, td { padding: 10px; text-align: left; border-bottom: 1px solid #334155; }
            th { background: #334155; color: #38bdf8; position: sticky; top: 0; }
            .pos { color: #4ade80; } .neg { color: #f87171; }
            .controls { display: flex; gap: 20px; margin-bottom: 20px; background: #1e293b; padding: 15px; border-radius: 12px; align-items: center; }
            input { background: #0f172a; border: 1px solid #475569; color: white; padding: 8px; border-radius: 6px; }
            h2 { font-size: 0.9rem; margin-top: 0; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
        </style>
    </head>
    <body>
        <div class="top-grid">
            <div class="card">
                <h2>Cumulative P&L</h2>
                <div style="height:250px"><canvas id="equityChart"></canvas></div>
            </div>
            <div class="card">
                <h2>Asset Split</h2>
                <div class="chart-wrap"><canvas id="assetChart"></canvas></div>
            </div>
        </div>

        <div class="centered-grid">
            <div class="card wide-card">
                <h2>7-Day Hourly Heatmap (ET)</h2>
                <div class="heatmap">
                    <div></div>${Array.from({ length: 24 }, (_, i) => `<div class="hm-label">${i}</div>`).join('')}
                    ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, dIdx) => `
                        <div class="hm-label">${day}</div>
                        ${stats.heatmapData[dIdx].map(v => {
        let opacity = Math.min(Math.abs(v) / 300, 1);
        let color = v > 0 ? 'rgba(74, 222, 128,' + opacity + ')' : v < 0 ? 'rgba(248, 113, 113,' + opacity + ')' : '#334155';
        return '<div class="hm-cell" style="background:' + color + '" title="$' + v.toFixed(2) + '"></div>';
    }).join('')}
                    `).join('')}
                </div>
            </div>

            <div class="card wide-card">
                <h2>Suffix Correlation</h2>
                <table>
                    <thead><tr><th>Cluster</th><th>Trades</th><th>Win %</th><th>P&L</th></tr></thead>
                    <tbody>${clusterRows}</tbody>
                </table>
            </div>
        </div>

        <div class="controls">
            <label style="color:#94a3b8">Filters:</label>
            <input type="text" id="search" placeholder="Search markets..." onkeyup="filterTable()">
            <input type="number" id="minProfit" placeholder="Min Profit ($)" onkeyup="filterTable()">
        </div>

        <div class="card">
            <table id="mTable">
                <thead><tr><th>Market</th><th>Profit</th><th>ROI</th><th>Invested</th><th>Date</th></tr></thead>
                <tbody>${marketRows}</tbody>
            </table>
        </div>

        <script>
            const stats = ${JSON.stringify(stats)};
            new Chart(document.getElementById('equityChart'), {
                type: 'line',
                data: { datasets: [{ 
                    data: stats.equityCurve.map(p => ({ x: p.t, y: p.y })), 
                    borderColor: '#38bdf8', 
                    fill: true, pointRadius: 0, tension: 0.2 
                }] },
                options: { 
                    maintainAspectRatio: false, 
                    scales: { x: { type: 'time', time: { unit: 'day' }, grid: { color: '#334155' } }, y: { grid: { color: '#334155' } } }, 
                    plugins: { legend: { display: false } } 
                }
            });

            new Chart(document.getElementById('assetChart'), {
                type: 'doughnut',
                data: { 
                    labels: ['BTC', 'ETH', 'Other'], 
                    datasets: [{ 
                        data: [stats.assetStats.BTC, stats.assetStats.ETH, stats.assetStats.Other], 
                        backgroundColor: ['#f59e0b','#6366f1','#94a3b8'], 
                        borderWidth: 0 
                    }] 
                },
                options: { 
                    maintainAspectRatio: true, aspectRatio: 1,
                    plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', boxWidth: 10, font: { size: 10 } } } }
                }
            });

            function filterTable() {
                const query = document.getElementById('search').value.toLowerCase();
                const min = parseFloat(document.getElementById('minProfit').value) || -Infinity;
                document.querySelectorAll('.market-row').forEach(row => {
                    const text = row.innerText.toLowerCase();
                    const profit = parseFloat(row.dataset.profit);
                    row.style.display = (text.includes(query) && profit >= min) ? "" : "none";
                });
            }
        </script>
    </body>
    </html>`;
    fs.writeFileSync(OUTPUT_HTML, html);
}

analyzePerformance();