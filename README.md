# Toast GraphQL Scraper

## Overview

A next-generation Toast restaurant menu scraper that replaces HTML parsing with **GraphQL API interception**. Instead of navigating the DOM and clicking modals, it captures structured JSON directly from Toast's internal GraphQL API — faster, more reliable, and significantly lighter.

## How It Works

### Two-Phase Architecture

```
Phase 1 (Browser Intercept)              Phase 2 (Direct HTTP)
┌─────────────────────────┐              ┌─────────────────────────┐
│  Playwright loads page  │              │  For each item with     │
│         ↓               │              │  hasModifiers: true     │
│  Intercept GraphQL      │    cookies   │         ↓               │
│  responses from network │──────────────→  Direct fetch() call    │
│         ↓               │   headers    │  to GraphQL endpoint    │
│  Capture:               │              │         ↓               │
│  • Restaurant info      │              │  Get modifier groups,   │
│  • Full menu + items    │              │  options, pricing,      │
│  • Cookies & headers    │              │  allergens              │
└─────────────────────────┘              └─────────────────────────┘
                    ↓                                  ↓
              ┌──────────────────────────────────────────┐
              │  Merge modifiers into menu items         │
              │  Save complete JSON output               │
              └──────────────────────────────────────────┘
```

**Phase 1 — Browser Intercept (one-time per restaurant)**

1. Playwright opens the Toast ordering page (headless)
2. Listens for all requests/responses to `ws-api.toasttab.com/do-federated-gateway/v1/graphql`
3. Captures the `Restaurant` and `PaginatedMenuItems` GraphQL responses as structured JSON
4. Extracts cookies and Toast-specific headers (`toast-session-id`, `apollographql-client-*`) for Phase 2
5. Browser closes — total time: ~5-10 seconds

**Phase 2 — Direct HTTP for Modifiers (no browser needed)**

1. Scans captured menu for items where `hasModifiers: true`
2. For each item, calls `MenuItemDetails` + `doMenuItem` GraphQL queries using `fetch()` with captured cookies
3. Runs in parallel batches (3 concurrent requests, 200ms delay between batches)
4. Merges modifier data back into the menu items
5. Total time: depends on item count, typically 2-10 seconds

### Data Captured

| Entity | Source | Fields |
|--------|--------|--------|
| **Restaurant** | Phase 1 | name, guid, description, cuisine, location, schedule, timezone |
| **Menus** | Phase 1 | name, guid, groups[] |
| **Menu Groups** | Phase 1 | name, guid, items[] |
| **Menu Items** | Phase 1 | name, guid, description, prices, images, outOfStock, hasModifiers |
| **Modifier Groups** | Phase 2 | name, guid, minSelections, maxSelections, pricingMode |
| **Modifier Options** | Phase 2 | name, itemGuid, price, isDefault, outOfStock, allowsDuplicates |
| **Nested Modifiers** | Phase 2 | Recursive modifier groups within modifiers (up to 10 levels) |
| **Allergens** | Phase 2 | allergen list per item |
| **Availability** | Phase 2 | isAvailableNow per item |

### GraphQL Operations Used

| Operation | Hash | Purpose |
|-----------|------|---------|
| `RestaurantByShortUrl` | `15b38587...` | Resolve slug to restaurant GUID (captured from browser) |
| `Restaurant` | `525542de...` | Full restaurant details |
| `PaginatedMenuItemsWithPopularItems` | `6388cffb...` | All menus, groups, items |
| `MenuItemDetails` | `9a27f2b0...` | Item modifiers (groups, options, nested) |
| `doMenuItem` | `a231c736...` | Allergens, availability, pricing rules |

These are **persisted queries** — the server recognizes them by SHA256 hash, so no raw GraphQL query strings are sent.

### Step-by-Step Data Flow

#### Step 1: Browser loads the page and intercepts API responses

When Playwright navigates to a Toast ordering page (e.g. `toasttab.com/local/order/chiguacle-placita`), Toast's frontend automatically makes GraphQL calls to fetch the restaurant and menu data. We listen on the network layer and capture these responses as raw JSON — no HTML parsing needed.

From this single page load we get:

- **Restaurant** — name, GUID, address, cuisine, schedule, timezone
- **Menu** — all menus with their groups (categories) and items
- **Each item** has a `hasModifiers: boolean` flag, but **modifier details are NOT included** in this response

We also capture the browser's **cookies** and **Toast-specific headers** (`toast-session-id`, `apollographql-client-name`, etc.) which are needed to authenticate direct API calls in Phase 2.

#### Step 2: Identify items that have modifiers

