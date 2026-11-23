# Changelog

All notable changes to the **Taobao & Tmall Scraper** (`taobao-tmall-scraper`) Actor are documented in this file.

## [1.2.0] - 2026-11-22

### Fixed

- **Product mode no longer hangs**: Every product now has a hard per-item time limit (150 s). A stuck item gets an uncharged `status: "failed"` row (`"Timed out after …"`) and the run moves on. About 45 s before the run timeout, any items not yet started get an uncharged `"Not processed: the run was about to hit its timeout"` row, and search/shop pagination stops 60 s before the deadline. Items skipped because the circuit breaker tripped also get an uncharged failed row instead of disappearing.
- **`RUN_SUMMARY` and `DEBUG_PROBE` are always written**: They are saved on every `persistState`, `aborting` and `migrating` event (with `partialSummary: true`) and again at the end of the run, so you get them even when a run times out or is aborted.
- **Product detail fetch order rewritten**: known `world.taobao.com` slug (SSR) → shop page slug discovery → overseas SEO PDP API (`mtop.ovs.traffic.landing.seopdp.querySeoPdpPage` on `h5api-intl.m.taobao.com`) → one shared Playwright browser (early, not as a last resort) → `mtop.taobao.detail.data.get` / `pcdetail` / `getdetail` (one quick attempt each, they no longer trip the run-wide circuit breaker) → legacy `world.taobao.com/item/<id>.htm`. When every layer fails, `errorReason` lists each layer and why it failed.
- **Playwright fallback**: Uses one browser per run (instead of a new `PlaywrightCrawler` per item, which ran out of memory), serializes pages, blocks images/fonts/media, stops the Taobao "open in app" redirect, uses the server-rendered HTML, and switches itself off after 3 failed items in a row.
- **No more fake SKUs**: The `默认规格` ("default spec") placeholder SKU and SKUs built from review labels are gone. `skus` is empty unless real SKU data was returned. Review labels only fill `attributes`.
- **Placeholder prices**: Prices of 9999 / 99999 (and similar all-nines values) are treated as placeholders. They are replaced with the promo price or the lowest real SKU price when there is one, otherwise set to `null`, and `priceWarning` explains what happened.
- **Currency fields**: `currency` is now always `"CNY"` (the currency of `price`, `originalPrice`, `promoPrice` and `finalPrice`). The target currency is in the new `convertedCurrency` field, with `priceConverted` (effective price) and `finalPriceConverted`.
- **Translation**: The free Google endpoint `translate.googleapis.com` returns HTTP 429 to datacenter IPs. Free translation now tries `clients5.google.com` and `translate.googleapis.com`, first directly and then through a US residential proxy session. `RUN_SUMMARY.translation` shows the provider, counts by status and the last failure reason.
- **Honest blocked-run note**: `blockedRunNote` / `BLOCKED_RUN_NOTE` is written only when zero products were returned. When some items fail but others succeed, `RUN_SUMMARY.blockWarnings` says so and states that the returned products were charged normally (the old text wrongly said no events were charged).
- **Proxy country in `RUN_SUMMARY`**: `proxyCountry` is now the country actually used most. `proxyCountryRequested` and `proxyCountriesUsed` (request counts per country) were added.

### Added

- Output fields: `minPrice`, `maxPrice` (CNY, from SKUs or a price range), `priceWarning`, `convertedCurrency`, `finalPriceConverted`, `detailSource` (which layer produced the data, e.g. `world_ssr`, `seo_pdp_api`, `mtop_detail`, `playwright`).
- `RUN_SUMMARY` fields: `proxyCountryRequested`, `proxyCountriesUsed`, `partialSummary`, `stoppedEarlyReason`, `translation`, `blockWarnings`.
- 8 new tests (`test/v12.test.ts`).

### Unchanged

- Pay-per-event names and prices are unchanged.

## [1.1.0] - 2026-11-21

### Added

