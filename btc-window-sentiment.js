const fs = require('fs');
const path = require('path');
const axios = require('axios');
const csv = require('csv-parser');

// CONFIG
const MARKET_KEYWORD = (process.env.MARKET_KEYWORD || 'bitcoin').toLowerCase();
const HISTORY_DIR = path.join(__dirname, 'history');
const OUTPUT_FILE = path.join(__dirname, 'btc_window_sentiment.csv');
const OUTPUT_HTML = path.join(__dirname, 'btc_window_sentiment.html');
const PRICE_PADDING_MINUTES = 60;
const ALLOWED_WINDOW_MINUTES = [60, 240];
const WALLET_ADDRESS = (process.env.WALLET_ADDRESS || '0x557bed924a1bb6f62842c5742d1dc789b8d480d4').toLowerCase();
const DAYS_BACK = Number(process.env.DAYS_BACK || 1);

// APIs
const ORDERBOOK_URL = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range';

const LOOKBACK_MS = DAYS_BACK * 24 * 60 * 60 * 1000;

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    gray: '\x1b[90m'
};

const log = {
    info: (msg) => console.log(colors.cyan + '[Info] ' + colors.reset + msg),
    warn: (msg) => console.log(colors.yellow + '[Warn] ' + colors.reset + msg),
    error: (msg) => console.log(colors.red + '[Error] ' + colors.reset + msg),
    debug: (msg) => console.log(colors.gray + '[Debug] ' + colors.reset + msg)
};

const ET_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit'
});

const ET_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
});

const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric'
});

function listHistoryFiles() {
    if (!fs.existsSync(HISTORY_DIR)) return [];
    return fs.readdirSync(HISTORY_DIR)
        .filter(name => name.startsWith('synth_history_FULL_') && name.endsWith('.csv'))
        .map(name => path.join(HISTORY_DIR, name))
        .sort()
        .reverse();
}

function getLatestHistoryFile() {
    const files = listHistoryFiles();
    if (!files.length) throw new Error('No history CSV files found in ' + HISTORY_DIR);
    return files[0];
}

function parseTimestampMs(raw) {
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
        const num = Number(raw);
        if (!Number.isFinite(num)) return null;
        return num > 1e12 ? num : num * 1000;
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function parseTime12h(str) {
    if (!str) return null;
    const m = str.trim().match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)$/i);
    if (!m) return null;
    let hour = Number(m[1]);
    const minute = m[2] != null ? Number(m[2]) : 0;
    const isPm = m[3].toUpperCase() === 'PM';
    if (hour === 12) hour = isPm ? 12 : 0;
    else if (isPm) hour += 12;
    return { hour, minute };
}

function getNyOffsetMinutes(year, month, day) {
    const probe = new Date(Date.UTC(year, month - 1, day, 12, 0));
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).formatToParts(probe);
    const tz = parts.find(p => p.type === 'timeZoneName');
    if (!tz) return -5 * 60;
    if (/EDT/i.test(tz.value)) return -4 * 60;
    if (/EST/i.test(tz.value)) return -5 * 60;
    return -5 * 60;
}

function toNyEpochMs(year, month, day, hour, minute) {
    const offsetMinutes = getNyOffsetMinutes(year, month, day);
    return Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60 * 1000;
}

function parseMarketWindow(question, fallbackYear) {
    if (!question) return null;
    const rangeRegex = /-\s*([A-Za-z]+)\s+(\d{1,2}),\s*([0-9]{1,2}:[0-9]{2}[AP]M)\s*-\s*([0-9]{1,2}:[0-9]{2}[AP]M)\s*ET/i;
    const singleRegex = /-\s*([A-Za-z]+)\s+(\d{1,2}),\s*([0-9]{1,2}(?::[0-9]{2})?[AP]M)\s*ET/i;
    const monthMap = {
        january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
        july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
    };

    const year = fallbackYear || new Date().getUTCFullYear();
    let match = question.match(rangeRegex);
    if (match) {
        const month = monthMap[match[1].toLowerCase()];
        if (!month) return null;
        const day = Number(match[2]);
        const startTime = parseTime12h(match[3]);
        const endTime = parseTime12h(match[4]);
        if (!startTime || !endTime) return null;
        const start = toNyEpochMs(year, month, day, startTime.hour, startTime.minute);
        let end = toNyEpochMs(year, month, day, endTime.hour, endTime.minute);
        if (end <= start) end = toNyEpochMs(year, month, day + 1, endTime.hour, endTime.minute);
        return { start, end };
    }

    match = question.match(singleRegex);
    if (match) {
        const month = monthMap[match[1].toLowerCase()];
        if (!month) return null;
        const day = Number(match[2]);
        const startTime = parseTime12h(match[3]);
        if (!startTime) return null;
        const start = toNyEpochMs(year, month, day, startTime.hour, startTime.minute);
        const end = start + 60 * 60 * 1000;
        return { start, end };
    }

    return null;
}

function tradeWithinLookback(ts) {
    if (!Number.isFinite(ts)) return false;
    return ts >= Date.now() - LOOKBACK_MS;
}

function isAllowedMarket(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    if (!lower.includes(MARKET_KEYWORD)) return false;
    if (lower.includes('ethereum')) return false;
    if (lower.includes('eth/')) return false;
    if (/\beth\b/i.test(name)) return false;
    return true;
}

