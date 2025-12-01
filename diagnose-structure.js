const axios = require('axios');

const SYNTH_ADDRESS = '0x557bed924a1bb6f62842c5742d1dc789b8d480d4'.toLowerCase();
const ORDERBOOK_URL = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn';
const ACTIVITY_URL = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/activity-subgraph/0.0.4/gn';

async function diagnose() {
    console.log("--- DIAGNOSING DATA STRUCTURE ---");

    // 1. Check Trade Structure (We know these exist, just need to see fields)
    console.log("\n1. Inspecting TRADE event fields...");
    try {
        const query = `
        {
            orderFilledEvents(first: 1, orderBy: timestamp, orderDirection: desc) {
                id
                maker
                makerAssetId
                takerAssetId
                makerAmountFilled
            }
        }`;
        const res = await axios.post(ORDERBOOK_URL, { query });
        const item = res.data.data.orderFilledEvents[0];
        console.log("RAW TRADE DATA:", JSON.stringify(item, null, 2));
    } catch (e) { console.error("Trade fetch failed:", e.message); }

    // 2. Check Redeem Structure (Try to find ANY redeem to check field names)
    console.log("\n2. Inspecting REDEEM event fields (Schema Check)...");
    try {
        // Introspection to find the correct column name for "User/Redeemer"
        const schemaQuery = `
        query {
          __type(name: "Redemption") {
            fields {
              name
            }
          }
        }`;
        const res = await axios.post(ACTIVITY_URL, { query: schemaQuery });
        const fields = res.data.data.__type.fields.map(f => f.name);
        console.log("VALID REDEMPTION COLUMNS:", fields.join(", "));
    } catch (e) { console.error("Redeem schema check failed:", e.message); }
}

diagnose();