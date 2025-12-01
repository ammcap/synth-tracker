const axios = require('axios');

// The Goldsky Endpoint we are trying to hit
const SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn';

async function checkSchema() {
    console.log("Querying Schema...");

    // "Introspection Query" - asks the server to list all fields on the root 'Query' object
    const query = `
    query Introspection {
      __schema {
        queryType {
          fields {
            name
          }
        }
      }
    }`;

    try {
        const response = await axios.post(SUBGRAPH_URL, { query });

        if (response.data.errors) {
            console.error("Errors:", JSON.stringify(response.data.errors, null, 2));
        } else {
            const fields = response.data.data.__schema.queryType.fields;
            console.log("\nAVAILABLE FIELDS:");
            // Filter out system fields (starting with __) and print the rest
            fields
                .map(f => f.name)
                .filter(n => !n.startsWith('__'))
                .forEach(name => console.log(` - ${name}`));
        }
    } catch (e) {
        console.error("Request Failed:", e.message);
    }
}

checkSchema();