async function loadTrades(filePath) {
    return new Promise((resolve, reject) => {
        const grouped = new Map();
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                const market = (row.market || '').toString();
                if (!market || !isAllowedMarket(market)) return;
                const type = (row.type || '').toUpperCase();
                if (type !== 'TRADE') return;
                const ts = parseTimestampMs(row.timestamp);
                if (!ts || !tradeWithinLookback(ts)) return;
                const entry = {
                    ts,
                    market,
                    outcome: (row.outcome || '').toString(),
                    side: (row.side || '').toUpperCase(),
                    price: parseFloat(row.price) || 0,
                    size: parseFloat(row.size) || 0,
                    valueUSDC: parseFloat(row.valueUSDC) || 0
                };
                if (!grouped.has(market)) grouped.set(market, []);
                grouped.get(market).push(entry);
            })
            .on('end', () => resolve(grouped))
            .on('error', reject);
    });
}

async function fetchStream(url, userField) {
    const collected = [];
    const cutoff = Math.floor((Date.now() - LOOKBACK_MS) / 1000);
    let lastTimestamp = Math.floor(Date.now() / 1000);
    const seen = new Set();
    const query = `
    query GetOrders($user: String!, $minTime: BigInt!, $maxTime: BigInt!) {
        orderFilledEvents(
            where: { ${userField}: $user, timestamp_gte: $minTime, timestamp_lte: $maxTime },
            orderBy: timestamp,
            orderDirection: desc,
            first: 1000
        ) {
            id
            timestamp
            maker
            taker
            makerAssetId
            takerAssetId
            makerAmountFilled
            takerAmountFilled
        }
    }`;

    let keepFetching = true;
    while (keepFetching) {
        const variables = { user: WALLET_ADDRESS, minTime: String(cutoff), maxTime: String(lastTimestamp) };
        try {
            const resp = await axios.post(url, { query, variables }, { timeout: 20000 });
            if (resp.data.errors) throw new Error(JSON.stringify(resp.data.errors));
            const batch = (resp.data.data && resp.data.data.orderFilledEvents) || [];
            const uniques = batch.filter(item => {
                if (seen.has(item.id)) return false;
                seen.add(item.id);
                return true;
            });
            collected.push(...uniques);
            if (batch.length < 1000) {
                keepFetching = false;
            } else {
                const minTime = Math.min(...batch.map(event => Number(event.timestamp)));
                if (minTime <= cutoff) keepFetching = false;
                else lastTimestamp = minTime - 1;
            }
            process.stdout.write(colors.gray + '.' + colors.reset);
        } catch (err) {
            log.warn(`Stream error for ${userField}: ${err.message}`);
            keepFetching = false;
        }
        await new Promise(r => setTimeout(r, 30));
    }
    process.stdout.write('\n');
    return collected;
}