After Phase 1, we loop through every menu → group → item and collect all items where `hasModifiers === true`:

```
Menu "Lunch"
  └── Group "Burritos"
        ├── Carnitas Burrito    (hasModifiers: true)  ← collect
        ├── Veggie Burrito      (hasModifiers: true)  ← collect
        └── Side of Rice        (hasModifiers: false) ← skip
```

This gives us a list of `{ itemGuid, itemGroupGuid, name }` refs to fetch.

#### Step 3: Fetch modifier details via direct HTTP (no browser)

For each item with modifiers, we make a direct `fetch()` call to the Toast GraphQL endpoint using the cookies and headers captured in Phase 1. Each call sends two operations in a single request:

- **`MenuItemDetails`** — returns the full modifier tree:
  ```
  modifierGroups[]
    ├── name, guid, minSelections, maxSelections, pricingMode
    └── modifiers[]
          ├── name, itemGuid, price, isDefault, outOfStock
          └── modifierGroups[] (nested — recursive up to 10 levels)
  ```
- **`doMenuItem`** — returns supplementary data:
  - `allergens[]` — allergen info per item
  - `isAvailableNow` — real-time availability
  - `modifierGroupReferences[]` — pricing strategy per modifier group

These run in **parallel batches of 3** with a 200ms delay between batches to avoid rate limiting. For a restaurant with 25 modifier items, this takes ~2-3 seconds total.

#### Step 4: Merge modifiers into menu items

After all modifier fetches complete, we merge the results back into the original menu structure. Each item that had `hasModifiers: true` gets enriched with:

- `item.modifierGroups` — the full modifier group/option tree from `MenuItemDetails`
- `item.modifierGroupReferences` — pricing rules from `doMenuItem`
- `item.allergens` — allergen data
- `item.isAvailableNow` — availability flag

The final output is a single JSON object where every menu item has its modifiers embedded inline — ready for database insertion or further processing.

#### Visual Summary

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Browser loads page                                 │
│                                                             │
│   Toast Frontend ──GraphQL──→ ws-api.toasttab.com           │
│         ↓                           ↓                       │
│   We intercept:              We intercept:                  │
│   • Request headers          • Restaurant JSON              │
│   • Cookies                  • Menu JSON (items without     │
│                                modifier details)            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Extract items with hasModifiers: true                       │
│                                                             │
│   Item A (guid: abc, groupGuid: xyz) ← has modifiers        │
│   Item B (guid: def, groupGuid: xyz) ← has modifiers        │
│   Item C (guid: ghi, groupGuid: xyz) ← no modifiers, skip   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Direct HTTP (parallel batches of 3)                │
│                                                             │
│   fetch(MenuItemDetails + doMenuItem) for Item A ─→ ✅      │
│   fetch(MenuItemDetails + doMenuItem) for Item B ─ ✅       │
│   ... (200ms delay between batches)                         │
│                                                             │
│   Returns per item:                                         │
│   • modifierGroups[] with full options + nested groups      │
│   • allergens[], isAvailableNow, pricing rules              │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ Merge: Attach modifiers to their parent items               │
│                                                             │
│   Item A                                                    │
│     ├── name: "Carnitas Burrito"                            │
│     ├── prices: [14.95]                                     │
│     └── modifierGroups:          ← merged from Phase 2      │
│           ├── "Choice of Beans" (min:1, max:1)              │
│           │     ├── Pinto Beans ($0)                        │
│           │     └── Black Beans ($0)                        │
│           └── "Extra Ingredients" (min:0, max:3)            │
│                 ├── Extra Chicken ($3)                      │
│                 └── Extra Guacamole ($2)                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
                  Save to JSON / DB
