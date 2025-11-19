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

// In-memory state
let currentPositions = [];  // Synth's positions
let userPositions = [];     // User's positions

// Global provider
let provider;

// Global values
let synthPositionsValue = 0;
let userPositionsValue = 0;
let userCollateral = 0;
let synthCollateral = 0;

// Set of known markets Synth has traded in (to detect new ones)
let knownSynthMarkets = new Set();

// Refresh timeout for debouncing
let refreshTimeout;

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

// Fetch Synth positions (updates known markets and value)
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
        return { market: market.question || 'Unknown', outcome, slug: market.slug || 'Unknown' };
      }
      return { market: 'Unknown', outcome: 'Unknown', slug: 'Unknown' };
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.log(`TokenId resolution attempt ${attempt + 1} failed (404) - retrying in 3s...`);
        await sleep(3000);
      } else {
        console.log('Error resolving tokenId (fallback to Unknown):', error.message);
        return { market: 'Unknown', outcome: 'Unknown', slug: 'Unknown' };
      }
    }
  }
  console.log('Failed to resolve tokenId after retries (fallback to Unknown)');
  return { market: 'Unknown', outcome: 'Unknown', slug: 'Unknown' };
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

  // Check if this is a new market (not in startup known markets)
  const marketKey = market.toLowerCase();
  const isNewMarket = !knownSynthMarkets.has(marketKey);

  const time = new Date().toISOString().split('T')[1].split('.')[0];
  const shares = parseFloat(ethers.utils.formatUnits(tokenAmount, 6)).toFixed(2);
  const usdc = parseFloat(ethers.utils.formatUnits(usdcAmount, 6)).toFixed(2);
  // const tx = log.transactionHash.slice(0, 10) + '...';
  const tx = log.transactionHash;

  const sideColor = isBuy ? colors.green : colors.red;

  if (isNewMarket) {
    // Full colored log for new markets
    console.log(colors.bold + colors.yellow + '\n🚨 NEW TRADE IN NEW MARKET!' + colors.reset);
    console.log(`${colors.cyan}Time:${colors.reset} ${time} | ${colors.cyan}Side:${colors.reset} ${sideColor}${side}${colors.reset} | ${colors.cyan}Outcome:${colors.reset} ${outcome}`);
    console.log(`${colors.cyan}Market:${colors.reset} ${market}`);
    console.log(`${colors.cyan}Shares:${colors.reset} ${shares} | ${colors.cyan}USDC:${colors.reset} $${usdc} | ${colors.cyan}Price:${colors.reset} $${price.toFixed(4)}`);
    console.log(`${colors.cyan}Tx:${colors.reset} https://polygonscan.com/tx/${tx}`);
    console.log(colors.gray + '─'.repeat(80) + colors.reset);
  } else {
    // Gray one-liner for pre-existing markets
    // console.log(colors.gray + `Minor trade: ${sideColor}${side}${colors.reset} ${shares} shares of ${outcome} in ${market} at $${price.toFixed(4)}\n(Tx: ${tx})` + colors.reset);
    console.log(colors.gray + `Minor trade: ${sideColor}${side}${colors.reset} ${shares} shares of ${outcome} in ${market} at $${price.toFixed(4)}` + colors.reset);
  }

  // Debounced refresh
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(refreshTotals, 10000);  // 10s debounce
}

// Start tracker
function startTracker() {
  provider = new ethers.providers.WebSocketProvider(POLYGON_WS_URL);

  provider._websocket.on('open', async () => {
    console.log(colors.green + 'Connected to Polygon websocket' + colors.reset);

    // Initial fetches
    await fetchPositions(true);  // Print initial Synth positions
    // Initialize known markets only once, from startup positions
    currentPositions.forEach(p => knownSynthMarkets.add(p.title.toLowerCase()));
    await fetchUserPositions(true);  // Print initial User positions
    await refreshTotals();  // Initial totals

    console.log(colors.bold + colors.yellow + `Initialized with ${knownSynthMarkets.size} known markets. Waiting for new trades...` + colors.reset);
  });

  // Trade filter
  const tradeFilter = { address: EXCHANGE_CONTRACT, topics: [ORDER_FILLED_TOPIC] };
  provider.on(tradeFilter, handleTradeLog);

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