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
const USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'.toLowerCase();  // USDC contract on Polygon
const CTF_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045'.toLowerCase();  // ConditionalTokens contract
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

// Split ABI
const SPLIT_ABI = [
  'event PositionSplit(address indexed stakeholder, address collateralToken, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] partition, uint256 amount)'
];

// Topics
const ORDER_FILLED_TOPIC = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(
  'OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'
));
const POSITION_SPLIT_TOPIC = '0x16b28ada12662f609edc484c35fbaf6a23ebcaa786424b4f5e40961758203988';

// In-memory state
let currentPositions = [];  // Synth's positions
let userPositions = [];     // User's positions
let prevPositions = [];     // Previous Synth positions for delta calc

// Global provider
let provider;

// Global values
let synthPositionsValue = 0;
let userPositionsValue = 0;
let userCollateral = 0;
let synthCollateral = 0;

// Set of initial markets Synth had positions in at startup
let initialSynthMarkets = new Set();

// Set of tracked new markets (post-startup)
let trackedSynthMarkets = new Set();

// Map for accumulation in tracked markets: marketKey -> outcome -> {netQty: 0, netUsdc: 0}
let trackedMarketStats = new Map();

// Refresh timeout for debouncing
let refreshTimeout;

// Pending tx groups for atomic processing
let pendingTxs = new Map();

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

// Function to refresh and log totals dynamically
async function refreshTotals() {
  await fetchPositions();
  await fetchUserPositions();
  synthCollateral = await getCollateral(SYNTH_ADDRESS);
  userCollateral = await getCollateral(USER_ADDRESS);
  console.log(`${colors.cyan}Synth Positions: $${synthPositionsValue.toFixed(2)} | Collateral: $${synthCollateral.toFixed(2)} | Total: $${(synthPositionsValue + synthCollateral).toFixed(2)}${colors.reset}`);
  console.log(`${colors.cyan}User Positions: $${userPositionsValue.toFixed(2)} | Collateral: $${userCollateral.toFixed(2)} | Total: $${(userPositionsValue + userCollateral).toFixed(2)}${colors.reset}`);
}

// Fetch Synth positions (updates value)
async function fetchPositions(print = false) {
  try {
    const response = await axios.get(`${DATA_API_URL}/positions`, {
      params: { user: SYNTH_ADDRESS, limit: 1000 }
    });
    currentPositions = response.data;

    // Calculate positions value
    const mapped = currentPositions.map(p => {
      const qty = parseFloat(p.size);
      const value = parseFloat(p.currentValue);
      const avg = parseFloat(p.avgPrice);
      const currentPrice = qty > 0 ? value / qty : 0;
      return {
        market: p.title,
        outcome: p.outcome,
        quantity: qty.toFixed(2),
        value: value.toFixed(2),
        avgPrice: avg.toFixed(2),
        currentPrice: currentPrice.toFixed(2)
      };
    }).sort((a, b) => parseFloat(b.value) - parseFloat(a.value));

    synthPositionsValue = 0;
    mapped.forEach(p => {
      synthPositionsValue += parseFloat(p.value);
    });

    if (print) {
      console.log(colors.bold + colors.blue + '\n=== SYNTH CURRENT ACTIVE POSITIONS (sorted by value) ===' + colors.reset);
      console.log(colors.bold + `Synth Active Positions Total Value: $${synthPositionsValue.toFixed(2)}` + colors.reset);
      if (mapped.length === 0) {
        console.log(colors.gray + 'No active positions currently.' + colors.reset);
      } else {
        mapped.forEach((p, index) => {
          console.log(colors.cyan + `Position ${index + 1}:` + colors.reset + ` ${p.market} (${p.outcome})`);
          console.log(`${colors.magenta}Qty:${colors.reset} ${p.quantity} | ${colors.magenta}Value:${colors.reset} $${p.value} | ${colors.magenta}Avg Price:${colors.reset} $${p.avgPrice}`);
          console.log(`${colors.magenta}Curr Price:${colors.reset} $${p.currentPrice}`);
          console.log(colors.gray + '─'.repeat(80) + colors.reset);
        });
      }
      console.log(colors.bold + colors.blue + '--- End of Synth Active Positions ---' + colors.reset + '\n');
    }
  } catch (error) {
    console.error(colors.red + 'Error fetching Synth positions:' + colors.reset, error.message);
  }
}

