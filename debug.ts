/**
 * Debug: test GraphQL with and without Cloudflare cookies
 */

const GRAPHQL_URL = "https://ws-api.toasttab.com/do-federated-gateway/v1/graphql";
const RESTAURANT_GUID = "4434b615-6b89-4797-9f9b-94eb4071acea";

const headers: Record<string, string> = {
  "accept": "*/*",
  "content-type": "application/json",
  "apollographql-client-name": "sites-web-client",
  "apollographql-client-version": "3059",
  "referer": "https://www.toasttab.com/",
  "origin": "https://www.toasttab.com",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "sec-ch-ua": '" Not;A Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Mac OS X"',
  "toast-session-id": "test12345678901234567890123456789012345",
  "toast-graphql-operation": "Restaurant",
  "toast-persistent-query-hash": "525542dec492a54f5b7112b1fbb8d71b1c1210a8",
};

const body = JSON.stringify([
  {
    operationName: "Restaurant",
    variables: { useOOFederatedConfigs: false, restaurantGuid: RESTAURANT_GUID },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: "525542dec492a54f5b7112b1fbb8d71b1c1210a8",
      },
    },
  },
]);

const res = await fetch(GRAPHQL_URL, { method: "POST", headers, body });

console.log("Status:", res.status);
console.log("Response headers:");
for (const [k, v] of res.headers.entries()) {
  if (["content-type", "cf-ray", "server", "set-cookie"].includes(k)) {
    console.log(`  ${k}: ${v}`);
  }
}

const text = await res.text();
console.log("\nBody preview:", text.slice(0, 1000));
