const axios = require('axios');

const ACTIVITY_SUBGRAPH_URL = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/activity-subgraph/0.0.4/gn';

async function diagnoseSchema() {
    console.log("Querying 'Redemption' type definition...");

    const query = `
    query Introspection {
      __type(name: "Redemption") {
        name
        fields {
          name
          type {
            name
            kind
            ofType {
              name
              kind
            }
          }
        }
      }
    }`;

    try {
        const response = await axios.post(ACTIVITY_SUBGRAPH_URL, { query });
        if (response.data.errors) {
            console.error("Errors:", JSON.stringify(response.data.errors, null, 2));
        } else {
            const typeDef = response.data.data.__type;
            if (!typeDef) {
                console.log("Type 'Redemption' not found in schema.");
                return;
            }
            console.log(`\nFields on ${typeDef.name}:`);
            typeDef.fields.forEach(f => {
                // Handle nested types (e.g., Non-Null lists)
                let typeName = f.type.name;
                if (!typeName && f.type.ofType) {
                    typeName = f.type.ofType.name || "List/Wrapper";
                }
                console.log(` - ${f.name} (${typeName})`);
            });
        }
    } catch (e) {
        console.error("Request Failed:", e.message);
    }
}

diagnoseSchema();