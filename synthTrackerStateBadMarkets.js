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
const USER_ADDRESS = '0x2ddc093099a5722dc017c70e756dd3ea5586951e'.toLowerCase();  // Your wallet address
const EXCHANGE_CONTRACT = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e'.toLowerCase();
const CTF_CONTRACT = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045'.toLowerCase();
const USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'.toLowerCase();  // USDC contract on Polygon
const POLYGON_WS_URL = 'wss://polygon-mainnet.g.alchemy.com/v2/PLG7HaKwMvU9g5Ajifosm';  // Keep your key here
const DATA_API_URL = 'https://data-api.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// USDC ABI for balanceOf
const USDC_ABI = [
  {
    "inputs": [{"name": "account", "type": "address"}],
    "name": "balanceOf",
    "outputs": [{"name": "", "type": "uint256"}],
    "stateMutability": "view",
    "type": "function"
  }
];

// Topics
const ORDER_FILLED_TOPIC = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(
  'OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'
));
const PAYOUT_REDEMPTION_TOPIC = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(
  'PayoutRedemption(address,address,bytes32,bytes32,uint256[],uint256)'
));

// In-memory state
let currentPositions = [];  // Synth's positions
let userPositions = [];     // New: Your positions
let recentTrades = [];      // Includes trades and redeems; last 5
const MAX_TRADES = 5;

// Global provider
let provider;

// Global ratio (for dynamic use)
let currentRatio = 0;

// Global values for recommendations
let synthPositionsValue = 0;
let userCollateral = 0;

// Function to sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to fetch aggregated positions value via Data API
async function getPositionsValue(address) {
  try {
    const response = await axios.get(`${DATA_API_URL}/value`, {
      params: { user: address }
    });
    return parseFloat(response.data[0]?.value || 0);
  } catch (error) {
    console.error(colors.red + `Error fetching positions value for ${address}:` + colors.reset, error.message);
    return 0;
  }
}

// Helper to fetch USDC collateral balance on-chain
async function getCollateral(address) {
  try {
    const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
    const rawBalance = await usdcContract.balanceOf(address);
    return parseFloat(ethers.utils.formatUnits(rawBalance, 6));
  } catch (error) {
    console.error(colors.red + `Error fetching collateral for ${address}:` + colors.reset, error.message);
    return 0;
  }
}

// New: Function to refresh and log ratio dynamically
async function refreshRatio() {
  console.log(colors.green + 'Refreshing balances...' + colors.reset);
  synthPositionsValue = await getPositionsValue(SYNTH_ADDRESS);
  const synthCollateral = await getCollateral(SYNTH_ADDRESS);
  const synthTotal = synthPositionsValue + synthCollateral;
  const userPositions = await getPositionsValue(USER_ADDRESS);
  userCollateral = await getCollateral(USER_ADDRESS);
  const userTotal = userPositions + userCollateral;
  const newRatio = synthPositionsValue > 0 ? userTotal / synthPositionsValue : 0;

  // Log only if significant change
  if (Math.abs(newRatio - currentRatio) > 0.001) {
    console.log(`${colors.cyan}Synth Positions: $${synthPositionsValue.toFixed(2)} | Collateral: $${synthCollateral.toFixed(2)} | Total: $${synthTotal.toFixed(2)}${colors.reset}`);
    console.log(`${colors.cyan}User Positions: $${userPositions.toFixed(2)} | Collateral: $${userCollateral.toFixed(2)} | Total: $${userTotal.toFixed(2)}${colors.reset}`);
    console.log(colors.bold + `Updated Copy Ratio: ${newRatio.toFixed(4)}` + colors.reset);
    currentRatio = newRatio;
  } else {
    console.log(colors.gray + 'Ratio unchanged.' + colors.reset);
  }
}

// Helper to create a unique key for a position (market title + outcome)
function getPositionKey(position) {
  return `${position.title.toLowerCase()}|${position.outcome.toLowerCase()}`;
}

