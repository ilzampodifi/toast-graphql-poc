/**
 * Toast GraphQL Scraper
 * Phase 1: Playwright intercepts GraphQL responses (no HTML parsing)
 * Phase 2: Direct HTTP replay with captured cookies to fetch modifier details
 */

import { chromium } from "playwright";

const GRAPHQL_URL = "https://ws-api.toasttab.com/do-federated-gateway/v1/graphql";
const TOAST_BASE = "https://www.toasttab.com";

interface SessionInfo {
  cookieString: string;
  capturedHeaders: Record<string, string>;
}

interface ScrapedData {
  restaurant: any | null;
  menu: any | null;
  popularItems: any | null;
}

interface MenuItemRef {
  guid: string;
  itemGroupGuid: string;
  name: string;
}

// ─── Phase 1: Browser intercept ───

async function interceptGraphQL(targetUrl: string): Promise<{ data: ScrapedData; session: SessionInfo }> {
  const scraped: ScrapedData = { restaurant: null, menu: null, popularItems: null };
  const capturedHeaders: Record<string, string> = {};
  let menuReceived = false;

  console.log(`🚀 Launching browser...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  page.on("request", (request) => {
    if (request.url().includes("/graphql") && request.method() === "POST") {
      const headers = request.headers();
      for (const key of Object.keys(headers)) {
        if (key.startsWith("toast-") || key.startsWith("apollographql-")) {
          capturedHeaders[key] = headers[key];
        }
      }
    }
  });

  page.on("response", async (response) => {
    if (!response.url().includes("/graphql") || response.status() !== 200) return;

    try {
      const json = await response.json();
      const items = Array.isArray(json) ? json : [json];

      for (const item of items) {
        const data = item?.data;
        if (!data) continue;

        const restaurant = data.restaurantV2 ?? data.restaurantV2ByShortUrl;
        if (restaurant) {
          scraped.restaurant = restaurant;
          console.log(`✅ Captured: Restaurant (${restaurant.name})`);
        }

        if (data.paginatedMenuItems) {
          scraped.menu = data.paginatedMenuItems;
          menuReceived = true;
          const menus = data.paginatedMenuItems.menus ?? [];
          let totalItems = 0;
          for (const m of menus) {
            for (const g of m.groups ?? []) {
              totalItems += g.items?.length ?? 0;
            }
          }
          console.log(`✅ Captured: Menu (${menus.length} menus, ${totalItems} items)`);
        }

        if (data.popularItems?.items?.length) {
          scraped.popularItems = data.popularItems;
          console.log(`✅ Captured: Popular Items (${data.popularItems.items.length})`);
        }
      }
    } catch {
      // non-JSON, skip
    }
  });

  console.log(`🌐 Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  const deadline = Date.now() + 30000;
  while (!menuReceived && Date.now() < deadline) {
    await page.waitForTimeout(500);
  }

  const cookies = await context.cookies();
  const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  console.log(`🍪 Extracted ${cookies.length} cookies`);

  await browser.close();
  console.log(`🔒 Browser closed`);

  return {
    data: scraped,
    session: { cookieString, capturedHeaders },
  };
}

// ─── Phase 2: Direct HTTP for modifier details ───

function buildHeaders(session: SessionInfo, operationNames: string, hashes: string) {
  return {
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    Origin: TOAST_BASE,
    Referer: `${TOAST_BASE}/`,
    "Apollographql-Client-Name": "sites-web-client",
    "Apollographql-Client-Version": "3039",
    "Toast-Graphql-Operation": operationNames,
    "Toast-Persistent-Query-Hash": hashes,
    "Toast-Session-Id": session.capturedHeaders["toast-session-id"] ?? "",
    Cookie: session.cookieString,
  };
}

async function fetchMenuItemDetails(
  session: SessionInfo,
  restaurantGuid: string,
  itemGuid: string,
  itemGroupGuid: string
) {
  const body = [
    {
      operationName: "MenuItemDetails",
      variables: {
        input: { itemGuid, itemGroupGuid, restaurantGuid },
        nestingLevel: 10,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: "9a27f2b0008d155f37aee3d2d90d5ff097b96d44",
        },
      },
    },
    {
      operationName: "doMenuItem",
      variables: {
        input: {
          menuGroupGuid: itemGroupGuid,
          menuItemGuid: itemGuid,
          restaurantGuid,
          visibility: "TOAST_ONLINE_ORDERING",
        },
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: "a231c736ffbd219a6a8994139f01556d6f456f3f",
        },
      },
    },
  ];

  const operationNames = body.map((op) => op.operationName).join(",");
  const hashes = body.map((op) => op.extensions.persistedQuery.sha256Hash).join(",");

  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: buildHeaders(session, operationNames, hashes),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const json: any = await response.json();
  const items = Array.isArray(json) ? json : [json];

  let menuItemDetails = null;
  let doMenuItem = null;

  for (const item of items) {
    if (item?.data?.menuItemDetails) {
      menuItemDetails = item.data.menuItemDetails;
    }
    if (item?.data?.doMenus_findMenuItem) {
      doMenuItem = item.data.doMenus_findMenuItem;
    }
  }

  return { menuItemDetails, doMenuItem };
}

/**
 * Extract all items that have modifiers from the menu data
 */
