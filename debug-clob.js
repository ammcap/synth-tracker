const { ClobClient, createL2Headers } = require('@polymarket/clob-client');
const { ethers } = require('ethers');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const SYNTH_ADDRESS = '0x557bed924a1bb6f62842c5742d1dc789b8d480d4';
const CLOB_API_URL = 'https://clob.polymarket.com';

async function debugTrades() {
    console.log("🔍 Debugging CLOB Trades Response...");

    try {
        const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
        const signer = new ethers.Wallet(process.env.PHANTOM_POLYGON_WALLET_PRIVATE_KEY, provider);

        const creds = {
            key: process.env.API_KEY,
            secret: process.env.API_SECRET,
            passphrase: process.env.API_PASSPHRASE
        };

        const headers = await createL2Headers(signer, creds, {
            method: 'GET',
            requestPath: '/data/trades'
        });

        const resp = await axios.get(`${CLOB_API_URL}/data/trades`, {
            headers: headers,
            params: {
                maker_address: SYNTH_ADDRESS,
                limit: 2 // Fetch just 2 items
            }
        });

        console.log("\n⬇️ RAW RESPONSE KEYS ⬇️");
        console.log(Object.keys(resp.data));

        let trades = [];
        if (Array.isArray(resp.data)) trades = resp.data;
        else if (resp.data.data) trades = resp.data.data;
        else if (resp.data.trades) trades = resp.data.trades;

        if (trades.length > 0) {
            console.log("\n⬇️ FIRST TRADE OBJECT (RAW) ⬇️");
            console.log(JSON.stringify(trades[0], null, 2));

            console.log("\n🧪 TYPE CHECKS:");
            const t = trades[0];
            console.log(`timestamp type: ${typeof t.timestamp}`);
            console.log(`timestamp value: ${t.timestamp}`);

            // Test the crash logic
            try {
                const dateTest = new Date(t.timestamp * 1000).toISOString();
                console.log(`✅ Date Parse Success: ${dateTest}`);
            } catch (e) {
                console.log(`❌ Date Parse Failed: ${e.message}`);
            }
        } else {
            console.log("⚠️ No trades found in response.");
        }

    } catch (e) {
        console.error("DEBUG ERROR:", e.message);
        if (e.response) console.log("API Status:", e.response.status, e.response.data);
    }
}

debugTrades();