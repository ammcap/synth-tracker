const { ethers } = require('ethers');
const axios = require('axios');

// Config
const SYNTH_ADDRESS = '0x557bed924a1bb6f62842c5742d1dc789b8d480d4'.toLowerCase();
const EXCHANGE_CONTRACT = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e'.toLowerCase();
const CTF_CONTRACT = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045'.toLowerCase();
const POLYGON_WS_URL = 'wss://polygon-mainnet.g.alchemy.com/v2/PLG7HaKwMvU9g5Ajifosm';  // Keep your key here
const DATA_API_URL = 'https://data-api.polymarket.com';

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
          pnl: pnl.toFixed(2) + '%'
        };
      }).sort((a, b) => parseFloat(b.value) - parseFloat(a.value));

      console.log('\n=== CURRENT POSITIONS (sorted by value) ===');
      console.table(mapped);
    }
  } catch (error) {
    console.error('Error fetching positions:', error.message);
  }
}

// Resolve tokenId → market/outcome
async function resolveTokenId(tokenId) {
  try {
    const response = await axios.get(`${DATA_API_URL}/markets`, {
      params: { token_ids: tokenId.toString(), limit: 1 }
    });
    if (response.data.length > 0) {
      const market = response.data[0];
      return { market: market.question, outcome: market.outcomes.find(o => o.tokenId === tokenId.toString())?.name || 'Unknown' };
    }
    return { market: 'Unknown', outcome: 'Unknown' };
  } catch (error) {
    console.log('Error resolving tokenId (fallback to Unknown):', error.message);
    return { market: 'Unknown', outcome: 'Unknown' };
  }
}

// Resolve conditionId → market (for redeems; outcomes from indexSets)
async function resolveConditionId(conditionId) {
  try {
    const response = await axios.get(`${DATA_API_URL}/markets`, {
      params: { condition_id: conditionId, limit: 1 }
    });
    if (response.data.length > 0) {
      return response.data[0];  // Returns full market with outcomes
    }
    return null;
  } catch (error) {
    console.log('Error resolving conditionId (fallback to Unknown):', error.message);
    return null;
  }
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
    tx: log.transactionHash.slice(0, 10) + '...'
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
  const outcome = marketData ? marketData.outcomes[outcomeIndex]?.name || 'Unknown' : 'Unknown';
  const shares = Number(payout);  // For resolved binary, payout == shares redeemed (since 1 share = 1 USDC on winner)

  const trade = {
    time: new Date().toISOString().split('T')[1].split('.')[0],
    side: 'REDEEM',
    market,
    outcome,
    shares: shares.toFixed(2),
    usdc: parseFloat(ethers.formatUnits(payout, 6)).toFixed(2),
    price: '1.0000',  // Resolved winner redeems at $1
    tx: log.transactionHash.slice(0, 10) + '...'
  };

  addToRecentTrades(trade);
}

// Add to recent and log
function addToRecentTrades(trade) {
  recentTrades.unshift(trade);
  if (recentTrades.length > MAX_TRADES) recentTrades.pop();

  console.log('\n🚨 NEW ACTIVITY DETECTED!');
  console.table([trade]);

  // Silent refresh positions
  fetchPositions();
}

// Print recent activity
function printRecentActivity() {
  if (recentTrades.length === 0) return;
  console.log('\n=== RECENT ACTIVITY (last', recentTrades.length, ') ===');
  console.table(recentTrades);
}

// Start tracker
function startTracker() {
  const provider = new ethers.WebSocketProvider(POLYGON_WS_URL);

  provider.websocket.on('open', () => {
    console.log('Connected to Polygon websocket');
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
    console.log('WebSocket closed. Reconnecting...');
    setTimeout(startTracker, 1000);
  });

  provider.on('error', err => console.error('Provider Error:', err));
  provider.websocket.on('error', err => console.error('WebSocket Error:', err));

  return provider;
}

startTracker();
console.log('Synth Tracker Bot Running... Monitoring address:', SYNTH_ADDRESS);