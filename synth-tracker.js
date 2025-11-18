const { ethers } = require('ethers');
const axios = require('axios');

// ANSI colors for terminal
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m'
};

// Config
const SYNTH_ADDRESS = '0x557bed924a1bb6f62842c5742d1dc789b8d480d4'.toLowerCase();
const EXCHANGE_CONTRACT = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e'.toLowerCase();
const CTF_CONTRACT = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045'.toLowerCase();
const POLYGON_WS_URL = 'wss://polygon-mainnet.g.alchemy.com/v2/PLG7HaKwMvU9g5Ajifosm';  // Keep your key here
const DATA_API_URL = 'https://data-api.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Topics
const ORDER_FILLED_TOPIC = ethers.keccak256(ethers.toUtf8Bytes(
  'OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'
));
const PAYOUT_REDEMPTION_TOPIC = ethers.keccak256(ethers.toUtf8Bytes(
  'PayoutRedemption(address,address,bytes32,bytes32,uint256[],uint256)'
));

// In-memory state
let currentPositions = [];
let recentTrades = [];  // Includes trades and redeems; last 20
const MAX_TRADES = 20;

// Function to sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch positions
async function fetchPositions(print = false) {
  try {
    const response = await axios.get(`${DATA_API_URL}/positions`, {
      params: { user: SYNTH_ADDRESS, limit: 1000 }
    });
    currentPositions = response.data;

    if (print) {
      // Map + calculate PnL % + sort by value descending (like UI)
      const mapped = currentPositions.map(p => {
        const qty = parseFloat(p.size);
        const value = parseFloat(p.currentValue);
        const avg = parseFloat(p.avgPrice);
        const currentPrice = qty > 0 ? value / qty : 0;
        const pnl = qty > 0 ? ((currentPrice - avg) / avg) * 100 : 0;
        return {
          market: p.title,
          outcome: p.outcome,
          quantity: qty.toFixed(2),
          value: value.toFixed(2),
          avgPrice: avg.toFixed(2),
          currentPrice: currentPrice.toFixed(2),
          pnl: pnl.toFixed(2) + '%',
          pnlNum: pnl
        };
      }).sort((a, b) => parseFloat(b.value) - parseFloat(a.value));

      console.log(colors.bold + colors.blue + '\n=== CURRENT POSITIONS (sorted by value) ===' + colors.reset);
      mapped.forEach((p, index) => {
        const pnlColor = p.pnlNum > 0 ? colors.green : p.pnlNum < 0 ? colors.red : colors.gray;
        console.log(colors.cyan + `Position ${index + 1}:` + colors.reset + ` ${p.market} (${p.outcome})`);
        console.log(`${colors.magenta}Qty:${colors.reset} ${p.quantity} | ${colors.magenta}Value:${colors.reset} $${p.value} | ${colors.magenta}Avg Price:${colors.reset} $${p.avgPrice}`);
        console.log(`${colors.magenta}Curr Price:${colors.reset} $${p.currentPrice} | ${colors.magenta}PnL:${colors.reset} ${pnlColor}${p.pnl}${colors.reset}`);
        console.log(colors.gray + '─'.repeat(80) + colors.reset);
      });
      console.log(colors.bold + colors.blue + '--- End of Positions ---' + colors.reset + '\n');
    }
  } catch (error) {
    console.error(colors.red + 'Error fetching positions:' + colors.reset, error.message);
  }
}

// Resolve tokenId → market/outcome
async function resolveTokenId(tokenId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await axios.get(`${GAMMA_API_URL}/markets`, {
        params: { clob_token_ids: tokenId.toString(), limit: 1 }
      });
      if (response.data.length > 0) {
        const market = response.data[0];
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        const index = tokenIds.indexOf(tokenId.toString());
        const outcomes = JSON.parse(market.outcomes || '[]');
        const outcome = (index !== -1) ? outcomes[index] || 'Unknown' : 'Unknown';
        return { market: market.question || 'Unknown', outcome };
      }
      return { market: 'Unknown', outcome: 'Unknown' };
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.log(`TokenId resolution attempt ${attempt + 1} failed (404) - retrying in 3s...`);
        await sleep(3000);
      } else {
        console.log('Error resolving tokenId (fallback to Unknown):', error.message);
        return { market: 'Unknown', outcome: 'Unknown' };
      }
    }
  }
  console.log('Failed to resolve tokenId after retries (fallback to Unknown)');
  return { market: 'Unknown', outcome: 'Unknown' };
}

