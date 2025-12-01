const axios = require('axios');

// Official Goldsky "Activity" Subgraph Endpoint
const ACTIVITY_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/activity-subgraph/0.0.4/gn';

async function checkSchema() {
    console.log("Querying Activity Subgraph Schema...");

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
        const response = await axios.post(ACTIVITY_SUBGRAPH_URL, { query });

        if (response.data.errors) {
            console.error("Errors:", JSON.stringify(response.data.errors, null, 2));
        } else {
            const fields = response.data.data.__schema.queryType.fields;
            console.log("\nAVAILABLE FIELDS:");
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