// New: Function to compute and log diffs between old and new positions
function computeAndLogPositionDiffs(oldPositions, newPositions) {
  const oldMap = new Map(oldPositions.map(p => [getPositionKey(p), p]));
  const newMap = new Map(newPositions.map(p => [getPositionKey(p), p]));

  console.log(colors.bold + colors.yellow + '\n=== SYNTH POSITION STATE CHANGES ===' + colors.reset);

  let hasChanges = false;

  // Check for added or increased positions
  for (const [key, newPos] of newMap) {
    const oldPos = oldMap.get(key);
    if (!oldPos) {
      // New position
      console.log(colors.green + `New Position Added: ${newPos.title} (${newPos.outcome})` + colors.reset);
      console.log(`Size: ${parseFloat(newPos.size).toFixed(2)} | Avg Price: $${parseFloat(newPos.avgPrice).toFixed(4)}`);
      hasChanges = true;
    } else {
      const oldSize = parseFloat(oldPos.size);
      const newSize = parseFloat(newPos.size);
      if (newSize > oldSize) {
        // Increased
        const delta = newSize - oldSize;
        console.log(colors.green + `Position Increased: ${newPos.title} (${newPos.outcome})` + colors.reset);
        console.log(`Delta: +${delta.toFixed(2)} shares | New Size: ${newSize.toFixed(2)} | New Avg: $${parseFloat(newPos.avgPrice).toFixed(4)} (Old Avg: $${parseFloat(oldPos.avgPrice).toFixed(4)})`);
        hasChanges = true;
      } else if (newSize < oldSize) {
        // Decreased (should be handled in sells, but for completeness)
        const delta = oldSize - newSize;
        console.log(colors.red + `Position Decreased: ${newPos.title} (${newPos.outcome})` + colors.reset);
        console.log(`Delta: -${delta.toFixed(2)} shares | New Size: ${newSize.toFixed(2)} | New Avg: $${parseFloat(newPos.avgPrice).toFixed(4)} (Old Avg: $${parseFloat(oldPos.avgPrice).toFixed(4)})`);
        hasChanges = true;
      }
    }
  }

  // Check for removed positions
  for (const [key, oldPos] of oldMap) {
    if (!newMap.has(key)) {
      // Removed (sold out or redeemed)
      console.log(colors.red + `Position Removed: ${oldPos.title} (${oldPos.outcome})` + colors.reset);
      console.log(`Previous Size: ${parseFloat(oldPos.size).toFixed(2)} | Avg Price: $${parseFloat(oldPos.avgPrice).toFixed(4)}`);
      hasChanges = true;
    }
  }

  if (!hasChanges) {
    console.log(colors.gray + 'No significant position changes detected.' + colors.reset);
  }

  console.log(colors.bold + colors.yellow + '--- End of Synth Position State Changes ---' + colors.reset + '\n');
}

// New: Function to compute and log recommended initial replications
function computeAndLogRecommendedReplications(mapped) {
  console.log(colors.bold + colors.blue + '\n=== RECOMMENDED INITIAL POSITIONS TO REPLICATE (based on ratio and min size) ===' + colors.reset);

  let cumulativeCost = 0;
  let recommended = [];
  const bufferFactor = 0.9;  // 90% of collateral to leave buffer for fees/slippage
  const maxBudget = userCollateral * bufferFactor;

  mapped.forEach(p => {
    const synthQty = parseFloat(p.quantity);
    let scaledQty = synthQty * currentRatio;
    scaledQty = Math.floor(scaledQty * 10000) / 10000;  // Round to 4 decimals

    if (scaledQty >= 5) {
      const estCost = scaledQty * parseFloat(p.currentPrice);
      if (cumulativeCost + estCost <= maxBudget) {
        recommended.push({
          market: p.market,
          outcome: p.outcome,
          scaledQty: scaledQty.toFixed(4),
          estCost: estCost.toFixed(2),
          currentPrice: p.currentPrice
        });
        cumulativeCost += estCost;
      }
    }
  });

  if (recommended.length === 0) {
    console.log(colors.gray + 'No positions meet the criteria for replication (e.g., min 5 shares after scaling).' + colors.reset);
  } else {
    recommended.forEach((r, index) => {
      console.log(colors.cyan + `Recommended Position ${index + 1}:` + colors.reset + ` ${r.market} (${r.outcome})`);
      console.log(`${colors.magenta}Scaled Qty:${colors.reset} ${r.scaledQty} | ${colors.magenta}Est Cost:${colors.reset} $${r.estCost} | ${colors.magenta}Curr Price:${colors.reset} $${r.currentPrice}`);
      console.log(colors.gray + '─'.repeat(80) + colors.reset);
    });
    console.log(colors.bold + `Total Estimated Cost: $${cumulativeCost.toFixed(2)} (within $${maxBudget.toFixed(2)} budget)` + colors.reset);
  }

  console.log(colors.bold + colors.blue + '--- End of Recommended Initial Positions ---' + colors.reset + '\n');
}