// Resolve conditionId → market (for redeems; outcomes from indexSets)
async function resolveConditionId(conditionId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await axios.get(`${GAMMA_API_URL}/markets`, {
        params: { condition_ids: conditionId, limit: 1 }
      });
      if (response.data.length > 0) {
        return response.data[0];  // Returns full market with outcomes
      }
      return null;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.log(`ConditionId resolution attempt ${attempt + 1} failed (404) - retrying in 3s...`);
        await sleep(3000);
      } else {
        console.log('Error resolving conditionId (fallback to Unknown):', error.message);
        return null;
      }
    }
  }
  console.log('Failed to resolve conditionId after retries (fallback to Unknown)');
  return null;
}

// Handle trade log
async function handleTradeLog(log) {
  if (log.address.toLowerCase() !== EXCHANGE_CONTRACT) return;
  if (log.topics[0] !== ORDER_FILLED_TOPIC) return;

  const iface = new ethers.Interface([`event OrderFilled(
    bytes32 indexed orderHash,
    address indexed maker,
    address indexed taker,
    uint256 makerAssetId,
    uint256 takerAssetId,
    uint256 makerAmountFilled,
    uint256 takerAmountFilled,
    uint256 fee
  )`]);
  const decoded = iface.parseLog(log);

  const maker = decoded.args.maker.toLowerCase();
  const taker = decoded.args.taker.toLowerCase();
  if (maker !== SYNTH_ADDRESS && taker !== SYNTH_ADDRESS) return;

  const isSynthMaker = maker === SYNTH_ADDRESS;
  const makerAssetId = decoded.args.makerAssetId;
  const takerAssetId = decoded.args.takerAssetId;

  const isBuy = isSynthMaker 
    ? (makerAssetId === 0n) 
    : (takerAssetId === 0n);
  const side = isBuy ? 'BUY' : 'SELL';

  const outcomeTokenId = (makerAssetId === 0n) ? takerAssetId : makerAssetId;
  const usdcAmount = (makerAssetId === 0n) ? decoded.args.makerAmountFilled : decoded.args.takerAmountFilled;
  const tokenAmount = (makerAssetId === 0n) ? decoded.args.takerAmountFilled : decoded.args.makerAmountFilled;
  const price = Number(usdcAmount) / Number(tokenAmount);

  const { market, outcome } = await resolveTokenId(outcomeTokenId);

  const trade = {
    time: new Date().toISOString().split('T')[1].split('.')[0],
    side,
    market,
    outcome,
    shares: parseFloat(ethers.formatUnits(tokenAmount, 6)).toFixed(2),
    usdc: parseFloat(ethers.formatUnits(usdcAmount, 6)).toFixed(2),
    price: price.toFixed(4),
    tx: log.transactionHash
  };

  addToRecentTrades(trade);
}

// Handle redeem log
async function handleRedeemLog(log) {
  if (log.address.toLowerCase() !== CTF_CONTRACT) return;
  if (log.topics[0] !== PAYOUT_REDEMPTION_TOPIC) return;

  const iface = new ethers.Interface([`event PayoutRedemption(
    address indexed redeemer,
    address indexed collateralToken,
    bytes32 indexed parentCollectionId,
    bytes32 conditionId,
    uint256[] indexSets,
    uint256 payout
  )`]);
  const decoded = iface.parseLog(log);

  const redeemer = decoded.args.redeemer.toLowerCase();
  if (redeemer !== SYNTH_ADDRESS) return;

  const conditionId = decoded.args.conditionId;
  const indexSets = decoded.args.indexSets;
  const payout = decoded.args.payout;

  const marketData = await resolveConditionId(conditionId);
  const market = marketData ? marketData.question : 'Unknown';
  // Assume binary market; indexSets[0] == 1n for 'Yes' (index 0), 2 for 'No' (index 1)
  const outcomeIndex = indexSets[0] === 1n ? 0 : 1;
  const outcomes = JSON.parse(marketData?.outcomes || '[]');
  const outcome = outcomes[outcomeIndex] || 'Unknown';
  const shares = parseFloat(ethers.formatUnits(payout, 6)).toFixed(2);

  const trade = {
    time: new Date().toISOString().split('T')[1].split('.')[0],
    side: 'REDEEM',
    market,
    outcome,
    shares,
    usdc: parseFloat(ethers.formatUnits(payout, 6)).toFixed(2),
    price: '1.0000',  // Resolved winner redeems at $1
    tx: log.transactionHash
  };

  addToRecentTrades(trade);
}