- **`DEBUG_PROBE` Key-Value Store Diagnostic Record**: Every run now writes a `DEBUG_PROBE` record to the default Key-Value Store capturing per-request URL type (`search`, `product`, `shop`, `mtop`, `short_link`, `warmup`), HTTP status code, proxy group/country, cookie names present (never cookie values or tokens), response byte size, and the sanitized first 500 characters of the response body.
- **Per-Session Warm-Up & Crawlee `SessionPool` Rotation (`enableSessionWarmup`)**: Visits Taobao pages with realistic browser headers and `log.mmstat.com/eg.js` + `mtop.common.gettimestamp` to collect `_m_h5_tk`, `_m_h5_tk_enc`, `cna`, and `t` cookies per sticky proxy session, signs MTOP requests (`md5(token&t&appKey&data)`), filters out `x5secdata` block cookies, and retires/rotates the session immediately on `RGV587_ERROR` or `<!--rgv587_flag:sm-->`.
- **Overseas `world.taobao.com` SSR Extraction (`window.__ICE_APP_CONTEXT__`)**: Added SSR extraction for keyword searches (`/product/<keyword>.htm`), categories (`/category/<id>.htm`), shop catalogues (`/dianpu/<shopId>.htm`), and product details (`/lang/en-us/item/<slug>.htm` + `/item/<slug>.htm` reviews/SKUs) to bypass unauthenticated MTOP rate limits.
- **Playwright Browser Fallback (`enablePlaywrightFallback`)**: Added a `PlaywrightCrawler` fallback (Chromium with Crawlee browser fingerprinting and MTOP response interception) when HTTP/MTOP endpoints are blocked.
- **Residential Proxy Country Selection (`proxyCountry`)**: Added `proxyCountry` input (default `"CN"`, with automatic fallback across `"HK"`, `"TW"`, `"SG"`, and `"US"` on sticky sessions).
- **Secret Logged-In Cookie Input (`taobaoCookies`)**: Added `taobaoCookies` (`isSecret: true`, supporting both `key=value; ...` strings and Cookie-Editor JSON arrays) as a last-resort option for login-gated pages.
- **Actionable Blocked-Run Diagnostics (`BLOCKED_RUN_NOTE`)**: When all tasks are blocked, the Actor sets a clear status message, writes `BLOCKED_RUN_NOTE` and `RUN_SUMMARY.troubleshootingAdvice` to the Key-Value Store, includes troubleshooting guidance in dataset `errorReason` fields, and charges zero product events.

## [1.0.0] - 2026-11-19

### Added

- **Unified Mixed-Input Auto-Router**: Supports Taobao (`taobao.com`), Tmall (`tmall.com`), Tmall Global (`tmall.hk`), overseas (`world.taobao.com`, `m.intl.taobao.com`), mobile share short links (`tb.cn`, `m.tb.cn`, `e.tb.cn`), numeric `itemIds`, search `keywords`, category URLs, and shop URLs in a single run.
- **Mobile H5 MTOP Client**: Automatic `_m_h5_tk` cookie handshake and MD5 request signing with isolated token jars per domain (`h5api.m.taobao.com` and `h5api.m.tmall.com`), exponential backoff, proxy session rotation, and a 2-stage shared circuit breaker.
- **Real Final Price Engine**: Computes `finalPrice`, `finalPriceDiscounts`, `unappliedDiscounts`, and `priceType` across products and individual SKUs for coupons, shop discounts, and `满X减Y` threshold deals.
- **English Translation Pipeline**: Pluggable `TranslatorService` with free Google GTX (per-batch error isolation, `Retry-After` / 2–5s exponential backoff on HTTP 429, and 3-consecutive-429 run circuit breaker), DeepL API (50 texts/request cap), and Google Cloud Translation v2 (128 texts/request cap), backed by a bounded 16-shard Key-Value Store cache (`taobao-tmall-translations`).
- **Live CNY Currency Conversion**: Converts CNY prices into 12 major currencies with 24-hour Key-Value Store caching (`taobao-tmall-currency-rates`) and an offline static fallback (`2025-01-15`).
- **Shopping Agent Links**: Automatic purchase links for Superbuy, CSSBuy, Sugargoo, CNFans, and Hoobuy.
- **Delta Monitoring Mode**: 64-shard lazy Key-Value Store state tracking (`taobao-tmall-monitoring-state`) emitting only `new` or `changed` records with `previousValues`.
- **Pay-Per-Event (PPE) Billing**: Granular charging for `actor-start`, `listing`, `product-detail`, and `final-price`, charging `actor-start` only after proxy setup succeeds and never charging for failed or unchanged rows.

### Fixed

- **GTX HTTP 429 backoff**: `TranslatorService` now forwards only a caller-supplied `baseBackoffMs` to the GTX provider, so the default 429 wait is 2–5 seconds with exponential backoff (tests can still inject a short custom backoff). `Retry-After` is still honoured.
- **Conditional free-shipping parsing**: Phrases like `2件包邮` no longer set `shippingFee` to the piece count. Only amounts labelled `快递` / `运费` / `邮费` (or `¥` / `￥`) are parsed; the condition is kept in `shippingNote`.
- **Default input prefill**: Removed the unverified Tmall item URL from `startUrls` prefill. The default Console run is now keyword-only (`蓝牙耳机`).