async function fetchMarketMetadata(tokenIds) {
    const cache = new Map();
    const unique = Array.from(new Set(tokenIds.filter(Boolean)));
    for (const id of unique) {
        try {
            const resp = await axios.get(`${GAMMA_API_URL}/markets`, { params: { clob_token_ids: id }, timeout: 15000 });
            const markets = Array.isArray(resp.data) ? resp.data : [];
            markets.forEach(market => {
                let outcomes = [];
                try { outcomes = JSON.parse(market.outcomes || '[]'); } catch (_) { outcomes = []; }
                let tokens = [];
                try { tokens = JSON.parse(market.clobTokenIds || '[]'); } catch (_) { tokens = []; }
                tokens.forEach((token, idx) => {
                    cache.set(String(token), {
                        market: market.question,
                        outcome: outcomes[idx] || 'Unknown'
                    });
                });
            });
        } catch (err) {
            log.warn(`Metadata fetch failed for token ${id}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 40));
    }
    return cache;
}

async function fetchTradesLive() {
    log.info(`Fetching live trades for ${WALLET_ADDRESS} (last ${DAYS_BACK} day(s))...`);
    const [maker, taker] = await Promise.all([
        fetchStream(ORDERBOOK_URL, 'maker'),
        fetchStream(ORDERBOOK_URL, 'taker')
    ]);
    const combined = [...maker, ...taker];
    if (!combined.length) {
        log.warn('No live trades fetched.');
        return new Map();
    }

    const tokenIds = [];
    combined.forEach(event => {
        if (event.makerAssetId) tokenIds.push(event.makerAssetId);
        if (event.takerAssetId) tokenIds.push(event.takerAssetId);
    });

    const metadata = await fetchMarketMetadata(tokenIds);
    const grouped = new Map();
    const cutoffTs = Date.now() - LOOKBACK_MS;

    combined.forEach(event => {
        const ts = Number(event.timestamp) * 1000;
        if (Number.isNaN(ts) || ts < cutoffTs) return;
        const makerInfo = metadata.get(String(event.makerAssetId));
        const takerInfo = metadata.get(String(event.takerAssetId));
        let marketName = '';
        let outcome = 'Unknown';
        let side = 'UNKNOWN';
        let size = 0;
        let value = 0;

        const isMaker = (event.maker || '').toLowerCase() === WALLET_ADDRESS;
        if (makerInfo) {
            marketName = makerInfo.market;
            outcome = makerInfo.outcome;
            size = Number(event.makerAmountFilled) / 1e6;
            value = Number(event.takerAmountFilled) / 1e6;
            side = isMaker ? 'SELL' : 'BUY';
        } else if (takerInfo) {
            marketName = takerInfo.market;
            outcome = takerInfo.outcome;
            size = Number(event.takerAmountFilled) / 1e6;
            value = Number(event.makerAmountFilled) / 1e6;
            side = isMaker ? 'BUY' : 'SELL';
        } else {
            return;
        }

        if (!marketName || !isAllowedMarket(marketName)) return;

        const entry = {
            ts,
            market: marketName,
            outcome,
            side,
            price: size > 0 ? value / size : 0,
            size,
            valueUSDC: value
        };

        if (!grouped.has(marketName)) grouped.set(marketName, []);
        grouped.get(marketName).push(entry);
    });

    return grouped;
}

async function fetchBtcPrices(startMs, endMs) {
    const params = new URLSearchParams({
        vs_currency: 'usd',
        from: Math.floor(startMs / 1000),
        to: Math.ceil(endMs / 1000)
    });
    log.info(`Fetching BTC prices between ${new Date(startMs).toISOString()} and ${new Date(endMs).toISOString()}`);
    const { data } = await axios.get(`${COINGECKO_URL}?${params.toString()}`, { timeout: 20000 });
    const list = Array.isArray(data && data.prices) ? data.prices : [];
    return list
        .map(([ms, price]) => ({ ts: Number(ms), price: Number(price) }))
        .filter(point => Number.isFinite(point.ts) && Number.isFinite(point.price))
        .sort((a, b) => a.ts - b.ts);
}

function findNearestPrice(prices, targetTs) {
    if (!prices.length) return null;
    let left = 0;
    let right = prices.length - 1;
    if (targetTs <= prices[0].ts) return prices[0];
    if (targetTs >= prices[right].ts) return prices[right];
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (prices[mid].ts === targetTs) return prices[mid];
        if (prices[mid].ts < targetTs) left = mid + 1;
        else right = mid - 1;
    }
    const candidates = [];
    if (left < prices.length) candidates.push(prices[left]);
    if (right >= 0) candidates.push(prices[right]);
    return candidates.reduce((closest, current) => {
        if (!closest) return current;
        const diffCurrent = Math.abs(current.ts - targetTs);
        const diffClosest = Math.abs(closest.ts - targetTs);
        return diffCurrent < diffClosest ? current : closest;
    }, null);
}

function collectPriceSeries(prices, startTs, endTs) {
    if (!prices.length) return [];
    const pad = 60 * 1000;
    const points = new Map();
    const addPoint = (pt) => {
        if (!pt) return;
        if (!Number.isFinite(pt.ts) || !Number.isFinite(pt.price)) return;
        points.set(pt.ts, pt.price);
    };
    prices.forEach(pt => {
        if (pt.ts >= startTs - pad && pt.ts <= endTs + pad) addPoint(pt);
    });
    addPoint({ ts: startTs, price: (findNearestPrice(prices, startTs) || {}).price });
    addPoint({ ts: endTs, price: (findNearestPrice(prices, endTs) || {}).price });
    return Array.from(points.entries()).sort((a, b) => a[0] - b[0]).map(([ts, price]) => ({ ts, price }));
}

function isUpOutcome(outcome = '') {
    return outcome.toLowerCase().includes('up');
}

function isDownOutcome(outcome = '') {
    return outcome.toLowerCase().includes('down');
}

function formatEtLabel(ts) {
    return ET_TIMESTAMP_FORMATTER.format(new Date(ts));
}

function formatEtDate(ts) {
    return ET_DATE_FORMATTER.format(new Date(ts));
}

function formatEtTime(ts, { dropMinutesIfZero = false } = {}) {
    let label = ET_TIME_FORMATTER.format(new Date(ts)).replace(' ', '');
    if (dropMinutesIfZero) label = label.replace(':00', '');
    return label;
}

function buildWindowDisplayTitle(startTs, endTs, durationMinutes) {
    const dateLabel = formatEtDate(startTs);
    if (durationMinutes === 60) {
        return `Bitcoin Up or Down - ${dateLabel}, ${formatEtTime(startTs, { dropMinutesIfZero: true })} ET`;
    }
    return `Bitcoin Up or Down - ${dateLabel}, ${formatEtTime(startTs)}-${formatEtTime(endTs)} ET`;
}

function summarizeMarket(market, trades, prices) {
    if (!trades.length) return null;
    trades.sort((a, b) => a.ts - b.ts);
    const fallbackYear = new Date(trades[0].ts).getUTCFullYear();
    const window = parseMarketWindow(market, fallbackYear);
    if (!window) {
        log.debug(`Could not parse window for market: ${market}`);
        return null;
    }
    const windowMinutes = Math.round((window.end - window.start) / (60 * 1000));
    if (!ALLOWED_WINDOW_MINUTES.includes(windowMinutes)) {
        log.debug(`Skipping market with duration ${windowMinutes} minutes: ${market}`);
        return null;
    }

    const inWindow = trades.filter(t => t.ts >= window.start && t.ts <= window.end);
    if (!inWindow.length) {
        log.debug(`No trades inside window for ${market}`);
        return null;
    }

    let upNotional = 0;
    let downNotional = 0;

    const detailedTrades = inWindow.map(trade => {
        const val = trade.valueUSDC || (trade.price * trade.size) || 0;
        let signedNotional = 0;
        if (isUpOutcome(trade.outcome)) {
            const contribution = trade.side === 'SELL' ? -val : val;
            upNotional += contribution;
            signedNotional = contribution;
        } else if (isDownOutcome(trade.outcome)) {
            const contribution = trade.side === 'SELL' ? -val : val;
            downNotional += contribution;
            signedNotional = trade.side === 'SELL' ? val : -val;
        }
        return {
            tsMs: trade.ts,
            tsUTC: new Date(trade.ts).toISOString(),
            outcome: trade.outcome,
            side: trade.side,
            size: trade.size,
            price: trade.price,
            notional: val,
            signedNotional,
            etLabel: formatEtLabel(trade.ts)
        };
    });

    const netBias = upNotional - downNotional;
    const btcStart = (findNearestPrice(prices, window.start) || {}).price ?? null;
    const btcEnd = (findNearestPrice(prices, window.end) || {}).price ?? null;
    const changePct = btcStart && btcEnd ? ((btcEnd - btcStart) / btcStart) * 100 : null;
    const btcDirection = changePct == null ? 'UNKNOWN' : changePct > 0 ? 'UP' : changePct < 0 ? 'DOWN' : 'FLAT';
    const tradeDirection = netBias > 0 ? 'UP' : netBias < 0 ? 'DOWN' : 'EVEN';
    const aligned = (btcDirection === 'UP' && netBias > 0) || (btcDirection === 'DOWN' && netBias < 0);

    log.info(`[${market}] ${inWindow.length} trades | ${windowMinutes} min window | Bias ${tradeDirection} (${netBias.toFixed(2)}) | BTC ${btcDirection}${changePct != null ? ` (${changePct.toFixed(2)}%)` : ''}`);

    return {
        market,
        displayTitle: buildWindowDisplayTitle(window.start, window.end, windowMinutes),
        durationMinutes: windowMinutes,
        start: window.start,
        end: window.end,
        tradeCount: inWindow.length,
        upNotional,
        downNotional,
        netBias,
        tradeDirection,
        btcStart,
        btcEnd,
        changePct,
        btcDirection,
        aligned,
        trades: detailedTrades,
        priceSeries: collectPriceSeries(prices, window.start, window.end)
    };
}

function writeCsv(rows, filePath) {
    if (!rows.length) {
        log.warn('No rows to write, skipping CSV output.');
        return;
    }
    const header = [
        'market',
        'windowStartUTC',
        'windowEndUTC',
        'tradeCountInWindow',
        'upNotionalUSDC',
        'downNotionalUSDC',
        'netBiasUSDC',
        'tradeDirection',
        'btcStartPrice',
        'btcEndPrice',
        'btcChangePct',
        'btcDirection',
        'aligned'
    ].join(',');

    const lines = rows.map(row => [
        `"${row.market.replace(/"/g, '""')}"`,
        new Date(row.start).toISOString(),
        new Date(row.end).toISOString(),
        row.tradeCount,
        row.upNotional.toFixed(2),
        row.downNotional.toFixed(2),
        row.netBias.toFixed(2),
        row.tradeDirection,
        row.btcStart != null ? row.btcStart.toFixed(2) : '',
        row.btcEnd != null ? row.btcEnd.toFixed(2) : '',
        row.changePct != null ? row.changePct.toFixed(4) : '',
        row.btcDirection,
        row.aligned
    ].join(','));

    fs.writeFileSync(filePath, [header, ...lines].join('\n'));
    log.info(`Wrote sentiment summary to ${filePath}`);
}

