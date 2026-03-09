/**
 * Header Interceptor - Discovers what headers Toast's frontend sends to the GraphQL API
 * Run: bun intercept.ts
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const TARGET_URL = "https://www.toasttab.com/local/order/chiguacle-placita";
const GRAPHQL_URL = "https://ws-api.toasttab.com/do-federated-gateway/v1/graphql";

async function interceptGraphQLHeaders() {
  const browser = await chromium.launch({ headless: false }); // visible so we can see Cloudflare
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  const capturedRequests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    postData: string | null;
  }> = [];

  // Intercept all requests to the GraphQL endpoint
  page.on("request", (request) => {
    if (request.url().includes("graphql")) {
      capturedRequests.push({
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: request.postData(),
      });
      console.log(`\n🎯 Captured GraphQL request #${capturedRequests.length}`);
    }
  });

  console.log(`🌐 Navigating to: ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 120000 });

  // Wait for page to fully load and make GraphQL calls
  console.log("⏳ Waiting for GraphQL requests...");
  await page.waitForTimeout(15000);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`📦 Captured ${capturedRequests.length} GraphQL request(s)`);
  console.log(`${"=".repeat(80)}`);

  for (const [i, req] of capturedRequests.entries()) {
    console.log(`\n--- Request #${i + 1} ---`);
    console.log(`URL: ${req.url}`);
    console.log(`Method: ${req.method}`);
    console.log(`\nHeaders:`);
    for (const [key, value] of Object.entries(req.headers)) {
      console.log(`  ${key}: ${value}`);
    }
    if (req.postData) {
      try {
        const parsed = JSON.parse(req.postData);
        const operations = Array.isArray(parsed) ? parsed : [parsed];
        console.log(`\nOperations: ${operations.map((o: any) => o.operationName).join(", ")}`);
      } catch {
        console.log(`\nPost data (raw): ${req.postData.slice(0, 200)}...`);
      }
    }
  }

  // Also capture cookies
  const cookies = await context.cookies();
  const toastCookies = cookies.filter(
    (c) => c.domain.includes("toasttab") || c.domain.includes("toast")
  );
  if (toastCookies.length > 0) {
    console.log(`\n--- Cookies ---`);
    for (const c of toastCookies) {
      console.log(`  ${c.name}=${c.value.slice(0, 50)}... (domain: ${c.domain})`);
    }
  }

  // Now try to replay the request directly to see if it works
  if (capturedRequests.length > 0) {
    console.log(`\n${"=".repeat(80)}`);
    console.log("🔁 Attempting to replay GraphQL request directly with fetch...");
    console.log(`${"=".repeat(80)}`);

    const req = capturedRequests[0];
    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.postData,
      });
      console.log(`\nReplay status: ${response.status}`);
      const text = await response.text();
      console.log(`Response preview: ${text.slice(0, 500)}`);
    } catch (err) {
      console.log(`Replay failed: ${err}`);
    }
  }

  await browser.close();
}

interceptGraphQLHeaders().catch(console.error);
