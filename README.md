# Taobao & Tmall Scraper — Products, SKUs, Final Prices, English (淘宝 天猫)

All-in-one **Taobao scraper** and **Tmall scraper** (`淘宝` / `天猫`) with a resilient multi-layer workflow that delivers **Taobao product data in English** and Chinese.
Extract product details, SKU variants, real final prices after coupons and `满减` threshold deals, shop catalogues, search listings, live CNY currency conversions, and shopping agent links in one run.
Built for reliability with automatic link routing, overseas `world.taobao.com` SSR extraction, Crawlee `SessionPool` warm-up + signed Mobile H5 MTOP handshakes, Playwright browser fallback, and delta price/stock monitoring.

**From $1.50 per 1,000 listings and $3.50 per 1,000 full product details** (cheaper on paid Apify plans: down to $1.10 / $2.50). Runs on **1 GB of memory** by default, so the start fee is just $0.001 per run.

![Taobao & Tmall Scraper output: English titles, CNY and USD prices, shop names and status per product](https://raw.githubusercontent.com/meenaarpit907-eng/taobao-tmall-scraper/fix/memory-timeouts-pricing/docs/images/output-example.png)

---

## Key Features

- **Unified Mixed-Input Auto-Router**: Pass product URLs (`item.taobao.com`, `detail.tmall.com`, `detail.tmall.hk`, `m.intl.taobao.com`, `world.taobao.com`), mobile share short links (`tb.cn`, `m.tb.cn`, `e.tb.cn`), numeric `itemIds`, search `keywords`, category URLs, and shop URLs in a single run. Invalid entries emit an uncharged `status: "failed"` diagnostic row without crashing the run.
- **Multi-Layer Anti-Bot & `RGV587` Bypass Pipeline**:
  1. **Overseas `world.taobao.com` SSR Extraction**: Reads server-rendered `window.__ICE_APP_CONTEXT__` JSON from `world.taobao.com/product/<keyword>.htm`, `/dianpu/<shopId>.htm`, and `/lang/en-us/item/<slug>.htm`.
  2. **Session Warm-Up & Crawlee `SessionPool` (`enableSessionWarmup`)**: Visits Taobao pages with browser headers to collect `_m_h5_tk`, `_m_h5_tk_enc`, `cna`, and `t` cookies per sticky proxy session, signs MTOP requests (`md5(token + "&" + t + "&" + "12574478" + "&" + data)`), and automatically retires/rotates sessions on `RGV587_ERROR` or `<!--rgv587_flag:sm-->`.
  3. **Playwright Browser Fallback (`enablePlaywrightFallback`)**: Opens one shared headless Chromium per run (mobile profile, TW residential proxy) to load the product page and read its own detail API responses or server-rendered HTML when HTTP endpoints are blocked. It switches itself off after 3 failed items in a row.
  4. **Proxy Country Auto-Fallback (`proxyCountry`) & Secret Cookies (`taobaoCookies`)**: Supports residential proxy selection (`CN`, `HK`, `TW`, `SG`, `US`, `JP`) with automatic sticky-session rotation and an optional secret `taobaoCookies` input.
- **Sanitized `DEBUG_PROBE` Telemetry**: Writes a `DEBUG_PROBE` record to the default Key-Value Store on every run with per-request URL type, HTTP status code, proxy group/country, cookie names present (never cookie values or tokens), response size, and sanitized 500-char body preview.
- **Real Final Price Engine (`finalPrice`, `finalPriceDiscounts`, `unappliedDiscounts`)**: Evaluates each product and every SKU against coupons (`领券立减`), shop discounts (`限时X折`), and threshold deals (`满X减Y`). Deduplicates identical deals by `(threshold, amount)`, applies the single best deal unless stacking is confirmed, and treats `"直降"` as already reflected in `promoPrice`. Plain crossed-out prices (`originalPrice > price`) are never counted as discounts.
- **Taobao Product Data in English + Chinese**: Translates product titles (`titleEn`), SKU variant properties (`propsEn`), and product attributes (`attributesEn`) to English while keeping Chinese originals. Complete translations are cached in a sharded Key-Value Store (`taobao-tmall-translations`). Supports free Google GTX out of the box plus paid **DeepL** (capped at 50 texts/request) and **Google Cloud Translation** (capped at 128 texts/request).
- **Daily CNY Currency Conversion**: Converts CNY prices into `USD`, `EUR`, `GBP`, `INR`, `CAD`, `AUD`, `JPY`, `KRW`, `SGD`, `MYR`, or `HKD` using live daily rates cached for 24h in `taobao-tmall-currency-rates`, with an offline static fallback (`2025-01-15`).
- **Cross-Border Shopping Agent Links**: Generates direct purchase links for **Superbuy**, **CSSBuy**, **Sugargoo**, **CNFans**, and **Hoobuy** on every product.
- **Delta Monitoring Mode (`monitoringMode`)**: Lazily loads 64-bucket hash shards from `taobao-tmall-monitoring-state` and emits only `new` or `changed` items along with `previousValues`.

---

## Who It's For

- **Dropshippers**: Import Taobao and Tmall products with English titles, English SKU variants (`Color`, `Size`) when Taobao returns them, image galleries, and converted USD/EUR prices directly into Shopify, WooCommerce, or custom storefronts.
- **Sourcing Agents & Procurement Teams**: Compare suppliers across Tmall Flagship and Taobao stores using DSR seller scores (`description`, `service`, `logistics`), shop age, sales volume, and domestic shipping fees (`shippingFee` and conditional `shippingNote`).
- **Cross-Border Haul Buyers**: Resolve mobile share links (`m.tb.cn` / `e.tb.cn`), inspect real post-coupon `finalPrice` per SKU, and jump straight to **Superbuy**, **CSSBuy**, **Sugargoo**, **CNFans**, or **Hoobuy**.
- **Price & Stock Monitors**: Schedule daily or hourly delta runs with `monitoringMode: true` to receive alerts only when a competitor's price, coupon, or SKU inventory changes.
- **Brand Protection & Market Analysts**: Track unauthorized listings, pricing compliance, and sales bands across keywords and storefronts on Taobao and Tmall (`tmall.com` / `tmall.hk`).

---

## Use Cases

- **Dropshipping (Taobao → Shopify / WooCommerce)**: Search a keyword such as `"机械键盘"` (mechanical keyboard) with `includeDetails: true`, export the dataset as CSV, and map `titleEn`, `images`, `skus[].propsEn` and `finalPriceConverted` to your store's import template. Add your margin in a spreadsheet column before importing.
- **Price monitoring**: Save a task with your competitors' item URLs or shop URLs, turn on `monitoringMode: true`, and schedule it daily. You only receive (and only pay for) products that are `new` or whose price, coupon or stock `changed`, with the old values in `previousValues`.
- **Reseller & sourcing research**: Compare the same product across Tmall flagship stores and Taobao sellers using `finalPrice` after coupons and 满减 deals, DSR seller scores, shop age and `shipFrom`, then open the item directly on Superbuy, CSSBuy, Sugargoo, CNFans or Hoobuy via `agentLinks`.
- **Market research & AI agents**: Pull English-translated listings for a category to size price bands and brands, or call the Actor from an AI agent (MCP / API) to answer "what does this cost on Taobao?" questions.

---

## Memory, Speed & Cost

- **Default memory: 1 GB.** Keyword search, shop catalogues and most product details (via `world.taobao.com`) use about 150–250 MB, so 1 GB is plenty. Apify charges the `apify-actor-start` fee per GB, so 1 GB keeps it at **$0.001 per run** (it was 4 GB before).
- **When to use 2 GB**: only if you rely on the Playwright browser fallback for many numeric `itemIds` that `world.taobao.com` cannot serve. Chromium needs the extra headroom.
- **Run timeouts are respected**: the Actor stops starting new work ~45 s before your run timeout, shortens or skips its anti-bot cooldown pause when time is short, and writes an uncharged `status: "failed"` row for anything not processed. You never pay for empty or failed rows.
- **Typical speed**: a 3-item listing run finishes in ~10 s; 2 full product details in ~15 s (tested on 1 GB, 2026-11-25).

---

## How to Use It (Step by Step)

1. **Open the Actor in Apify Console**: Click **Try for free** — the input comes prefilled with the keyword `"机械键盘"`, `maxItemsPerQuery: 10`, `includeDetails: false`, and Apify Proxy (`RESIDENTIAL`). An empty run uses the same defaults.
2. **Choose Your Inputs**: Paste any combination of `startUrls` (products, short links, shops, searches, categories), numeric `itemIds`, or Chinese/English `keywords`.
3. **Configure Filters & Output Options**: Set optional search filters (`minPrice`, `maxPrice`, `tmallOnly`, `location`, `sort`), target `currency` (default `USD`), and English translation (`translateToEnglish: true`).
4. **Verify Proxy & Anti-Bot Settings**: Keep **Apify Proxy** enabled with `RESIDENTIAL`, choose your preferred `proxyCountry` (default `CN` with automatic fallback to `HK`, `TW`, `SG`, `US`), and leave `enableSessionWarmup` and `enablePlaywrightFallback` enabled. If you are scraping login-restricted items, paste your browser cookies into `taobaoCookies`.
5. **Click Start & Export**: View structured tables in the dataset tabs (**Products Overview**, **SKUs & Real Final Prices**, **Shops & Seller Ratings**, **Shopping Agent Links**, **Monitoring**) and inspect `RUN_SUMMARY` and `DEBUG_PROBE` in the Key-Value Store.

---

## Input Examples by Mode

### 1. Product Detail & Numeric Item ID Mode

```json
{
    "startUrls": [
        { "url": "https://detail.tmall.com/item.htm?id=1079352038299" },
        { "url": "https://detail.tmall.com/item.htm?id=1019865884154" },
        { "url": "https://item.taobao.com/item.htm?id=1069464409891" }
    ],
    "includeDetails": true,
    "includeShopInfo": true,
    "translateToEnglish": true,
    "currency": "USD",
    "proxyCountry": "CN",
    "enableSessionWarmup": true,
    "enablePlaywrightFallback": true,
    "agentLinks": ["superbuy", "cssbuy", "sugargoo", "cnfans", "hoobuy"]
}
```

### 2. Mobile Share Short-Link Mode (`tb.cn` / `m.tb.cn` / `e.tb.cn`)

```json
{
    "startUrls": [
        { "url": "https://m.tb.cn/h.5xyzABCDEFG" },
        { "url": "【淘宝】https://e.tb.cn/h.6abcDEF123 CZ0001 「新款无线降噪蓝牙耳机」" }
    ],
    "includeDetails": true,
    "translateToEnglish": true,
    "currency": "USD"
}
```

### 3. Keyword Search & Category Mode

```json
{
    "keywords": ["机械键盘"],
    "maxItemsPerQuery": 10,
    "includeDetails": false,
    "translateToEnglish": true,
    "currency": "USD",
    "proxyCountry": "CN"
}
```

### 4. Shop Catalogue Mode

```json
{
    "startUrls": [
        { "url": "https://shop503709453.taobao.com" }
    ],
    "maxItemsPerQuery": 20,
    "includeDetails": false,
    "includeShopInfo": true,
    "translateToEnglish": true,
    "currency": "USD"
}
```

### 5. Delta Price & Stock Monitoring Mode (`monitoringMode: true`)

```json
{
    "itemIds": ["1079352038299", "1019865884154"],
    "monitoringMode": true,
    "monitoringKey": "headphones-watchlist",
    "includeDetails": true,
    "currency": "USD"
}
```

---

## Input Schema Options Reference

- **`startUrls`** (`array`): Product URLs (`item.taobao.com`, `detail.tmall.com`, `world.taobao.com/item/<slug>.htm`), short links (`tb.cn`, `m.tb.cn`, `e.tb.cn`), shop URLs (`shop<id>.taobao.com`, `world.taobao.com/dianpu/<id>.htm`), search URLs, or category URLs.
- **`itemIds`** (`string[]`): Numeric Taobao or Tmall product IDs (5 to 20 digits).
- **`keywords`** (`string[]`, default `["机械键盘"]`): Search keywords in Chinese or English.
- **`maxItemsPerQuery`** (`integer`, default `10`): Maximum items to collect per keyword, category, or shop URL.
- **`minPrice` / `maxPrice` / `tmallOnly` / `location` / `sort`**: Optional search filters.
- **`includeDetails`** (`boolean`, default `false`): Fetch full product details, images, attributes, and SKU data. Leave this off for faster listing-only runs; set it to `true` when you need SKUs and real final prices.
- **`includeShopInfo`** (`boolean`, default `true`): Include shop metadata and seller DSR ratings.
- **`translateToEnglish`** (`boolean`, default `true`): Translate Chinese titles, SKU labels, and attributes to English.
- **`translationProvider`** (`"gtx" | "deepl" | "google"`, default `"gtx"`) & **`translationApiKey`** (`string`, secret).
- **`currency`** (`string`, default `"USD"`): Target currency for `priceConverted` / `finalPriceConverted` (reported in `convertedCurrency`). The output `currency` field is always `CNY`.
- **`agentLinks`** (`string[]`): Shopping agent links to generate (`superbuy`, `cssbuy`, `sugargoo`, `cnfans`, `hoobuy`).
- **`monitoringMode`** (`boolean`, default `false`) & **`monitoringKey`** (`string`): Emit only new/changed items across runs.
- **`proxyConfiguration`** (`object`): Apify Proxy (`RESIDENTIAL`) or custom `proxyUrls`.
- **`proxyCountry`** (`"CN" | "HK" | "TW" | "SG" | "US" | "JP"`, default `"CN"`): Preferred residential proxy country. Automatically falls back across `HK`, `TW`, `SG`, and `US` with sticky sessions if a country pool is unavailable or rate-limited.
- **`enableSessionWarmup`** (`boolean`, default `true`): Warms up each sticky session in Crawlee `SessionPool` to collect `_m_h5_tk`, `_m_h5_tk_enc`, `cna`, and `t` cookies before signing MTOP requests, and retires sessions on `RGV587` blocks.
- **`enablePlaywrightFallback`** (`boolean`, default `true`): Enables a single shared Chromium browser fallback when HTTP/MTOP requests are blocked.
- **`taobaoCookies`** (`string`, `isSecret: true`, optional): Paste your own logged-in Taobao/Tmall browser cookies (`key=value; ...` or Cookie-Editor JSON array) as a last resort when anonymous sessions are challenged. (`cookie` is also kept as a backward-compatible alias.)
- **`maxConcurrency`** (`integer`, default `2`): Low human-like concurrency with random 1–4s request pacing and exponential backoff on blocks.

---

## Output Example & Field Reference

### Real-Shaped JSON Row Example

```json
{
    "recordType": "product",
    "itemId": "681674848244",
    "url": "https://item.taobao.com/item.htm?id=681674848244",
    "platform": "taobao",
    "title": "适用苹果蓝牙耳机保护套无线降噪硅胶软壳",
    "titleEn": "Silicone Protective Case for Wireless Noise Cancelling Bluetooth Earphones",
    "brand": null,
    "categoryPath": "数码配件/耳机保护套",
    "mainImage": "https://img.alicdn.com/imgextra/i1/2208926397372/O1CN01example.jpg",
    "images": [
        "https://img.alicdn.com/imgextra/i1/2208926397372/O1CN01example.jpg"
    ],
    "descriptionImages": [
        "https://img.alicdn.com/imgextra/i3/2208926397372/O1CN01desc.jpg"
    ],
    "videoUrl": null,
    "attributes": {},
    "attributesEn": {},
    "price": 15.8,
    "originalPrice": 15.8,
    "promoPrice": null,
    "finalPrice": 15.8,
    "finalPriceDiscounts": [],
    "unappliedDiscounts": [],
    "priceType": "base_price",
    "currency": "CNY",
    "minPrice": 15.8,
    "maxPrice": 15.8,
    "priceWarning": null,
    "convertedCurrency": "USD",
    "priceConverted": 2.36,
    "finalPriceConverted": 2.36,
    "exchangeRate": 0.1494,
    "exchangeRateDate": "2026-11-21",
    "exchangeRateSource": "live",
    "translationStatus": "ok",
    "salesText": null,
    "salesCount": null,
    "stock": null,
    "skus": [
        {
            "skuId": "variant_1",
            "props": "商品規格:米色",
            "propsEn": "Product Specification: Beige",
            "price": 15.8,
            "originalPrice": 15.8,
            "originalPriceFallback": false,
            "finalPrice": 15.8,
            "stock": null,
            "image": null
        }
    ],
    "shipFrom": "广东深圳",
    "shippingFee": 0,
    "shippingNote": null,
    "shopId": "546420755",
    "shopName": "数码配件严选店",
    "shopType": "taobao",
    "shopUrl": "https://shop546420755.taobao.com",
    "sellerScores": {
        "description": 4.9,
        "service": 4.9,
        "logistics": 4.9
    },
    "creditLevel": "12",
    "shopAgeYears": 4,
    "shopProductCount": 312,
    "agentLinks": {
        "superbuy": "https://www.superbuy.com/en/page/buy/?nTag=Home-search&from=search-input&url=https%3A%2F%2Fitem.taobao.com%2Fitem.htm%3Fid%3D681674848244",
        "cssbuy": "https://www.cssbuy.com/item-681674848244.html",
        "sugargoo": "https://www.sugargoo.com/#/home/productDetail?productLink=https%3A%2F%2Fitem.taobao.com%2Fitem.htm%3Fid%3D681674848244",
        "cnfans": "https://cnfans.com/product/?shop_type=taobao&id=681674848244",
        "hoobuy": "https://hoobuy.com/product/1/681674848244"
    },
    "dataCompleteness": 85,
    "missingFields": ["brand", "salesCount", "stock"],
    "status": "ok",
    "errorReason": null,
    "scrapedAt": "2026-11-21T10:00:00.000Z",
    "changeType": null,
    "previousValues": {}
}
```

### Output Field Table

| Field | Type | Description |
| :--- | :--- | :--- |
| `recordType` | `string` | `'product'` (default) or `'shop'` (summary row in Shop Mode) |
| `itemId` | `string \| null` | Numeric Taobao/Tmall item ID (`null` on failed search rows; shop/error identifier on shop/invalid rows) |
| `query` | `string \| null` | Search keyword or query on failed search rows |
| `url` | `string` | Canonical item or shop URL |
| `platform` | `string` | `'taobao'` or `'tmall'` |
| `title` | `string` | Original Chinese product or shop title |
| `titleEn` | `string \| null` | English translated title (`null` if translation fails or is disabled; never filled with untranslated Chinese) |
| `brand` | `string \| null` | Brand name (`null` on shop summary rows unless explicitly known) |
| `categoryPath` | `string \| null` | Category breadcrumb path |
| `mainImage` | `string \| null` | Primary product image URL (`https://...`) |
| `images` | `string[]` | Gallery image URLs |
| `descriptionImages` | `string[]` | Detail description image URLs |
| `videoUrl` | `string \| null` | Product video URL if available |
| `attributes` | `object` | Key-value product attributes in Chinese |
| `attributesEn` | `object` | Key-value product attributes translated to English |
| `price` | `number \| null` | Active display price in CNY |
| `originalPrice` | `number \| null` | Crossed-out original price in CNY |
| `promoPrice` | `number \| null` | Promotional sub-price in CNY when explicitly present |
| `finalPrice` | `number \| null` | Computed final price in CNY after applying the best real deal (`null` when listing-only or when only unparsed deals exist) |
| `finalPriceDiscounts` | `object[]` | Breakdown of applied/unapplied deals (`{ type, label, labelEn, threshold, amountOff, applied }`) |
| `unappliedDiscounts` | `string[]` | Promotion labels that could not be deterministically parsed or stacked (when `priceType === 'partial'`) |
| `priceType` | `string` | `'exact_final'`, `'partial'`, `'promo_only'`, `'base_price'`, `'range_min'`, or `'unknown'` |
| `currency` | `string` | Always `'CNY'`: the currency of `price`, `originalPrice`, `promoPrice`, `finalPrice`, `minPrice`, `maxPrice` |
| `minPrice` / `maxPrice` | `number \| null` | Lowest / highest price in CNY across real SKUs or a listed price range |
| `priceWarning` | `string \| null` | Set when a placeholder price (e.g. `9999`, `99999`) was detected and replaced or removed |
| `convertedCurrency` | `string` | Target conversion currency code (e.g. `'USD'`) |
| `priceConverted` | `number \| null` | Effective price (final price if known, else price) converted into `convertedCurrency` |
| `finalPriceConverted` | `number \| null` | `finalPrice` converted into `convertedCurrency` |
| `detailSource` | `string \| null` | Which layer produced the detail data (`world_ssr`, `seo_pdp_api`, `mtop_detail`, `playwright`, `playwright_world`, …) |
| `exchangeRate` | `number \| null` | CNY -> target currency exchange rate |
| `exchangeRateDate` | `string \| null` | ISO date (`YYYY-MM-DD`) of the live rate or static fallback table (`2025-01-15`) |
| `exchangeRateSource` | `string` | `'live'` (fetched/cached within 24h) or `'fallback'` (static table when offline) |
| `translationStatus` | `string` | `'ok'`, `'partial'`, `'failed'`, or `'disabled'` |
| `salesText` | `string \| null` | Raw sales band string (e.g. `"1万+"`, `"近30天售出100+"`) |
| `salesCount` | `number \| null` | Parsed lower-bound integer sales count ignoring time-window numbers (e.g. `10000`, `100`) |
| `stock` | `number \| null` | Total stock count (note: Taobao caps signed-out display at ~200 per SKU) |
| `skus` | `object[]` | Array of `{ skuId, props, propsEn, price, originalPrice, originalPriceFallback, finalPrice, stock, image }` |
| `shipFrom` | `string \| null` | Shipping origin province/city |
| `shippingFee` | `number \| null` | Domestic shipping fee in CNY (`0` for unconditional `免运费`/`包邮`; parsed fee when given alongside a condition like `"满88元包邮 快递 8.00"`; `null` when purely conditional like `"满88元包邮"`) |
| `shippingNote` | `string \| null` | Conditional shipping note (e.g. `"满88元包邮"` or `"满88元包邮 快递 8.00"`) |
| `shopId` | `string \| null` | Shop ID (`null` when only `userId`/`sellerId` is returned) |
| `shopName` | `string \| null` | Shop name |
| `shopType` | `string \| null` | `'taobao'` or `'tmall'` |
| `shopUrl` | `string \| null` | Canonical shop storefront URL (built from `shopId` or explicit shop URL, never `userId`) |
| `sellerScores` | `object \| null` | `{ description, service, logistics }` DSR ratings |
| `creditLevel` | `string \| null` | Seller credit level |
| `shopAgeYears` | `number \| null` | Shop age in years (computed as current year minus opening year when a 4-digit year is given) |
| `shopProductCount` | `number \| null` | Total products listed in shop (`null` if unknown) |
| `agentLinks` | `object` | `{ superbuy, cssbuy, sugargoo, cnfans, hoobuy }` direct purchase links |
| `dataCompleteness` | `number` | Completeness score from `0` to `100` |
| `missingFields` | `string[]` | List of fields that were empty/missing on this row |
| `status` | `string` | `'ok'`, `'partial'`, or `'failed'` |
| `errorReason` | `string \| null` | Diagnostic reason when `status` is `'partial'` or `'failed'` |
| `scrapedAt` | `string` | ISO-8601 timestamp |
| `changeType` | `string \| null` | `'new'`, `'changed'`, `'unchanged'`, or `null` |
| `previousValues` | `object` | Previous values of modified fields when `changeType === 'changed'` |
| `shopCatalogueItemIds` | `string[]` | *(Shop summary rows only)* Deduplicated item IDs extracted from the shop pages |

---

## Pay-Per-Event (PPE) Pricing & Example Costs

You only pay for successfully extracted product records (`status: "ok"` or `"partial"`). **Failed rows (`status: "failed"`), unchanged items skipped in monitoring mode, and shop summary rows are never charged.** Prices are tiered by your Apify plan: the higher your plan, the lower the price.

| Event Name | Free plan | Bronze | Silver | Gold+ | When It Is Charged |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `apify-actor-start` | `$0.001` / GB | `$0.001` / GB | `$0.001` / GB | `$0.001` / GB | Once per run, per GB of memory (default 1 GB = `$0.001`) |
| `listing` | `$1.50` / 1,000 | `$1.40` / 1,000 | `$1.20` / 1,000 | `$1.10` / 1,000 | Per product extracted in listing-only mode (`includeDetails: false`) |
| `product-detail` ⭐ | `$3.50` / 1,000 | `$3.20` / 1,000 | `$2.90` / 1,000 | `$2.50` / 1,000 | Per product extracted with details (`includeDetails: true`); SKUs are included when Taobao returns them |
| `final-price` | `$5.00` / 1,000 | `$4.50` / 1,000 | `$4.00` / 1,000 | `$3.60` / 1,000 | Add-on charged **only** when a coupon, shop discount, or `满X减Y` threshold deal was applied and `priceType === "exact_final"` (never charged for a plain listed promo price, crossed-out `originalPrice`, or `"partial"` results) |

### Example Run Costs (Free-plan prices, 1 GB memory)

| Scenario | 100 Products | 1,000 Products | Calculation |
| :--- | :--- | :--- | :--- |
| **Listing-only search** (`includeDetails: false`) | **`$0.151`** | **`$1.501`** | `$0.001` start + `$0.0015` × items |
| **Full product details & SKUs** (`includeDetails: true`, no extra coupons) | **`$0.351`** | **`$3.501`** | `$0.001` start + `$0.0035` × items |
| **Full details + 30% of items have verified coupons/满减 (`exact_final`)** | **`$0.501`** | **`$5.001`** | `$0.001` start + `$0.0035` × items + `$0.005` × 30% items |

On a Gold plan the same 1,000 full details cost about `$2.50`.

### Spending Limit (`ACTOR_MAX_TOTAL_CHARGE_USD`)

The Actor respects Apify's maximum cost per run setting via `ACTOR_MAX_TOTAL_CHARGE_USD` (as well as `APIFY_MAX_TOTAL_CHARGE_USD`, `maxChargeUsd`, and `eventChargeLimitReached`). If your remaining budget can cover `product-detail` (`$0.0035`) but not the optional `final-price` add-on (`$0.005`), the `final-price` add-on is skipped so the product row is still emitted within your budget.

---

## Monitoring & Scheduling Guide

1. **Enable Delta Mode**: Set `"monitoringMode": true` and optionally set a custom `"monitoringKey"` (for example, `"headphones-watchlist"`). If omitted, state is automatically isolated per Apify Task ID (`ACTOR_TASK_ID`).
2. **How State Sharding Works**: Product snapshots (`title`, `price`, `originalPrice`, `promoPrice`, `finalPrice`, `stock`, `salesCount`, and SKU digest) are hashed into 64 buckets (`00`..`63`) in the named Key-Value Store `taobao-tmall-monitoring-state`. Only the buckets needed for your run are lazily loaded.
3. **Zero Charge for Unchanged Items**: Unchanged items (`changeType: "unchanged"`) are skipped before `Actor.charge()` is called, so scheduled runs only bill you for newly discovered (`"new"`) or updated (`"changed"`) products.
4. **Create an Apify Schedule**: Save your configuration as an Apify Task, then go to **Schedules** in Apify Console to run it hourly, daily, or weekly.

---

## Proxy & Anti-Bot Guide (`RESIDENTIAL` + Sticky Sessions)

- **Apify Residential Proxy Integration**: Whenever `input.proxyConfiguration` is provided, the Actor calls `Actor.createProxyConfiguration(input.proxyConfiguration)` or uses your custom `proxyUrls`.
- **Configurable `proxyCountry` with Auto-Fallback**: Set `proxyCountry` to `"CN"` (default), `"HK"`, `"TW"`, `"SG"`, `"US"`, or `"JP"`. If a country pool is unavailable or encounters `RGV587` blocks, the Actor retires the sticky session in Crawlee `SessionPool` and rotates across fallback countries (`CN -> HK -> TW -> SG -> US`).
- **Platform Requirement**: On the Apify platform, if the proxy is disabled or unavailable, the run fails immediately with: `"A proxy is required: enable Apify Proxy (RESIDENTIAL) or provide proxyUrls."`

---

## Translation Guide (Google GTX Free vs. DeepL Recommended)

- **Free Google (`translationProvider: "gtx"`, Default)**: Needs no API key, but Google rate-limits free requests from cloud IPs, so it is best-effort. The Actor tries `clients5.google.com` and `translate.googleapis.com`, directly and then through a US residential proxy session. `RUN_SUMMARY.translation` shows the result counts and the last failure reason. Use DeepL or Google Cloud for reliable translation. Sends URL-encoded batches capped at ~5 KB per request (`fetchGtxRaw`), isolated in per-batch `try/catch` blocks so a failed batch never discards successful batches. On HTTP 429 rate limits, it respects `Retry-After` or waits 2–5 seconds with exponential backoff (max 3 retries). After 3 consecutive 429s in a run, it stops calling GTX for the rest of the run, logs a warning once, and marks remaining strings `translationStatus: "failed"`.
- **DeepL API (`translationProvider: "deepl"`, Recommended for Production)**: Best translation accuracy and throughput for large e-commerce catalogs. Set `translationProvider: "deepl"` and provide your `translationApiKey` (supports both DeepL Free `:fx` keys and Pro keys). Automatically caps batches at 50 texts and ~5 KB per request.
- **Google Cloud Translation v2 (`translationProvider: "google"`)**: Set `translationProvider: "google"` and provide your `translationApiKey`. Automatically caps batches at 128 texts and ~5 KB per request.
- **Provider Selection Rule**: The Actor strictly respects your chosen `translationProvider`. If `deepl` or `google` is selected without an API key, it logs a warning and falls back to free GTX. It never switches from `gtx` to a paid provider just because an API key is present.

---

## Honest Limits

1. **Unauthenticated Deep Pagination & Arbitrary Legacy Item IDs**: Without a logged-in `taobaoCookies` session, Taobao's domestic `s.taobao.com` and `h5api.m.taobao.com` endpoints enforce `RGV587` rate limits after several pages, while `world.taobao.com` SSR returns 20 items per keyword search page and up to 60 items per shop catalogue page. For arbitrary item IDs not indexed in `world.taobao.com` search/shop pages, providing `taobaoCookies` improves coverage.
2. **Stock Display Capped Around 200**: On signed-out requests, Taobao and Tmall cap displayed SKU inventory numbers around `200`. Treat `stock: 200` as `200+`.
3. **Final Price Can Be `"partial"`**: When a product has multi-item bundle promos (e.g. `"买2件7折"`) or multiple concurrent deals without confirmed stacking, `priceType` is set to `"partial"`, only the single best confirmed 1-unit deal is applied to `finalPrice`, remaining/unparsed labels are listed in `unappliedDiscounts[]`, and the `final-price` add-on event is **not** charged.
4. **Product detail by numeric ID is best-effort**: Taobao blocks most anonymous detail requests (`RGV587` / slider). The Actor tries the overseas `world.taobao.com` page, the overseas SEO detail API, a browser, and the mobile detail APIs. Items that still fail get an uncharged `status: "failed"` row whose `errorReason` lists every layer tried. Each item has a 150 s time limit, so one stuck item cannot hang the run.
5. **`world.taobao.com` detail data is limited**: When only the overseas page works, you get the title, main image, price, original price, seller info and review-derived attributes, but usually **no SKU list** (`skus: []`) and few images. Check `detailSource` to see which layer produced the row.
6. **Free translation is best-effort**: see the Translation Guide.
7. **No Captcha / Slider Solving**: This Actor does not solve interactive Alibaba `x5sec` / `Baxia` slider captchas. Blocked requests trigger session retirement, proxy country rotation, Playwright fallback, and a 2-stage shared circuit breaker.

---

## FAQ

### Is scraping public product data from Taobao & Tmall legal?

Yes. This Actor extracts **publicly available product catalog and pricing data** only. It does not extract personal data, and any buyer/reviewer nicknames encountered in page text are automatically masked (`张***3`). This Actor is an independent tool and has **no affiliation with Alibaba Group, Taobao, or Tmall**.

### What happens if a request is blocked by Taobao anti-bot protection (`RGV587`)?

The Actor retires the current sticky session in Crawlee `SessionPool`, rotates to a fresh proxy session (and fallback country), and falls back to `PlaywrightCrawler` when enabled. If all strategies are blocked, the run writes a `DEBUG_PROBE` and `BLOCKED_RUN_NOTE` record to the Key-Value Store explaining what happened and what to try (`proxyCountry` or `taobaoCookies`), and charges zero product events.

### How can I cut costs on large runs?

- Set `"includeDetails": false` when scanning search results or shop catalogues (`$1.50 / 1,000` listings instead of `$3.50 / 1,000` details).
- Enable `"monitoringMode": true` on scheduled runs so unchanged products are skipped before billing.
- Set a maximum run budget in Apify Console (`ACTOR_MAX_TOTAL_CHARGE_USD`).
- Keep the default 1 GB memory: the start fee is charged per GB.

---

## 中文说明 (Chinese Overview)

**淘宝 & 天猫数据采集器 (Taobao & Tmall Scraper)** 专为跨境电商选品、价格监控、代购系统（Superbuy / CSSBuy / Sugargoo / CNFans / Hoobuy）及 AI 智能体设计：

- **多模式自动路由**：支持商品详情链接、手机淘宝短链（`tb.cn` / `m.tb.cn` / `e.tb.cn`）、纯数字商品 ID、关键词搜索、类目链接及店铺搜索列表采集。
- **多层防封体系（SSR + SessionPool 预热签名 + Playwright 兜底）**：结合海外版 `world.taobao.com` SSR 数据提取、Crawlee `SessionPool` 会话预热与 `_m_h5_tk` MD5 签名、遇 `RGV587` 自动淘汰轮换会话、Playwright 浏览器指纹兜底，以及可选 `taobaoCookies` 登录态输入。
- **真实到手价计算 (`finalPrice` & `unappliedDiscounts`)**：自动解析并去重店铺满减（`满X减Y`）、立减折扣与公开优惠券，默认取最优单项优惠，对无法解析的多件折等规则标记为 `priceType: "partial"`。
- **中英双语批量翻译与汇率换算**：支持免费 Google GTX、DeepL（推荐）及 Google Cloud Translation，跨运行分片缓存翻译结果与 24 小时实时汇率。
- **分片增量监控 (`monitoringMode`)**：按 64 个哈希分片懒加载历史状态，仅输出新增（`new`）或发生变动（`changed`）的商品及历史旧值（`previousValues`），未变动或失败记录绝不计费。