```

---

## Comparison with Existing Scraper

### Existing Approach: Playwright + HTML Parsing (Cheerio)

```
Navigate page → Wait for Cloudflare (15-60s) → Parse HTML with Cheerio
→ For EACH menu item: click → wait for modal → parse modal HTML → close modal
→ Transform raw data → Save to DB
```

### New Approach: GraphQL Interception

```
Navigate page → Intercept GraphQL JSON responses (~5s)
→ Direct HTTP fetch for modifiers (parallel, ~2-10s)
→ Save structured data
```

### Side-by-Side Comparison

| Aspect | Existing (HTML Parsing) | New (GraphQL Interception) |
|--------|------------------------|---------------------------|
| **Data extraction** | Parse HTML with 50+ CSS selectors, cascading fallbacks | Structured JSON from API, consistent schema |
| **Modifier extraction** | Click each item modal sequentially (1s per item) | Direct HTTP call per item (parallel, ~100ms each) |
| **Cloudflare handling** | 15-60s wait, stealth plugin, detection heuristics | Browser handles it once during page load (~5s) |
| **Fragility** | Breaks when Toast changes any CSS class or DOM structure | Only breaks if Toast changes their GraphQL schema (rare) |
| **Time per restaurant** | 30-90 seconds | 10-20 seconds |
| **Browser usage** | Entire session (page load + all modal clicks) | Only Phase 1 (~5s), then pure HTTP |
| **Data quality** | Must sanitize prices from text, guess modifier structure | Clean typed data: exact prices, min/max selections, pricing modes |
| **Out-of-stock detection** | Modal fails to open = assumed out of stock | Explicit `outOfStock` boolean field from API |
| **Nested modifiers** | Detected but skipped | Fully captured up to 10 levels deep |
| **Parallelization** | Limited by single browser instance | Phase 2 is fully parallelizable |

### Performance Comparison

| Metric | Existing | New | Improvement |
|--------|----------|-----|-------------|
| Time per restaurant (50 items, 25 with modifiers) | ~60s | ~15s | **4x faster** |
| Browser active time | ~60s | ~5s | **12x less** |
| Network requests (browser) | 100+ (page + assets + modals) | 1 page load | **100x fewer** |
| CSS selectors to maintain | 50+ | 0 | **Zero maintenance** |

### Deployment (Lambda)

| Metric | Existing | New |
|--------|----------|-----|
| Docker image size | 400-600MB (Chromium + system deps + stealth) | 300-400MB (Playwright only) |
| Memory requirement | 512MB-1GB | 256-512MB |
| Cold start | 5-10s (browser + stealth init) | 3-5s |
| Key dependencies | playwright-extra, stealth plugin, cheerio, axios | playwright |

### Reliability

| Failure Mode | Existing | New |
|--------------|----------|-----|
| Toast UI redesign | **Breaks completely** — all CSS selectors need updating | **No impact** — API schema unchanged |
| Cloudflare upgrade | **May break** — stealth detection heuristics may fail | **Minimal impact** — standard page load |
| New modifier types | **May miss data** — relies on known modal HTML structure | **Automatically captured** — API returns full data |
| Rate limiting | Hard to control (browser-driven) | Easy to control (configurable delay/concurrency) |

---

## Usage

```bash
# Install dependencies
bun install

# Single restaurant (by slug)
bun index.ts chiguacle-placita

# Multiple restaurants
bun index.ts chiguacle-placita bennys-tacos-2024-culver-city-10401-venice-blvd-suite-101b

# Full URL
bun index.ts https://www.toasttab.com/local/order/suehiro-chinatown-642-n-broadway-5
```

### Output

Saves a JSON file per restaurant: `output-<slug>.json`

```json
{
  "restaurant": {
    "name": "Chiguacle Cevicheria y Cantina LA Olvera",
    "guid": "4434b615-6b89-4797-9f9b-94eb4071acea",
    "location": { "address1": "...", "city": "Los Angeles" },
    "schedule": { "..." }
  },
  "menu": {
    "menus": [
      {
        "name": "Menu",
        "groups": [
          {
            "name": "Appetizers",
            "items": [
              {
                "name": "Guacamole",
                "prices": [12.95],
                "hasModifiers": true,
                "modifierGroups": [
                  {
                    "name": "Choice of Salsa",
                    "minSelections": 1,
                    "maxSelections": 2,
                    "pricingMode": "INCLUDED",
                    "modifiers": [
                      { "name": "Mild", "price": 0 },
                      { "name": "Spicy", "price": 0 }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}
```

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Toast changes persisted query hashes | Low — hashes are stable across app versions | Monitor for 400 errors; re-capture hashes via browser intercept |
| Cloudflare blocks headless browser | Low — no stealth tricks needed, standard Playwright | Same fallback as existing scraper |
| Rate limiting on GraphQL endpoint | Medium — many modifier calls per restaurant | Configurable concurrency + delay; batch requests |
| Cookie expiration during Phase 2 | Low — cookies valid for 30+ minutes, Phase 2 takes seconds | Re-run Phase 1 if cookies expire |

---

## Next Steps

1. **Database integration** — Wire up Drizzle ORM to persist restaurant, menu, items, and modifiers
2. **Lambda handler** — SQS-triggered handler with Phase 1 + Phase 2 flow
3. **Stock availability mode** — Use `MenuItemDetails` to check `outOfStock` + `isAvailableNow`
4. **Menu comparison** — Diff current vs previous menu version before saving