// Fetch user positions
async function fetchUserPositions(print = false) {
  try {
    const response = await axios.get(`${DATA_API_URL}/positions`, {
      params: { user: USER_ADDRESS, limit: 1000 }
    });
    userPositions = response.data;

    // Calculate positions value
    const mapped = userPositions.map(p => {
      const qty = parseFloat(p.size);
      const value = parseFloat(p.currentValue);
      const avg = parseFloat(p.avgPrice);
      const currentPrice = qty > 0 ? value / qty : 0;
      return {
        market: p.title,
        outcome: p.outcome,
        quantity: qty.toFixed(2),
        value: value.toFixed(2),
        avgPrice: avg.toFixed(2),
        currentPrice: currentPrice.toFixed(2)
      };
    }).sort((a, b) => parseFloat(b.value) - parseFloat(a.value));

    userPositionsValue = 0;
    mapped.forEach(p => {
      userPositionsValue += parseFloat(p.value);
    });

    if (print) {
      console.log(colors.bold + colors.blue + '\n=== USER CURRENT ACTIVE POSITIONS (sorted by value) ===' + colors.reset);
      console.log(colors.bold + `User Active Positions Total Value: $${userPositionsValue.toFixed(2)}` + colors.reset);
      if (mapped.length === 0) {
        console.log(colors.gray + 'No active positions currently.' + colors.reset);
      } else {
        mapped.forEach((p, index) => {
          console.log(colors.cyan + `Position ${index + 1}:` + colors.reset + ` ${p.market} (${p.outcome})`);
          console.log(`${colors.magenta}Qty:${colors.reset} ${p.quantity} | ${colors.magenta}Value:${colors.reset} $${p.value} | ${colors.magenta}Avg Price:${colors.reset} $${p.avgPrice}`);
          console.log(`${colors.magenta}Curr Price:${colors.reset} $${p.currentPrice}`);
          console.log(colors.gray + '─'.repeat(80) + colors.reset);
        });
      }
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
        return { market: market.question || 'Unknown', outcome, slug: market.slug || 'Unknown', conditionId: market.conditionId };
      }
      return { market: 'Unknown', outcome: 'Unknown', slug: 'Unknown', conditionId: 'Unknown' };
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.log(`TokenId resolution attempt ${attempt + 1} failed (404) - retrying in 3s...`);
        await sleep(3000);
      } else {
        console.log('Error resolving tokenId (fallback to Unknown):', error.message);
        return { market: 'Unknown', outcome: 'Unknown', slug: 'Unknown', conditionId: 'Unknown' };
      }
    }
  }
  console.log('Failed to resolve tokenId after retries (fallback to Unknown)');
  return { market: 'Unknown', outcome: 'Unknown', slug: 'Unknown', conditionId: 'Unknown' };
}

// Resolve conditionId → market info
async function resolveConditionId(conditionId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await axios.get(`${GAMMA_API_URL}/markets`, {
        params: { condition_ids: conditionId, limit: 1 }
      });
      if (response.data.length > 0) {
        const market = response.data[0];
        const outcomes = JSON.parse(market.outcomes || '[]');
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        return { market: market.question || 'Unknown', outcomes, slug: market.slug || 'Unknown', tokenIds };
      }
      return null;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.log(`ConditionId resolution attempt ${attempt + 1} failed (404) - retrying in 3s...`);
        await sleep(3000);
      } else {
        console.log('Error resolving conditionId:', error.message);
        return null;
      }
    }
  }
  console.log('Failed to resolve conditionId after retries');
  return null;
}

// Update accumulation stats for tracked markets
function updateTrackedStats(marketKey, outcome, isBuy, sharesNum, usdcNum) {
  if (!trackedMarketStats.has(marketKey)) {
    trackedMarketStats.set(marketKey, new Map());
  }
  const outcomeStats = trackedMarketStats.get(marketKey);
  if (!outcomeStats.has(outcome)) {
    outcomeStats.set(outcome, { netQty: 0, netUsdc: 0 });
  }
  const stats = outcomeStats.get(outcome);
  const qtyDelta = isBuy ? sharesNum : -sharesNum;
  const usdcDelta = isBuy ? -usdcNum : usdcNum;  // Buy spends USDC (negative), sell receives (positive)
  stats.netQty += qtyDelta;
  stats.netUsdc += usdcDelta;
}