function writeHtml(summaries, filePath) {
    if (!summaries.length) {
        log.warn('No summaries to visualize, skipping HTML output.');
        return;
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        windows: summaries.map(summary => ({
            market: summary.market,
            displayTitle: summary.displayTitle,
            durationMinutes: summary.durationMinutes,
            windowStartUTC: new Date(summary.start).toISOString(),
            windowEndUTC: new Date(summary.end).toISOString(),
            windowStartMs: summary.start,
            windowEndMs: summary.end,
            tradeDirection: summary.tradeDirection,
            btcDirection: summary.btcDirection,
            netBiasUSDC: summary.netBias,
            btcChangePct: summary.changePct,
            aligned: summary.aligned,
            tradeCountInWindow: summary.tradeCount,
            upNotionalUSDC: summary.upNotional,
            downNotionalUSDC: summary.downNotional,
            btcStartPrice: summary.btcStart,
            btcEndPrice: summary.btcEnd,
            trades: summary.trades,
            priceSeries: summary.priceSeries.map(point => ({
                tsMs: point.ts,
                tsUTC: new Date(point.ts).toISOString(),
                price: point.price
            }))
        }))
    };

    const serialized = JSON.stringify(payload).replace(/</g, '\\u003c');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BTC Window Sentiment</title>
<style>
    :root { color-scheme: dark; }
    body {
        margin: 0;
        font-family: "Inter", "Helvetica Neue", Arial, sans-serif;
        background: #0f172a;
        color: #e2e8f0;
        min-height: 100vh;
    }
    main { display: flex; flex-direction: column; min-height: 100vh; }
    .page-header {
        padding: 24px 24px 12px;
        max-width: 1200px;
        margin: 0 auto;
        width: 100%;
    }
    .page-header h1 {
        margin: 0 0 8px;
        font-size: 28px;
        font-weight: 600;
        letter-spacing: -0.01em;
    }
    .page-header p {
        margin: 0;
        color: #94a3b8;
        font-size: 15px;
    }
    .chart-stage {
        flex: 1;
        display: flex;
        justify-content: center;
        align-items: stretch;
        padding: 0 24px 24px;
    }
    .chart-container {
        flex: 1;
        display: flex;
        justify-content: center;
        align-items: stretch;
        max-width: 1200px;
        width: 100%;
    }
    .chart-card {
        background: rgba(15, 23, 42, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 16px 40px rgba(15, 23, 42, 0.45);
        display: flex;
        flex-direction: column;
        gap: 20px;
        width: 100%;
    }
    .card-header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
    }
    .card-header h2 { margin: 0; font-size: 22px; font-weight: 600; }
    .card-meta {
        margin-top: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px 16px;
        font-size: 13px;
        color: #cbd5f5;
    }
    .meta-chip {
        padding: 4px 12px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.14);
        color: #e2e8f0;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
    }
    .alignment {
        padding: 8px 14px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
    }
    .alignment-aligned {
        background: rgba(34, 197, 94, 0.15);
        color: #4ade80;
        border: 1px solid rgba(34, 197, 94, 0.3);
    }
    .alignment-divergent {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
        border: 1px solid rgba(239, 68, 68, 0.3);
    }
    canvas { width: 100% !important; flex: 1; }
    .chart-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
    }
    footer {
        padding: 16px 24px 24px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        font-size: 13px;
        color: #64748b;
    }
    .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        align-items: center;
        justify-content: center;
    }
    .control-group { display: flex; align-items: center; gap: 12px; }
    .controls button {
        appearance: none;
        border: none;
        border-radius: 999px;
        padding: 8px 18px;
        font-size: 13px;
        font-weight: 600;
        background: rgba(51, 65, 85, 0.6);
        color: #e2e8f0;
        cursor: pointer;
        transition: background 0.2s ease;
    }
    .controls button:hover:not(:disabled) { background: rgba(79, 99, 129, 0.8); }
    .controls button:disabled { opacity: 0.4; cursor: not-allowed; }
    #window-counter { font-size: 13px; min-width: 88px; text-align: center; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; }
    .duration-selector {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 12px;
    }
    .scope-option {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(51,65,85,0.4);
        color: #e2e8f0;
        font-size: 13px;
        cursor: pointer;
        transition: background 0.2s ease, color 0.2s ease;
    }
    .scope-option input {
        appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid rgba(148, 163, 184, 0.6);
        position: relative;
    }
    .scope-option input:checked {
        border-color: #60a5fa;
        background: #60a5fa;
    }
    .scope-option:hover { background: rgba(79, 99, 129, 0.6); }
    .empty-state { margin: 0; font-size: 15px; color: #94a3b8; }
    @media (max-width: 720px) {
        .page-header { padding: 20px 16px 12px; }
        .chart-stage { padding: 0 16px 16px; }
        .chart-card { padding: 18px; }
        .card-header { flex-direction: column; align-items: stretch; }
        .controls { gap: 12px; }
    }
</style>
</head>
<body>
<main>
    <header class="page-header">
        <h1>BTC Window Sentiment</h1>
        <p><span id="scope-label"></span> showing net trade bias and BTC price overlay. Generated <span id="generated-at"></span>.</p>
    </header>
    <section class="chart-stage">
        <div class="chart-container" id="chart-container"></div>
    </section>
    <footer>
        <div class="controls">
            <div class="control-group">
                <button id="prev-window" type="button">Prev Window</button>
                <span id="window-counter"></span>
                <button id="next-window" type="button">Next Window</button>
            </div>
            <div class="control-group duration-selector" id="duration-selector"></div>
        </div>
        <p>Data sourced from Polymarket trades and CoinGecko BTC price history.</p>
    </footer>
</main>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.6/dist/chart.umd.min.js"></script>
<script>
    const PAYLOAD = ${serialized};

    const chartContainer = document.getElementById('chart-container');
    const generatedAtEl = document.getElementById('generated-at');
    const scopeLabelEl = document.getElementById('scope-label');
    const durationSelectorEl = document.getElementById('duration-selector');
    const nextWindowButton = document.getElementById('next-window');
    const prevWindowButton = document.getElementById('prev-window');
    const windowCounterEl = document.getElementById('window-counter');

    const currencyFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
    const currencyShort = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    const percentFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    const quantityFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
    const etRangeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const etTimeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
    const etSecondFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' });

    const formatUsd = (value) => {
        if (value == null || Number.isNaN(Number(value))) return 'N/A';
        const abs = Math.abs(value);
        const formatter = abs >= 1000 ? currencyShort : currencyFull;
        return formatter.format(value);
    };

    const formatSignedUsd = (value) => {
        if (value == null || Number.isNaN(Number(value))) return 'N/A';
        const absFormatted = formatUsd(Math.abs(value));
        return (value >= 0 ? '+' : '-') + absFormatted.replace(/^[+-]?/, '');
    };

    const formatPct = (value) => {
        if (value == null || Number.isNaN(Number(value))) return 'N/A';
        return (value >= 0 ? '+' : '') + percentFmt.format(value) + '%';
    };

    const formatDirection = (direction) => {
        if (!direction || direction === 'UNKNOWN') return 'Unknown';
        return direction.charAt(0) + direction.slice(1).toLowerCase();
    };

    const formatWindowRange = (startIso, endIso) => {
        const start = etRangeFmt.format(new Date(startIso));
        const end = etTimeFmt.format(new Date(endIso));
        return start + ' - ' + end + ' ET';
    };

    const formatEtTimestampMs = (ts) => etSecondFmt.format(new Date(ts));

    const computeSymmetricRange = (values) => {
        if (!values.length) return { min: -10, max: 10 };
        const maxAbs = Math.max(1, ...values.map(v => Math.abs(v)));
        const padding = Math.max(5, maxAbs * 0.15);
        return { min: -(maxAbs + padding), max: maxAbs + padding };
    };

    const computePriceRange = (values) => {
        if (!values.length) return null;
        let min = Math.min(...values);
        let max = Math.max(...values);
        if (min === max) {
            const pad = Math.max(1, min * 0.001);
            return { min: min - pad, max: max + pad };
        }
        const span = max - min;
        const pad = Math.max(1, span * 0.05);
        return { min: min - pad, max: max + pad };
    };

    const getDurationLabel = (minutes) => {
        if (minutes === 60) return '1 Hour';
        if (minutes === 240) return '4 Hours';
        if (minutes % 60 === 0) return (minutes / 60) + ' Hours';
        return minutes + ' Minutes';
    };

    const getScopeDescriptor = (minutes) => {
        if (minutes === 60) return '1-hour';
        if (minutes === 240) return '4-hour';
        if (minutes % 60 === 0) return (minutes / 60) + '-hour';
        return minutes + '-minute';
    };

    const buildTradeDataset = (windowData) => {
        const startMs = windowData.windowStartMs;
        return {
            id: 'trades',
            type: 'scatter',
            label: 'Trade Bias (USDC)',
            data: (windowData.trades || []).map(trade => ({
                x: (trade.tsMs - startMs) / 60000,
                y: trade.signedNotional,
                trade
            })),
            parsing: false,
            pointRadius: (ctx) => {
                const value = Math.abs(ctx.raw.trade.notional);
                return Math.max(3, Math.min(14, Math.sqrt(value) * 0.8));
            },
            pointHoverRadius: (ctx) => {
                const value = Math.abs(ctx.raw.trade.notional);
                return Math.max(5, Math.min(16, Math.sqrt(value)));
            },
            pointBackgroundColor: (ctx) => ctx.raw.trade.signedNotional >= 0 ? 'rgba(34, 197, 94, 0.8)' : 'rgba(239, 68, 68, 0.8)',
            pointBorderColor: (ctx) => ctx.raw.trade.signedNotional >= 0 ? 'rgba(34, 197, 94, 1)' : 'rgba(239, 68, 68, 1)'
        };
    };

    const buildPriceDataset = (windowData) => {
        const startMs = windowData.windowStartMs;
        return {
            id: 'btc-price',
            type: 'line',
            label: 'BTC Price (USD)',
            data: (windowData.priceSeries || []).map(point => ({
                x: (point.tsMs - startMs) / 60000,
                y: point.price,
                ts: point.tsMs
            })),
            parsing: false,
            spanGaps: true,
            tension: 0.25,
            pointRadius: 2,
            borderWidth: 2,
            borderColor: 'rgba(96, 165, 250, 1)',
            backgroundColor: 'rgba(96, 165, 250, 0.1)',
            yAxisID: 'y1',
            order: 0
        };
    };

    const availableDurations = Array.from(new Set((PAYLOAD.windows || []).map(win => Number(win.durationMinutes) || 0))).filter(Boolean).sort((a, b) => a - b);
    let currentDuration = availableDurations.includes(60) ? 60 : availableDurations[0] || null;
    let filteredWindows = [];
    let totalWindows = 0;
    let currentWindowIndex = 0;
    let activeChart = null;

    Chart.defaults.color = '#e2e8f0';
    Chart.defaults.borderColor = 'rgba(148, 163, 184, 0.3)';
    Chart.defaults.font.family = '"Inter","Helvetica Neue",Arial,sans-serif';

    if (generatedAtEl) generatedAtEl.textContent = new Date(PAYLOAD.generatedAt).toLocaleString();

    const clearActiveChart = () => {
        if (activeChart) {
            activeChart.destroy();
            activeChart = null;
        }
    };

    const updateScopeLabel = () => {
        if (!scopeLabelEl) return;
        if (!currentDuration) {
            scopeLabelEl.textContent = 'No markets available';
        } else {
            scopeLabelEl.textContent = getDurationLabel(currentDuration) + ' markets';
        }
    };

    const updateControls = () => {
        const counterText = totalWindows ? (currentWindowIndex + 1) + ' / ' + totalWindows : '0 / 0';
        if (windowCounterEl) windowCounterEl.textContent = counterText;
        const disableWindowNav = totalWindows <= 1;
        if (prevWindowButton) prevWindowButton.disabled = disableWindowNav;
        if (nextWindowButton) nextWindowButton.disabled = disableWindowNav;
    };

    const renderCard = (windowData, index, total) => {
        const card = document.createElement('section');
        card.className = 'chart-card';

        const header = document.createElement('div');
        header.className = 'card-header';

        const info = document.createElement('div');
        const title = document.createElement('h2');
        title.textContent = windowData.displayTitle || windowData.market;
        info.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'card-meta';

        const windowChip = document.createElement('span');
        windowChip.className = 'meta-chip';
        windowChip.textContent = 'Window ' + (index + 1) + ' of ' + total;
        meta.appendChild(windowChip);

        const durationChip = document.createElement('span');
        durationChip.className = 'meta-chip';
        durationChip.textContent = getDurationLabel(windowData.durationMinutes);
        meta.appendChild(durationChip);

        const rangeSpan = document.createElement('span');
        rangeSpan.textContent = formatWindowRange(windowData.windowStartUTC, windowData.windowEndUTC);
        meta.appendChild(rangeSpan);

        const tradeSpan = document.createElement('span');
        tradeSpan.textContent = windowData.tradeCountInWindow + ' trades in window';
        meta.appendChild(tradeSpan);

        const biasSpan = document.createElement('span');
        biasSpan.textContent = 'Window Bias: ' + formatDirection(windowData.tradeDirection) + ' (' + formatUsd(windowData.netBiasUSDC) + ')';
        meta.appendChild(biasSpan);

        const btcSpan = document.createElement('span');
        btcSpan.textContent = 'BTC: ' + formatDirection(windowData.btcDirection) + ' (' + formatPct(windowData.btcChangePct) + ')';
        meta.appendChild(btcSpan);

        info.appendChild(meta);
        header.appendChild(info);

        const alignment = document.createElement('span');
        const aligned = Boolean(windowData.aligned);
        alignment.className = 'alignment ' + (aligned ? 'alignment-aligned' : 'alignment-divergent');
        alignment.textContent = aligned ? 'Aligned' : 'Divergent';
        header.appendChild(alignment);

        card.appendChild(header);

        const body = document.createElement('div');
        body.className = 'chart-body';
        card.appendChild(body);

        if (!windowData.trades || !windowData.trades.length) {
            const emptyNotice = document.createElement('p');
            emptyNotice.className = 'empty-state';
            emptyNotice.textContent = 'No trades captured in this window.';
            body.appendChild(emptyNotice);
            return { card, chart: null };
        }

        const canvas = document.createElement('canvas');
        canvas.id = 'chart-window-' + index;
        body.appendChild(canvas);

        const tradeDataset = buildTradeDataset(windowData);
        const priceDataset = buildPriceDataset(windowData);
        const datasets = [tradeDataset];
        if (priceDataset.data.length) datasets.push(priceDataset);

        const biasRange = computeSymmetricRange(tradeDataset.data.map(point => point.y));
        const priceValues = priceDataset.data.map(point => point.y);
        const priceRange = computePriceRange(priceValues);
        const durationMinutes = Math.max(0.01, (windowData.windowEndMs - windowData.windowStartMs) / 60000);
        const xMax = Math.max(durationMinutes, 0.25);

        const chart = new Chart(canvas.getContext('2d'), {
            type: 'scatter',
            data: { datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'nearest', intersect: false },
                scales: {
                    x: {
                        type: 'linear',
                        min: 0,
                        max: xMax,
                        title: {
                            display: true,
                            text: 'Minutes within ' + getScopeDescriptor(windowData.durationMinutes) + ' window (ET)'
                        },
                        ticks: {
                            color: '#cbd5f5',
                            callback: (value) => formatEtTimestampMs(windowData.windowStartMs + value * 60000)
                        },
                        grid: { color: 'rgba(148, 163, 184, 0.25)' }
                    },
                    y: {
                        position: 'left',
                        title: { display: true, text: 'Trade Bias (USDC)' },
                        min: biasRange.min,
                        max: biasRange.max,
                        ticks: { color: '#cbd5f5', callback: (value) => formatUsd(value) },
                        grid: { color: 'rgba(148, 163, 184, 0.25)' }
                    },
                    y1: {
                        display: Boolean(priceDataset.data.length),
                        position: 'right',
                        title: { display: Boolean(priceDataset.data.length), text: 'BTC Price (USD)' },
                        min: priceRange ? priceRange.min : undefined,
                        max: priceRange ? priceRange.max : undefined,
                        ticks: { color: '#f8fafc', callback: (value) => currencyFull.format(value) },
                        grid: { drawOnChartArea: false }
                    }
                },
                plugins: {
                    legend: { labels: { color: '#e2e8f0' } },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                if (ctx.dataset.id === 'trades') {
                                    const trade = ctx.raw.trade;
                                    return [
                                        'Time: ' + trade.etLabel,
                                        'Outcome: ' + trade.outcome + ' (' + trade.side + ')',
                                        'Signed Bias: ' + formatSignedUsd(trade.signedNotional),
                                        'Notional: ' + formatUsd(trade.notional),
                                        'Size: ' + quantityFmt.format(trade.size),
                                        'Price: ' + quantityFmt.format(trade.price)
                                    ];
                                }
                                if (ctx.dataset.id === 'btc-price') {
                                    return [
                                        'BTC Price: ' + currencyFull.format(ctx.raw.y),
                                        'Time: ' + formatEtTimestampMs(ctx.raw.ts)
                                    ];
                                }
                                return ctx.formattedValue;
                            }
                        }
                    }
                }
            }
        });

        return { card, chart };
    };

    const showFrame = (index) => {
        chartContainer.innerHTML = '';
        clearActiveChart();

        if (!totalWindows) {
            const empty = document.createElement('p');
            empty.className = 'empty-state';
            empty.textContent = currentDuration ? 'No windows available for this duration.' : 'No windows available.';
            chartContainer.appendChild(empty);
            updateControls();
            return;
        }

        const normalizedIndex = ((index % totalWindows) + totalWindows) % totalWindows;
        currentWindowIndex = normalizedIndex;
        const windowData = filteredWindows[currentWindowIndex];
        const rendered = renderCard(windowData, currentWindowIndex, totalWindows);
        chartContainer.appendChild(rendered.card);
        if (rendered.chart) activeChart = rendered.chart;
        updateControls();
    };

    const setDuration = (minutes) => {
        currentDuration = minutes || null;
        filteredWindows = currentDuration != null ? (PAYLOAD.windows || []).filter(win => Number(win.durationMinutes) === currentDuration) : [];
        totalWindows = filteredWindows.length;
        currentWindowIndex = 0;
        updateScopeLabel();
        showFrame(0);
    };

    const buildDurationSelector = () => {
        if (!durationSelectorEl) return;
        durationSelectorEl.innerHTML = '';
        if (!availableDurations.length) {
            const chip = document.createElement('span');
            chip.style.color = '#94a3b8';
            chip.textContent = 'No scopes';
            durationSelectorEl.appendChild(chip);
            return;
        }
        availableDurations.forEach(minutes => {
            const option = document.createElement('label');
            option.className = 'scope-option';

            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'duration-scope';
            input.value = String(minutes);
            input.checked = minutes === currentDuration;
            input.addEventListener('change', () => {
                if (input.checked) setDuration(minutes);
            });

            const caption = document.createElement('span');
            caption.textContent = getDurationLabel(minutes);

            option.appendChild(input);
            option.appendChild(caption);
            durationSelectorEl.appendChild(option);
        });
    };

    if (!availableDurations.length) {
        setDuration(null);
    } else {
        setDuration(currentDuration);
    }

    buildDurationSelector();

    if (nextWindowButton) {
        nextWindowButton.addEventListener('click', () => {
            showFrame(currentWindowIndex + 1);
        });
    }

    if (prevWindowButton) {
        prevWindowButton.addEventListener('click', () => {
            showFrame(currentWindowIndex - 1);
        });
    }