function extractItemsWithModifiers(menu: any): MenuItemRef[] {
  const refs: MenuItemRef[] = [];
  const menus = menu?.menus ?? [];

  for (const m of menus) {
    for (const group of m.groups ?? []) {
      for (const item of group.items ?? []) {
        if (item.hasModifiers) {
          refs.push({
            guid: item.guid,
            itemGroupGuid: item.itemGroupGuid,
            name: item.name,
          });
        }
      }
    }
  }

  return refs;
}

/**
 * Fetch modifiers for all items, with concurrency limit and delay
 */
async function fetchAllModifiers(
  session: SessionInfo,
  restaurantGuid: string,
  itemRefs: MenuItemRef[],
  concurrency: number = 3,
  delayMs: number = 200
): Promise<Map<string, any>> {
  const modifiers = new Map<string, any>();
  let completed = 0;

  // Process in batches
  for (let i = 0; i < itemRefs.length; i += concurrency) {
    const batch = itemRefs.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      batch.map(async (ref) => {
        const result = await fetchMenuItemDetails(session, restaurantGuid, ref.guid, ref.itemGroupGuid);
        return { ref, result };
      })
    );

    for (const r of results) {
      completed++;
      if (r.status === "fulfilled") {
        const { ref, result } = r.value;
        const modGroups = result.menuItemDetails?.modifierGroups ?? [];
        modifiers.set(ref.guid, {
          menuItemDetails: result.menuItemDetails,
          doMenuItem: result.doMenuItem,
        });
        console.log(
          `   [${completed}/${itemRefs.length}] ${ref.name} — ${modGroups.length} modifier group(s)`
        );
      } else {
        console.log(`   [${completed}/${itemRefs.length}] ❌ Failed: ${r.reason}`);
      }
    }

    // Small delay between batches to avoid rate limiting
    if (i + concurrency < itemRefs.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return modifiers;
}

// ─── Main ───

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("Usage: bun index.ts <slug-or-url> [slug-or-url ...]\n");
  console.log("Examples:");
  console.log("  bun index.ts chiguacle-placita");
  console.log("  bun index.ts https://www.toasttab.com/local/order/bennys-tacos-2024-culver-city-10401-venice-blvd-suite-101b");
  console.log("  bun index.ts chiguacle-placita bennys-tacos-2024-culver-city-10401-venice-blvd-suite-101b");
  process.exit(1);
}

function parseInput(input: string): { targetUrl: string; label: string } {
  if (input.startsWith("http")) {
    const slug = input.split("/").pop() ?? input;
    return { targetUrl: input, label: slug };
  }
  return { targetUrl: `${TOAST_BASE}/local/order/${input}`, label: input };
}

for (const input of args) {
  const { targetUrl, label } = parseInput(input);

  console.log(`\n${"=".repeat(70)}`);
  console.log(`🍽️  Scraping: ${label}`);
  console.log(`${"=".repeat(70)}`);

  try {
    // Phase 1: Browser intercept
    const { data, session } = await interceptGraphQL(targetUrl);

    if (data.restaurant) {
      console.log(`\n📋 Restaurant: ${data.restaurant.name}`);
      console.log(`   GUID: ${data.restaurant.guid}`);
      if (data.restaurant.location) {
        const loc = data.restaurant.location;
        console.log(`   Address: ${[loc.address1, loc.city, loc.administrativeArea].filter(Boolean).join(", ")}`);
      }
    }

    if (!data.menu) {
      console.log(`\n⚠️  No menu data captured, skipping`);
      continue;
    }

    const menus = data.menu.menus ?? [];
    console.log(`\n📋 Menu: ${menus.length} menu(s), ${data.menu.totalCount ?? "?"} total items`);
    for (const menu of menus) {
      for (const group of menu.groups ?? []) {
        console.log(`   [${group.name}] ${group.items?.length ?? 0} items`);
      }
    }

    // Phase 2: Fetch modifier details for all items with modifiers
    const itemRefs = extractItemsWithModifiers(data.menu);
    let modifierMap = new Map<string, any>();

    if (itemRefs.length > 0 && data.restaurant?.guid) {
      console.log(`\n🔧 Phase 2: Fetching modifiers for ${itemRefs.length} items...`);
      modifierMap = await fetchAllModifiers(session, data.restaurant.guid, itemRefs);
      console.log(`✅ Fetched modifiers for ${modifierMap.size}/${itemRefs.length} items`);
    } else {
      console.log(`\nℹ️  No items with modifiers found`);
    }

    // Merge modifiers into menu items
    for (const menu of menus) {
      for (const group of menu.groups ?? []) {
        for (const item of group.items ?? []) {
          const mod = modifierMap.get(item.guid);
          if (mod) {
            item.modifierGroups = mod.menuItemDetails?.modifierGroups ?? [];
            item.modifierGroupReferences = mod.doMenuItem?.menuResponse?.modifierGroupReferences ?? [];
            item.allergens = mod.doMenuItem?.menuItem?.allergens ?? [];
            item.isAvailableNow = mod.doMenuItem?.menuItem?.isAvailableNow ?? null;
          }
        }
      }
    }

    // Save output
    const output = {
      restaurant: data.restaurant,
      menu: data.menu,
      popularItems: data.popularItems,
    };
    const slug = label.replace(/[^a-zA-Z0-9-]/g, "_");
    const outputPath = `./output-${slug}.json`;
    await Bun.write(outputPath, JSON.stringify(output, null, 2));
    console.log(`\n💾 Saved to ${outputPath}`);
  } catch (err: any) {
    console.error(`❌ Failed: ${err.message}`);
  }
}