// Compute deltas from prev to current positions
function computeDeltas(prev, curr) {
  const deltaMap = new Map();
  const prevMap = new Map();
  prev.forEach(p => {
    const key = `${p.title.toLowerCase()}_${p.outcome.toLowerCase()}`;
    prevMap.set(key, { size: parseFloat(p.size), value: parseFloat(p.currentValue) });
  });

  curr.forEach(p => {
    const key = `${p.title.toLowerCase()}_${p.outcome.toLowerCase()}`;
    const prevData = prevMap.get(key) || { size: 0, value: 0 };
    const deltaQty = parseFloat(p.size) - prevData.size;
    if (deltaQty !== 0) {
      const marketKey = p.title.toLowerCase();
      if (!deltaMap.has(marketKey)) deltaMap.set(marketKey, new Map());
      deltaMap.get(marketKey).set(p.outcome, { deltaQty });
    }
    prevMap.delete(key);  // Remove to check for closed
  });

  // For closed positions (in prev but not curr)
  for (const [key, prevData] of prevMap) {
    if (prevData.size > 0) {
      const [marketKey, outcome] = key.split('_');
      if (!deltaMap.has(marketKey)) deltaMap.set(marketKey, new Map());
      deltaMap.get(marketKey).set(outcome, { deltaQty: -prevData.size });
    }
  }

  return deltaMap;
}

// Process grouped tx events
async function processTxGroup(txHash) {
  const group = pendingTxs.get(txHash);
  if (!group) return;
  pendingTxs.delete(txHash);
  clearTimeout(group.timeout);

  let marketKey = null;
  let isInitialMarket = true;
  let isFirstInMarket = false;
  let txShort = txHash.slice(0, 10) + '...';
  let time = new Date().toISOString().split('T')[1].split('.')[0];

  console.log(colors.bold + colors.yellow + `\n=== Atomic Tx Group: https://polygonscan.com/tx/${txHash} ===` + colors.reset);
  console.log(`${colors.cyan}Time:${colors.reset} ${time}`);

  // Process splits first
  for (const split of group.splits) {
    const conditionId = split.conditionId;
    const marketInfo = await resolveConditionId(conditionId);
    if (!marketInfo) {
      console.log(colors.gray + 'Unknown market for split' + colors.reset);
      continue;
    }
    marketKey = marketInfo.market.toLowerCase();
    isInitialMarket = initialSynthMarkets.has(marketKey);
    isFirstInMarket = !trackedSynthMarkets.has(marketKey) && !isInitialMarket;

    if (split.partition.length !== 2) {
      console.log(colors.gray + 'Non-binary partition - skipping' + colors.reset);
      continue;
    }

    const amountNum = parseFloat(ethers.utils.formatUnits(split.amount, 6));
    const collateralSpent = amountNum;  // Mint spends this USDC

    console.log(colors.green + `Mint: ${amountNum.toFixed(2)} shares each for outcomes ${marketInfo.outcomes.join('/')} (Collateral: $${collateralSpent.toFixed(2)})` + colors.reset);

    for (let i = 0; i < 2; i++) {
      const outcome = marketInfo.outcomes[i];
      updateTrackedStats(marketKey, outcome, true, amountNum, 0);  // Add qty, usdc 0 (collateral separate)
    }

    // Track market if new
    if (!isInitialMarket && isFirstInMarket) {
      trackedSynthMarkets.add(marketKey);
    }
  }

  // Process fills
  for (const fill of group.fills) {
    const maker = fill.maker.toLowerCase();
    const taker = fill.taker.toLowerCase();
    if (maker !== SYNTH_ADDRESS && taker !== SYNTH_ADDRESS) continue;

    const isSynthMaker = maker === SYNTH_ADDRESS;
    const makerAssetId = fill.makerAssetId;
    const takerAssetId = fill.takerAssetId;

    const isBuy = isSynthMaker ? makerAssetId.eq(0) : !takerAssetId.eq(0);
    const side = isBuy ? 'BUY' : 'SELL';

    const outcomeTokenId = makerAssetId.eq(0) ? takerAssetId : makerAssetId;
    const usdcAmount = makerAssetId.eq(0) ? fill.makerAmountFilled : fill.takerAmountFilled;
    const tokenAmount = makerAssetId.eq(0) ? fill.takerAmountFilled : fill.makerAmountFilled;
    const price = usdcAmount.toNumber() / tokenAmount.toNumber();

    const { market, outcome } = await resolveTokenId(outcomeTokenId);

    marketKey = market.toLowerCase();
    isInitialMarket = initialSynthMarkets.has(marketKey);
    isFirstInMarket = !trackedSynthMarkets.has(marketKey) && !isInitialMarket;

    const shares = parseFloat(ethers.utils.formatUnits(tokenAmount, 6)).toFixed(2);
    const sharesNum = parseFloat(shares);
    const usdc = parseFloat(ethers.utils.formatUnits(usdcAmount, 6)).toFixed(2);
    const usdcNum = parseFloat(usdc);

    const sideColor = isBuy ? colors.green : colors.red;

    if (!isInitialMarket) {
      console.log(`${colors.cyan}Side:${colors.reset} ${sideColor}${side}${colors.reset} | ${colors.cyan}Outcome:${colors.reset} ${outcome} | Shares: ${shares} | USDC: $${usdc} | Price: $${price.toFixed(4)}`);
    }

    if (!isInitialMarket) {
      if (isFirstInMarket) {
        trackedSynthMarkets.add(marketKey);
      }
      updateTrackedStats(marketKey, outcome, isBuy, sharesNum, usdcNum);
    }
  }

  // Log updated accumulations if not initial
  if (!isInitialMarket && marketKey) {
    const banner = isFirstInMarket ? '🚨 NEW TRADE IN NEW MARKET!' : '🚨 FOLLOW-UP TRADE IN TRACKED MARKET!';
    console.log(colors.bold + colors.yellow + banner + colors.reset);
    console.log(`${colors.cyan}Market:${colors.reset} ${marketKey}`);

    const outcomeStats = trackedMarketStats.get(marketKey) || new Map();
    for (const [outcome, stats] of outcomeStats) {
      console.log(colors.bold + colors.magenta + `Updated Accumulation (${outcome}): Net Qty: ${stats.netQty.toFixed(2)} shares | Net USDC: $${stats.netUsdc.toFixed(2)}` + colors.reset);
    }
  } else {
    console.log(colors.gray + 'Minor atomic trade in initial market' + colors.reset);
  }

  console.log(colors.gray + '─'.repeat(80) + colors.reset);

  // Debounced refresh and delta calc
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(async () => {
    const prev = JSON.parse(JSON.stringify(prevPositions));
    await refreshTotals();
    const deltas = computeDeltas(prev, currentPositions);
    for (const [mKey, oDeltas] of deltas) {
      if (trackedSynthMarkets.has(mKey)) {
        for (const [outcome, delta] of oDeltas) {
          updateTrackedStats(mKey, outcome, delta.deltaQty > 0, Math.abs(delta.deltaQty), 0);  // Update with delta qty, usdc 0 (since trade usdc already added)
        }
      }
    }
    prevPositions = JSON.parse(JSON.stringify(currentPositions));
  }, 10000);
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

  const txHash = log.transactionHash;

  if (!pendingTxs.has(txHash)) {
    pendingTxs.set(txHash, { splits: [], fills: [], timeout: setTimeout(() => processTxGroup(txHash), 2000) });
  }
  const group = pendingTxs.get(txHash);
  group.fills.push(decoded.args);
}