// Fetch Synth positions
async function fetchPositions(print = false) {
  try {
    // Store old state before fetching new
    const oldPositions = [...currentPositions];

    const response = await axios.get(`${DATA_API_URL}/positions`, {
      params: { user: SYNTH_ADDRESS, limit: 1000 }
    });
    currentPositions = response.data;

    // Compute and log diffs if not initial fetch
    if (oldPositions.length > 0) {
      computeAndLogPositionDiffs(oldPositions, currentPositions);
    }

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
      }).filter(p => parseFloat(p.currentPrice) !== 0 && parseFloat(p.currentPrice) !== 1)  // Filter out resolved ($0 or $1)
        .sort((a, b) => parseFloat(b.value) - parseFloat(a.value));

      console.log(colors.bold + colors.blue + '\n=== SYNTH CURRENT ACTIVE POSITIONS (sorted by value) ===' + colors.reset);
      let activeTotal = 0;
      mapped.forEach((p, index) => {
        activeTotal += parseFloat(p.value);
        const pnlColor = p.pnlNum > 0 ? colors.green : p.pnlNum < 0 ? colors.red : colors.gray;
        console.log(colors.cyan + `Position ${index + 1}:` + colors.reset + ` ${p.market} (${p.outcome})`);
        console.log(`${colors.magenta}Qty:${colors.reset} ${p.quantity} | ${colors.magenta}Value:${colors.reset} $${p.value} | ${colors.magenta}Avg Price:${colors.reset} $${p.avgPrice}`);
        console.log(`${colors.magenta}Curr Price:${colors.reset} $${p.currentPrice} | ${colors.magenta}PnL:${colors.reset} ${pnlColor}${p.pnl}${colors.reset}`);
        console.log(colors.gray + '─'.repeat(80) + colors.reset);
      });
      console.log(colors.bold + `Synth Active Positions Total Value: $${activeTotal.toFixed(2)} (excluding resolved positions)` + colors.reset);
      console.log(colors.bold + colors.blue + '--- End of Synth Active Positions ---' + colors.reset + '\n');

      // On initial print, compute and log recommendations
      computeAndLogRecommendedReplications(mapped);
    }
  } catch (error) {
    console.error(colors.red + 'Error fetching Synth positions:' + colors.reset, error.message);
  }
}