</script>
</body>
</html>`;

    fs.writeFileSync(filePath, html);
    log.info(`Wrote visualization to ${filePath}`);
}

async function main() {
    try {
        let grouped;
        try {
            const historyFile = getLatestHistoryFile();
            log.info(`Using latest history file: ${path.basename(historyFile)}`);
            grouped = await loadTrades(historyFile);
        } catch (err) {
            log.warn(err.message);
            grouped = await fetchTradesLive();
        }

        if (!grouped || !grouped.size) {
            log.warn(`No trades found for keyword "${MARKET_KEYWORD}"`);
            return;
        }

        const windows = [];
        grouped.forEach((trades, market) => {
            if (!trades.length) return;
            trades.sort((a, b) => a.ts - b.ts);
            const fallbackYear = new Date(trades[0].ts).getUTCFullYear();
            const window = parseMarketWindow(market, fallbackYear);
            if (!window) return;
            const durationMinutes = Math.round((window.end - window.start) / (60 * 1000));
            if (!ALLOWED_WINDOW_MINUTES.includes(durationMinutes)) return;
            windows.push(window);
        });

        if (!windows.length) {
            log.warn('Could not parse any market windows.');
            return;
        }

        const minStart = Math.min(...windows.map(w => w.start)) - PRICE_PADDING_MINUTES * 60 * 1000;
        const maxEnd = Math.max(...windows.map(w => w.end)) + PRICE_PADDING_MINUTES * 60 * 1000;

        const prices = await fetchBtcPrices(minStart, maxEnd);
        if (!prices.length) log.warn('BTC price history empty for requested range.');

        const summaries = [];
        grouped.forEach((trades, market) => {
            trades.forEach(t => t.market = market);
            const summary = summarizeMarket(market, trades, prices);
            if (summary) summaries.push(summary);
        });

        if (!summaries.length) {
            log.warn('No sentiment summaries produced.');
            return;
        }

        summaries.sort((a, b) => a.start - b.start);
        writeCsv(summaries, OUTPUT_FILE);
        writeHtml(summaries, OUTPUT_HTML);
        log.info(`Total markets scored: ${summaries.length}`);
    } catch (err) {
        log.error(err.message || err);
    }
}

main();