// Handle split log
async function handleSplitLog(log) {
  if (log.address.toLowerCase() !== CTF_ADDRESS) return;
  if (log.topics[0] !== POSITION_SPLIT_TOPIC) return;

  const iface = new ethers.utils.Interface(SPLIT_ABI);
  const decoded = iface.parseLog(log);

  const stakeholder = decoded.args.stakeholder.toLowerCase();
  if (stakeholder !== SYNTH_ADDRESS) return;

  const txHash = log.transactionHash;

  if (!pendingTxs.has(txHash)) {
    pendingTxs.set(txHash, { splits: [], fills: [], timeout: setTimeout(() => processTxGroup(txHash), 2000) });
  }
  const group = pendingTxs.get(txHash);
  group.splits.push(decoded.args);
}

// Start tracker
function startTracker() {
  provider = new ethers.providers.WebSocketProvider(POLYGON_WS_URL);

  provider._websocket.on('open', async () => {
    console.log(colors.green + 'Connected to Polygon websocket' + colors.reset);

    // Initial fetches
    await fetchPositions(true);  // Print initial Synth positions
    // Initialize initial markets only once, from startup positions
    currentPositions.forEach(p => initialSynthMarkets.add(p.title.toLowerCase()));
    prevPositions = JSON.parse(JSON.stringify(currentPositions));
    await fetchUserPositions(true);  // Print initial User positions
    await refreshTotals();  // Initial totals

    console.log(colors.bold + colors.yellow + `Initialized with ${initialSynthMarkets.size} initial markets. Waiting for new trades...` + colors.reset);
  });

  // Trade filter
  const tradeFilter = { address: EXCHANGE_CONTRACT, topics: [ORDER_FILLED_TOPIC] };
  provider.on(tradeFilter, handleTradeLog);

  // Split filter
  const splitFilter = { address: CTF_ADDRESS, topics: [POSITION_SPLIT_TOPIC] };
  provider.on(splitFilter, handleSplitLog);

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