// New: Fetch user positions (symmetric to fetchPositions)
async function fetchUserPositions(print = false) {
  try {
    const response = await axios.get(`${DATA_API_URL}/positions`, {
      params: { user: USER_ADDRESS, limit: 1000 }
    });
    userPositions = response.data;

    if (print) {
      // Map + calculate PnL % + sort by value descending (like UI)
      const mapped = userPositions.map(p => {
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
      }).filter(p => parseFloat(p.currentPrice) !== 0 && parseFloat(p.currentPrice) !== 1)  // Filter out resolved ($0 or $1)
        .sort((a, b) => parseFloat(b.value) - parseFloat(a.value));

      console.log(colors.bold + colors.blue + '\n=== USER CURRENT ACTIVE POSITIONS (sorted by value) ===' + colors.reset);
      let activeTotal = 0;
      if (mapped.length === 0) {
        console.log(colors.gray + 'No active positions currently.' + colors.reset);
      } else {
        mapped.forEach((p, index) => {
          activeTotal += parseFloat(p.value);
          const pnlColor = p.pnlNum > 0 ? colors.green : p.pnlNum < 0 ? colors.red : colors.gray;
          console.log(colors.cyan + `Position ${index + 1}:` + colors.reset + ` ${p.market} (${p.outcome})`);
          console.log(`${colors.magenta}Qty:${colors.reset} ${p.quantity} | ${colors.magenta}Value:${colors.reset} $${p.value} | ${colors.magenta}Avg Price:${colors.reset} $${p.avgPrice}`);
          console.log(`${colors.magenta}Curr Price:${colors.reset} $${p.currentPrice} | ${colors.magenta}PnL:${colors.reset} ${pnlColor}${p.pnl}${colors.reset}`);
          console.log(colors.gray + '─'.repeat(80) + colors.reset);
        });
      }
      console.log(colors.bold + `User Active Positions Total Value: $${activeTotal.toFixed(2)}` + colors.reset);
      console.log(colors.bold + colors.blue + '--- End of User Active Positions ---' + colors.reset + '\n');
    }
  } catch (error) {
    console.error(colors.red + 'Error fetching user positions:' + colors.reset, error.message);
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

  const iface = new ethers.utils.Interface([`event OrderFilled(
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
    ? (makerAssetId.eq(0)) 
    : (takerAssetId.eq(0));
  const side = isBuy ? 'BUY' : 'SELL';

  const outcomeTokenId = (makerAssetId.eq(0)) ? takerAssetId : makerAssetId;
  const usdcAmount = (makerAssetId.eq(0)) ? decoded.args.makerAmountFilled : decoded.args.takerAmountFilled;
  const tokenAmount = (makerAssetId.eq(0)) ? decoded.args.takerAmountFilled : decoded.args.makerAmountFilled;
  const price = usdcAmount.toNumber() / tokenAmount.toNumber();

  const { market, outcome } = await resolveTokenId(outcomeTokenId);

  const trade = {
    time: new Date().toISOString().split('T')[1].split('.')[0],
    side,
    market,
    outcome,
    shares: parseFloat(ethers.utils.formatUnits(tokenAmount, 6)).toFixed(2),
    usdc: parseFloat(ethers.utils.formatUnits(usdcAmount, 6)).toFixed(2),
    price: price.toFixed(4),
    tx: log.transactionHash
  };

  addToRecentTrades(trade);
}

// Handle redeem log
async function handleRedeemLog(log) {
  if (log.address.toLowerCase() !== CTF_CONTRACT) return;
  if (log.topics[0] !== PAYOUT_REDEMPTION_TOPIC) return;

  const iface = new ethers.utils.Interface([`event PayoutRedemption(
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
  // Assume binary market; indexSets[0] == 1 for 'Yes' (index 0), 2 for 'No' (index 1)
  const outcomeIndex = indexSets[0].eq(1) ? 0 : 1;
  const outcomes = JSON.parse(marketData?.outcomes || '[]');
  const outcome = outcomes[outcomeIndex] || 'Unknown';
  const shares = parseFloat(ethers.utils.formatUnits(payout, 6)).toFixed(2);

  const trade = {
    time: new Date().toISOString().split('T')[1].split('.')[0],
    side: 'REDEEM',
    market,
    outcome,
    shares,
    usdc: parseFloat(ethers.utils.formatUnits(payout, 6)).toFixed(2),
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

  // Refresh positions to update state
  fetchPositions();

  // Refresh ratio after activity
  refreshRatio();
}

// Start tracker
function startTracker() {
  provider = new ethers.providers.WebSocketProvider(POLYGON_WS_URL);

  provider._websocket.on('open', async () => {
    console.log(colors.green + 'Connected to Polygon websocket' + colors.reset);

    // Initial refresh ratio
    await refreshRatio();

    // Periodic refresh every 5 minutes
    setInterval(refreshRatio, 300000);

    await fetchPositions(true);  // Initial Synth print with recommendations
    await fetchUserPositions(true);  // New: Initial user print
  });

  // Trade filter
  const tradeFilter = { address: EXCHANGE_CONTRACT, topics: [ORDER_FILLED_TOPIC] };
  provider.on(tradeFilter, handleTradeLog);

  // Redeem filter (filter by redeemer topic)
  const redeemTopics = [PAYOUT_REDEMPTION_TOPIC, ethers.utils.hexZeroPad(SYNTH_ADDRESS, 32)];
  const redeemFilter = { address: CTF_CONTRACT, topics: redeemTopics };
  provider.on(redeemFilter, handleRedeemLog);

  provider._websocket.on('close', () => {
    console.log(colors.yellow + 'WebSocket closed. Reconnecting...' + colors.reset);
    setTimeout(startTracker, 1000);
  });

  provider.on('error', err => console.error(colors.red + 'Provider Error:' + colors.reset, err));
  provider._websocket.on('error', err => console.error(colors.red + 'WebSocket Error:' + colors.reset, err));

  return provider;
}

startTracker();
console.log(colors.bold + 'Synth Tracker Bot Running... Monitoring address:' + colors.reset, SYNTH_ADDRESS);