// Add to recent and log
function addToRecentTrades(trade) {
  recentTrades.unshift(trade);
  if (recentTrades.length > MAX_TRADES) recentTrades.pop();

  const sideColor = trade.side === 'BUY' ? colors.green : trade.side === 'SELL' ? colors.red : colors.yellow;
  console.log(colors.bold + colors.yellow + '\n🚨 NEW ACTIVITY DETECTED!' + colors.reset);
  console.log(`${colors.cyan}Time:${colors.reset} ${trade.time} | ${colors.cyan}Side:${colors.reset} ${sideColor}${trade.side}${colors.reset} | ${colors.cyan}Outcome:${colors.reset} ${trade.outcome}`);
  console.log(`${colors.cyan}Market:${colors.reset} ${trade.market}`);
  console.log(`${colors.cyan}Shares:${colors.reset} ${trade.shares} | ${colors.cyan}USDC:${colors.reset} $${trade.usdc} | ${colors.cyan}Price:${colors.reset} $${trade.price}`);
  console.log(`${colors.cyan}Tx:${colors.reset} https://polygonscan.com/tx/${trade.tx.slice(0, 10) + '...'}`);
  console.log(colors.gray + '─'.repeat(80) + colors.reset);

  // Silent refresh positions
  fetchPositions();
}

// Print recent activity
function printRecentActivity() {
  if (recentTrades.length === 0) return;
  console.log(colors.bold + colors.blue + '\n=== RECENT ACTIVITY (last ' + recentTrades.length + ') ===' + colors.reset);
  recentTrades.forEach((t, index) => {
    const sideColor = t.side === 'BUY' ? colors.green : t.side === 'SELL' ? colors.red : colors.yellow;
    console.log(colors.magenta + `Activity ${index + 1}:` + colors.reset + ` ${t.market} (${t.outcome})`);
    console.log(`Time: ${t.time} | Side: ${sideColor}${t.side}${colors.reset} | Shares: ${t.shares}`);
    console.log(`USDC: $${t.usdc} | Price: $${t.price}`);
    console.log(`Tx: https://polygonscan.com/tx/${t.tx.slice(0, 10) + '...'}`);
    console.log(colors.gray + '─'.repeat(80) + colors.reset);
  });
  console.log(colors.bold + colors.blue + '--- End of Recent Activity ---' + colors.reset + '\n');
}

// Start tracker
function startTracker() {
  const provider = new ethers.WebSocketProvider(POLYGON_WS_URL);

  provider.websocket.on('open', () => {
    console.log(colors.green + 'Connected to Polygon websocket' + colors.reset);
    fetchPositions(true);  // Initial print
    setInterval(printRecentActivity, 60000);
  });

  // Trade filter
  const tradeFilter = { address: EXCHANGE_CONTRACT, topics: [[ORDER_FILLED_TOPIC]] };
  provider.on(tradeFilter, handleTradeLog);

  // Redeem filter (filter by redeemer topic)
  const redeemTopics = [[PAYOUT_REDEMPTION_TOPIC, ethers.zeroPadValue(SYNTH_ADDRESS, 32)]];
  const redeemFilter = { address: CTF_CONTRACT, topics: redeemTopics };
  provider.on(redeemFilter, handleRedeemLog);

  provider.websocket.on('close', () => {
    console.log(colors.yellow + 'WebSocket closed. Reconnecting...' + colors.reset);
    setTimeout(startTracker, 1000);
  });

  provider.on('error', err => console.error(colors.red + 'Provider Error:' + colors.reset, err));
  provider.websocket.on('error', err => console.error(colors.red + 'WebSocket Error:' + colors.reset, err));

  return provider;
}

startTracker();
console.log(colors.bold + 'Synth Tracker Bot Running... Monitoring address:' + colors.reset, SYNTH_ADDRESS);