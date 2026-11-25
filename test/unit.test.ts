import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Actor, log } from 'apify';
import { describe, expect, it, vi } from 'vitest';
import {
    buildAgentLinks,
    buildCnfansLink,
    buildCssbuyLink,
    buildHoobuyLink,
    buildSugargooLink,
    buildSuperbuyLink,
} from '../src/agentLinks.js';
import { BillingManager } from '../src/billing.js';
import { CurrencyService, FALLBACK_RATES_DATE } from '../src/currency.js';
import {
    DebugProbeCollector,
    extractCookieNamesOnly,
    sanitizeBodyPreview,
    sanitizeProbeUrl,
} from '../src/debugProbe.js';
import { computeProductAndSkuFinalPrices, computeSingleFinalPrice } from '../src/finalPrice.js';
import {
    CircuitBreaker,
    computeMtopSign,
    extractH5TokenFromCookie,
    H5_APP_KEY,
    normalizeUserCookieString,
    serializeCompactMtopData,
    TaobaoH5Client,
} from '../src/h5Client.js';
import { buildBlockedRunGuidance, runTaobaoScraper } from '../src/main.js';
import {
    parsePlaywrightProductCapture,
    parsePlaywrightSearchCapture,
    parsePlaywrightShopCapture,
} from '../src/playwrightFallback.js';
import {
    getItemShardBucket,
    getShardIndexKey,
    getShardRecordKey,
    MONITORING_SHARD_COUNT,
    MONITORING_STORE_NAME,
    MonitoringService,
} from '../src/monitoring.js';
import { assembleProductOutput, buildShopSummaryRow } from '../src/pipeline.js';
import {
    buildInitialTasks,
    buildItemCandidateUrls,
    classifyUrl,
    extractItemIdFromUrl,
    extractUrlFromShareText,
    isAllowedTaobaoTmallHost,
    validateAndNormalizeInput,
} from '../src/router.js';
import { LayeredProductDetailSource, parseMtopDetailData } from '../src/sources/productDetailSource.js';
import {
    createTranslationProvider,
    DeepLTranslationProvider,
    FreeGtxTranslationProvider,
    GoogleCloudTranslationProvider,
    splitIntoEncodedBatches,
    TRANSLATION_INDEX_KEY,
    TRANSLATION_STORE_NAME,
    TranslatorService,
} from '../src/translator.js';
import { maskPersonalName, parseSalesCount, sanitizeNoPiiText } from '../src/utils.js';

describe('1. Mobile H5 MTOP Signing & Token Jars', () => {
    it('computes exact MD5 signature md5(token + "&" + t + "&" + "12574478" + "&" + data) with key order preserved', () => {
        const token = 'mock_h5_token_value_for_unit_tst';
        const t = '1731920000123';
        const dataObj = {
            id: '678901234567',
            detail_v: '3.3.2',
            exParams: '{"id":"678901234567"}',
        };
        const compactData = serializeCompactMtopData(dataObj);
        expect(compactData).toBe('{"id":"678901234567","detail_v":"3.3.2","exParams":"{\\"id\\":\\"678901234567\\"}"}');

        const expectedMd5 = createHash('md5')
            .update(`${token}&${t}&${H5_APP_KEY}&${compactData}`, 'utf8')
            .digest('hex');

        const sign = computeMtopSign(token, t, compactData);
        expect(sign).toBe(expectedMd5);
        expect(sign).toHaveLength(32);
    });

    it('extracts token prefix from _m_h5_tk cookie and isolates token jars per domain', () => {
        expect(extractH5TokenFromCookie('sampleH5TokenPrefixValue123_1731925000000')).toBe(
            'sampleH5TokenPrefixValue123',
        );

        const client = new TaobaoH5Client({ requestDelayMs: 0 });
        const taobaoJar = client.getTokenJar('h5api.m.taobao.com', 's1');
        const tmallJar = client.getTokenJar('h5api.m.tmall.com', 's1');

        taobaoJar.token = 'taobao_tok_111';
        tmallJar.token = 'tmall_tok_222';

        expect(client.getTokenJar('h5api.m.taobao.com', 's1').token).toBe('taobao_tok_111');
        expect(client.getTokenJar('h5api.m.tmall.com', 's1').token).toBe('tmall_tok_222');
    });

    it('performs token handshake on first call ("token expired") and succeeds on retry with Set-Cookie token', async () => {
        let callCount = 0;
        const client = new TaobaoH5Client({
            requestDelayMs: 0,
            baseBackoffMs: 10,
            customFetch: async (url) => {
                callCount += 1;
                if (callCount === 1) {
                    return {
                        statusCode: 200,
                        body: JSON.stringify({
                            api: 'mtop.taobao.pcdetail.data.get',
                            ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'],
                        }),
                        headers: {
                            'set-cookie': [
                                '_m_h5_tk=freshH5CookieTokenForTest_1731930000; Path=/; Domain=.taobao.com',
                                '_m_h5_tk_enc=encvalue999; Path=/; Domain=.taobao.com',
                            ],
                        },
                    };
                }
                // Verify second call was signed with the newly set token
                const parsedUrl = new URL(url);
                const t = parsedUrl.searchParams.get('t')!;
                const data = parsedUrl.searchParams.get('data')!;
                const sign = parsedUrl.searchParams.get('sign')!;
                const expectedSign = computeMtopSign('freshH5CookieTokenForTest', t, data);
                expect(sign).toBe(expectedSign);

                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        ret: ['SUCCESS::调用成功'],
                        data: { item: { title: '测试蓝牙耳机' } },
                    }),
                    headers: {},
                };
            },
        });

        const res = await client.requestMtop<{ item: { title: string } }>({
            api: 'mtop.taobao.pcdetail.data.get',
            platform: 'taobao',
            data: { id: '123456789' },
        });

        expect(res.ok).toBe(true);
        expect(res.data?.item.title).toBe('测试蓝牙耳机');
        expect(callCount).toBe(2);
    });

    it('pauses on 5 consecutive blocks and trips circuit breaker if 5 consecutive blocks repeat', async () => {
        const cb = new CircuitBreaker({ threshold: 5, pauseDurationMs: 15 });
        for (let i = 0; i < 5; i++) {
            await cb.recordBlock('RGV587_ERROR');
        }
        // First 5 blocks trigger pause, not permanent trip
        expect(cb.isTripped()).toBe(false);
        expect(cb.getStats().pausedCycles).toBe(1);

        // Next 5 consecutive blocks trip the circuit breaker permanently
        for (let i = 0; i < 5; i++) {
            await cb.recordBlock('x5sec captcha');
        }
        expect(cb.isTripped()).toBe(true);
    });
});

describe('2. Link Parsing, Auto-Routing & Input Validation', () => {
    it('routes all product URL variants (item.taobao.com, detail.tmall.com, m.intl.taobao.com, world.taobao.com)', () => {
        const tb = classifyUrl('https://item.taobao.com/item.htm?id=678901234567&spm=a21');
        expect(tb.type).toBe('product');
        expect(tb.itemId).toBe('678901234567');
        expect(tb.platform).toBe('taobao');

        const tm = classifyUrl('https://detail.tmall.com/item.htm?id=712345678901');
        expect(tm.type).toBe('product');
        expect(tm.itemId).toBe('712345678901');
        expect(tm.platform).toBe('tmall');

        const intl = classifyUrl('https://m.intl.taobao.com/detail/detail.html?id=888999000111');
        expect(intl.type).toBe('product');
        expect(intl.itemId).toBe('888999000111');

        const worldItem = classifyUrl('https://world.taobao.com/item/555666777888.htm');
        expect(worldItem.type).toBe('product');
        expect(worldItem.itemId).toBe('555666777888');
    });

    it('routes short links (tb.cn, m.tb.cn, e.tb.cn) and extracts URLs from mobile share text', () => {
        const rawShare = '【淘宝】https://m.tb.cn/h.5xyzABCDEFG?tk=12345 CZ0001 「新款无线蓝牙耳机」点击链接直接打开';
        const extracted = extractUrlFromShareText(rawShare);
        expect(extracted).toBe('https://m.tb.cn/h.5xyzABCDEFG?tk=12345');

        const task = classifyUrl(extracted);
        expect(task.type).toBe('short_link');

        const tbShort = classifyUrl('https://tb.cn/x.12345');
        expect(tbShort.type).toBe('short_link');
    });

    it('routes shop URLs, search URLs, and category URLs accurately', () => {
        const shop1 = classifyUrl('https://shop108472391.taobao.com/?spm=2013');
        expect(shop1.type).toBe('shop');
        expect(shop1.shopId).toBe('108472391');

        const shop2 = classifyUrl('https://xiaomi.tmall.com/search.htm?search=y');
        expect(shop2.type).toBe('shop');
        expect(shop2.platform).toBe('tmall');

        const search1 = classifyUrl('https://s.taobao.com/search?q=%E6%9C%BA%E6%A2%B0%E9%94%AE%E7%9B%98');
        expect(search1.type).toBe('search');
        expect(search1.keyword).toBe('机械键盘');

        const search2 = classifyUrl('https://world.taobao.com/search/search.htm?q=earbuds');
        expect(search2.type).toBe('search');
        expect(search2.keyword).toBe('earbuds');

        const cat1 = classifyUrl('https://world.taobao.com/cat/50010850.htm');
        expect(cat1.type).toBe('category');
        expect(cat1.categoryId).toBe('50010850');
    });

    it('deduplicates mixed inputs and validates against mainland China (CN) proxy configuration', () => {
        const tasks = buildInitialTasks({
            startUrls: ['https://item.taobao.com/item.htm?id=678901234567'],
            itemIds: ['678901234567', '712345678901'],
            keywords: ['机械键盘'],
        });
        expect(tasks).toHaveLength(3);

        const fallbacks = buildItemCandidateUrls('678901234567', 'taobao');
        expect(fallbacks).toContain('https://world.taobao.com/item/678901234567.htm');
        expect(fallbacks).toContain('https://m.intl.taobao.com/detail/detail.html?id=678901234567');

        expect(() =>
            validateAndNormalizeInput({
                keywords: ['test'],
                proxyConfiguration: { useApifyProxy: true, apifyProxyCountry: 'CN' },
            }),
        ).toThrow(/cannot be "CN"/i);

        expect(extractItemIdFromUrl('https://a.m.taobao.com/i678901234567.htm')).toBe('678901234567');
    });
});

describe('3. Sales-Band Parsing & PII Masking', () => {
    it('parses Chinese and numeric sales bands into lower-bound integers and ignores time-window prefixes', () => {
        expect(parseSalesCount('1万+')).toBe(10000);
        expect(parseSalesCount('2.5万+')).toBe(25000);
        expect(parseSalesCount('2.5万+人付款')).toBe(25000);
        expect(parseSalesCount('10万+')).toBe(100000);
        expect(parseSalesCount('500+')).toBe(500);
        expect(parseSalesCount('月销1000+')).toBe(1000);
        expect(parseSalesCount('近30天售出100+')).toBe(100);
        expect(parseSalesCount('已售 1000+')).toBe(1000);
        expect(parseSalesCount('月销 88')).toBe(88);
        expect(parseSalesCount('0人付款')).toBe(0);
        expect(parseSalesCount(null)).toBeNull();
        expect(parseSalesCount('')).toBeNull();
    });

    it('masks personal reviewer and buyer nicknames', () => {
        expect(maskPersonalName('张三丰')).toBe('张***丰');
        expect(maskPersonalName('李四')).toBe('李***');
        expect(sanitizeNoPiiText('买家：王小明123 评价很好')).toBe('用户:王***3 评价很好');
    });
});

describe('4. Shopping Agent Link Templates', () => {
    const itemId = '678901234567';
    const itemUrl = 'https://item.taobao.com/item.htm?id=678901234567';

    it('builds valid URLs for Superbuy, CSSBuy, Sugargoo, CNFans, and Hoobuy', () => {
        expect(buildSuperbuyLink(itemId, itemUrl)).toBe(
            `https://www.superbuy.com/en/page/buy/?nTag=Home-search&from=search-input&url=${encodeURIComponent(itemUrl)}`,
        );
        expect(buildCssbuyLink(itemId, itemUrl)).toBe('https://www.cssbuy.com/item-678901234567.html');
        expect(buildSugargooLink(itemId, itemUrl)).toBe(
            `https://www.sugargoo.com/#/home/productDetail?productLink=${encodeURIComponent(itemUrl)}`,
        );
        expect(buildCnfansLink(itemId, itemUrl)).toBe('https://cnfans.com/product/?shop_type=taobao&id=678901234567');
        expect(buildHoobuyLink(itemId, itemUrl)).toBe('https://hoobuy.com/product/1/678901234567');

        const subset = buildAgentLinks({
            itemId,
            url: itemUrl,
            selectedAgents: ['superbuy', 'cnfans'],
        });
        expect(Object.keys(subset)).toEqual(['superbuy', 'cnfans']);
    });
});

describe('5. Real Final Price Math (Coupons, Shop Discounts, 满X减Y Thresholds)', () => {
    it('HIGH #2 Regression: plain crossed-out price (originalPrice > price) is NOT treated as a discount and does not label priceType exact_final or trigger final-price charge', () => {
        const res = computeSingleFinalPrice({
            price: 299,
            originalPrice: 399,
            promoPrice: null,
            promotions: [],
            isDetailFetched: true,
        });

        expect(res.finalPrice).toBe(299);
        expect(res.finalPriceDiscounts).toEqual([]);
        expect(res.unappliedDiscounts).toEqual([]);
        expect(res.priceType).toBe('base_price');
    });

    it('HIGH #3 Regression: when deals mix clear and unclear ones (e.g. ["满99减10", "买2件7折"]), sets priceType "partial" and lists unparsed deals in unappliedDiscounts[]', () => {
        const mixed = computeSingleFinalPrice({
            price: 100,
            originalPrice: 120,
            promotions: ['满99减10', '买2件7折'],
            isDetailFetched: true,
        });

        expect(mixed.priceType).toBe('partial');
        expect(mixed.unappliedDiscounts).toEqual(['买2件7折']);
        expect(mixed.finalPrice).toBe(90);
        expect(mixed.finalPriceDiscounts.some((d) => d.applied && d.amountOff === 10)).toBe(true);
        expect(mixed.finalPriceDiscounts.some((d) => !d.applied && d.label === '买2件7折')).toBe(true);
    });

    it('HIGH #4 Regression: deduplicates deals by (type-normalized threshold, amount), does not stack unless confirmed, and does not subtract "直降" again', () => {
        // 1. Duplicate deal ("满99减10" shop deal + "店铺优惠券满99减10" coupon) -> 100 to 90, NOT 80
        const dupeRes = computeSingleFinalPrice({
            price: 100,
            promotions: ['满99减10', '店铺优惠券满99减10'],
            isDetailFetched: true,
        });
        expect(dupeRes.finalPrice).toBe(90);
        expect(dupeRes.finalPriceDiscounts).toHaveLength(1);
        expect(dupeRes.finalPriceDiscounts[0].amountOff).toBe(10);

        // 2. Does not stack shop discount + threshold + coupon unless confirmed; applies single best one
        const unconfirmedStack = computeSingleFinalPrice({
            price: 350,
            originalPrice: 399,
            promoPrice: 320,
            promotions: ['满200减20', '满300减40', '领券减15元'],
            isDetailFetched: true,
        });
        // Single best deal at 320 is 满300减40 (40 off) -> 280; other deals listed in unappliedDiscounts and priceType is 'partial'
        expect(unconfirmedStack.finalPrice).toBe(280);
        expect(unconfirmedStack.priceType).toBe('partial');
        expect(unconfirmedStack.unappliedDiscounts).toEqual(['满200减20', '领券减15元']);
        expect(unconfirmedStack.finalPriceDiscounts.filter((d) => d.applied)).toHaveLength(1);
        expect(unconfirmedStack.finalPriceDiscounts.find((d) => d.applied)?.amountOff).toBe(40);

        // 3. When data confirms they combine (canCombine: true), stacks best threshold + best coupon
        const confirmedStack = computeSingleFinalPrice({
            price: 320,
            promotions: [
                { type: 'threshold', label: '满300减40', threshold: 300, amountOff: 40, confident: true, canCombine: true },
                { type: 'coupon', label: '领券减15元', threshold: 0, amountOff: 15, confident: true, canCombine: true },
            ],
            isDetailFetched: true,
        });
        expect(confirmedStack.finalPrice).toBe(265);

        // 4. Treats "直降" as possibly already in promoPrice and does not subtract it again
        const zhijiangRes = computeSingleFinalPrice({
            price: 120,
            promoPrice: 100,
            promotions: ['直降20元'],
            isDetailFetched: true,
        });
        expect(zhijiangRes.finalPrice).toBe(100);
        expect(zhijiangRes.finalPriceDiscounts).toEqual([]);
        expect(zhijiangRes.priceType).toBe('promo_only');
    });

    it('computes per-SKU final prices where higher-priced SKUs trigger higher single best deal', () => {
        const calc = computeProductAndSkuFinalPrices({
            itemId: '678901234567',
            price: 180,
            originalPrice: 180,
            isDetailFetched: true,
            rawPromotions: [
                { type: 'threshold', label: '满300减50', threshold: 300, amountOff: 50, confident: true },
                { type: 'coupon', label: '满100减10', threshold: 100, amountOff: 10, confident: true },
            ],
            skus: [
                { skuId: 'sku_basic', props: '颜色: 黑色; 版本: 标准版', price: 180, originalPrice: 180, stock: 50, image: null },
                { skuId: 'sku_pro', props: '颜色: 黑色; 版本: 旗舰版', price: 320, originalPrice: 320, stock: 20, image: null },
            ],
        });

        // Basic SKU (180): only qualifies for 满100减10 -> 170
        expect(calc.skus[0].finalPrice).toBe(170);
        // Pro SKU (320): single best deal is 满300减50 -> 320 - 50 = 270
        expect(calc.skus[1].finalPrice).toBe(270);
    });

    it('never guesses when promotions are ambiguous ("买2件7折") or when detail was not fetched', () => {
        const ambiguous = computeSingleFinalPrice({
            price: 100,
            promotions: ['买2件7折'],
            isDetailFetched: true,
        });
        expect(ambiguous.finalPrice).toBeNull();
        expect(ambiguous.priceType).toBe('partial');
        expect(ambiguous.unappliedDiscounts).toEqual(['买2件7折']);
        expect(ambiguous.finalPriceDiscounts[0].applied).toBe(false);

        const listingOnly = computeSingleFinalPrice({
            price: 100,
            promoPrice: 89,
            isDetailFetched: false,
        });
        expect(listingOnly.finalPrice).toBeNull();
        expect(listingOnly.priceType).toBe('promo_only');
    });
});

describe('6. MEDIUM Regressions (#7, #8, #9, #12, #13, #15)', () => {
    it('MEDIUM #7 Regression: parses shippingFee "快递: 10.00" as 10, computes shopAgeYears from opening year, does not fallback shopProductCount to goodRatePercentage, never builds shopUrl from userId, and flags SKU originalPrice fallback', () => {
        const currentYear = new Date().getFullYear();
        const parsed = parseMtopDetailData('678901234567', {
            item: { title: '测试详情解析商品' },
            price: {
                price: { priceText: '199.00' },
                extraPrices: [{ priceText: '299.00' }],
            },
            delivery: {
                from: '浙江杭州',
                postage: '快递: 10.00',
            },
            seller: {
                userId: '88888888', // No shopId provided!
                shopName: '测试无ShopId店铺',
                starts: '2018-06-15',
                goodRatePercentage: '99.2%',
            },
            skuBase: {
                props: [{ pid: '1', name: '版本', values: [{ vid: '10', name: '标准' }, { vid: '20', name: '无价版' }] }],
                skus: [
                    { skuId: '1001', propPath: '1:10' },
                    { skuId: '1002', propPath: '1:20' },
                ],
            },
            skuCore: {
                sku2info: {
                    '1001': { quantity: 10, price: { priceText: '210.00' }, extraPrices: [{ priceText: '250.00' }] },
                    '1002': { quantity: 5 }, // Missing own SKU price data -> falls back to item price 199 and flags it
                },
            },
        });

        expect(parsed.shippingFee).toBe(10);
        expect(parsed.shopAgeYears).toBe(currentYear - 2018);
        expect(parsed.shopProductCount).toBeNull();
        expect(parsed.shopId).toBeNull();
        expect(parsed.shopUrl).toBeNull();

        expect(parsed.skus?.[0].originalPrice).toBe(250);
        expect(parsed.skus?.[0].originalPriceFallback).toBe(false);
        expect(parsed.skus?.[1].originalPrice).toBe(199);
        expect(parsed.skus?.[1].originalPriceFallback).toBe(true);
    });

    it('MEDIUM #8 Regression: sets exchangeRateSource ("live" | "fallback") and uses static fallback date instead of today when offline', async () => {
        const fallbackCurrency = new CurrencyService('USD', {
            persistToStore: false,
            customFetcher: async () => ({
                base: 'CNY',
                date: null,
                rates: { CNY: 1, USD: 0.1385 },
                source: 'fallback-static',
                exchangeRateSource: 'fallback',
            }),
        });
        await fallbackCurrency.init();
        const convFallback = fallbackCurrency.convert(100);
        expect(convFallback.exchangeRateSource).toBe('fallback');
        expect(convFallback.exchangeRateDate).toBe(FALLBACK_RATES_DATE);
        expect(convFallback.exchangeRateDate).not.toBe(new Date().toISOString().slice(0, 10));

        const liveCurrency = new CurrencyService('USD', {
            persistToStore: false,
            customFetcher: async () => ({
                base: 'CNY',
                date: '2026-11-19',
                rates: { CNY: 1, USD: 0.14 },
                source: 'https://open.er-api.com/v6/latest/CNY',
                exchangeRateSource: 'live',
            }),
        });
        await liveCurrency.init();
        const convLive = liveCurrency.convert(100);
        expect(convLive.exchangeRateSource).toBe('live');
        expect(convLive.exchangeRateDate).toBe('2026-11-19');
    });

    it('MEDIUM #9 Regression: TranslatorService batches texts, retries on failure, never caches failed or partial translations, keeps Chinese when translation fails, and reports translationStatus', async () => {
        let batchCalls = 0;
        let failMode = false;
        const translator = new TranslatorService({
            enabled: true,
            persistToStore: false,
            maxRetries: 2,
            baseBackoffMs: 5,
            provider: {
                name: 'BatchTestProvider',
                translateText: async (t) => {
                    if (failMode) throw new Error('Network error');
                    return `EN_${t}`;
                },
                translateBatch: async (texts) => {
                    batchCalls += 1;
                    if (failMode) throw new Error('Batch network error');
                    return texts.map((t) => (t.includes('部分') ? `Partial ${t}` : 'Complete Product Title'));
                },
            },
        });

        // 1. Complete + partial translation in one batch request
        const batch1 = await translator.translateBatchWithStatus(['完整商品标题', '部分翻译词条']);
        expect(batchCalls).toBe(1);
        expect(batch1.results).toEqual(['Complete Product Title', 'Partial 部分翻译词条']);
        expect(batch1.status).toBe('partial');
        // Only the complete translation (without CJK) was cached!
        expect(translator.getCacheSize()).toBe(1);

        // 2. When provider fails, sets null (not Chinese text), never caches, and sets status 'failed'
        failMode = true;
        const batchFail = await translator.translateBatchWithStatus(['未缓存的中文标题']);
        expect(batchFail.results).toEqual([null]);
        expect(batchFail.status).toBe('failed');
        expect(translator.getCacheSize()).toBe(1);
    });

    it('MEDIUM #12 Regression: CircuitBreaker shared module-level gate pauses all concurrent workers together', async () => {
        const cb = new CircuitBreaker({ threshold: 2, pauseDurationMs: 60 });
        const start = Date.now();

        // Trigger the 2nd consecutive block -> enters 60ms shared pause
        await cb.recordBlock('block_1');
        const p1 = cb.recordBlock('block_2');

        // Another worker awaiting waitForGate() must also wait for the 60ms pause
        let worker2FinishedAt = 0;
        const p2 = cb.waitForGate().then(() => {
            worker2FinishedAt = Date.now() - start;
        });

        await Promise.all([p1, p2]);
        expect(worker2FinishedAt).toBeGreaterThanOrEqual(45);
    });

    it('MEDIUM #13 Regression: classifyUrl rejects non-Taobao/Tmall domains and buildInitialTasks turns bad URLs/IDs into invalid tasks without throwing', () => {
        expect(() => classifyUrl('https://example.com/shop/123')).toThrow(/Unsupported domain/i);
        expect(() => classifyUrl('https://www.google.com/search?q=shoe')).toThrow(/Unsupported domain/i);

        const tasks = buildInitialTasks({
            startUrls: ['not-a-valid-url', 'https://example.com/item.htm?id=12345', 'https://item.taobao.com/item.htm?id=678901234567'],
            itemIds: ['bad_id', '712345678901'],
        });
        expect(tasks.filter((t) => t.type === 'invalid')).toHaveLength(3);
        expect(tasks.filter((t) => t.type === 'product')).toHaveLength(2);
    });

    it('MEDIUM #15 Regression: BillingManager reads ACTOR_MAX_TOTAL_CHARGE_USD, does not count throwing Actor.charge as successful, and stops cleanly on eventChargeLimitReached', async () => {
        const prevEnv = process.env.ACTOR_MAX_TOTAL_CHARGE_USD;
        process.env.ACTOR_MAX_TOTAL_CHARGE_USD = '0.05';
        try {
            const bm = new BillingManager();
            expect(bm.getSummary().maxChargeLimitUsd).toBe(0.05);

            // 1. Actor.charge throws -> not counted as charged
            const chargeSpy = vi.spyOn(Actor, 'charge').mockRejectedValueOnce(new Error('Charge API failure'));
            const okThrow = await bm.chargeEvent('listing', 1);
            expect(okThrow).toBe(false);
            expect(bm.getSummary().eventsCharged.listing).toBe(0);

            // 2. Actor.charge returns eventChargeLimitReached: true -> stops cleanly
            chargeSpy.mockResolvedValueOnce({ eventChargeLimitReached: true, chargedCount: 0 } as never);
            const okLimit = await bm.chargeEvent('listing', 1);
            expect(okLimit).toBe(false);
            expect(bm.isLimitReached()).toBe(true);
            chargeSpy.mockRestore();
        } finally {
            if (prevEnv === undefined) delete process.env.ACTOR_MAX_TOTAL_CHARGE_USD;
            else process.env.ACTOR_MAX_TOTAL_CHARGE_USD = prevEnv;
        }
    });
});

describe('7. LOW Regressions (router subdomains, first block error, shop summary row, top-level filter schema)', () => {
    it('LOW Regression: excludes fav.taobao.com and error.taobao.com from shop routing and merges top-level search filter fields with backward compatibility', () => {
        expect(() => classifyUrl('https://fav.taobao.com/popup/add_collection.htm')).toThrow(/Rejected URL/i);
        expect(() => classifyUrl('https://error.taobao.com/app/tbhome/common/error.html')).toThrow(/Rejected URL/i);

        const normalized = validateAndNormalizeInput({
            keywords: ['耳机'],
            minPrice: 50,
            maxPrice: 300,
            tmallOnly: true,
            location: '深圳',
            sort: 'sales',
        });
        expect(normalized.searchFilters).toEqual({
            minPrice: 50,
            maxPrice: 300,
            tmallOnly: true,
            location: '深圳',
            sort: 'sales',
        });
    });

    it('LOW Regression: LayeredProductDetailSource reports the FIRST call block/error (e.g. RGV587_ERROR) instead of the second call generic error', async () => {
        const client = new TaobaoH5Client({
            requestDelayMs: 0,
            baseBackoffMs: 1,
            maxRetries: 1,
            customFetch: async (url) => {
                if (url.includes('mtop.taobao.pcdetail.data.get')) {
                    return {
                        statusCode: 200,
                        headers: {},
                        body: JSON.stringify({ ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!'] }),
                    };
                }
                if (url.includes('mtop.taobao.detail.getdetail')) {
                    return {
                        statusCode: 500,
                        headers: {},
                        body: 'Internal Server Error',
                    };
                }
                return { statusCode: 404, headers: {}, body: 'Not Found' };
            },
        });

        const detailSource = new LayeredProductDetailSource(client);
        const res = await detailSource.fetchProductDetail('678901234567', 'taobao');
        expect(res.ok).toBe(false);
        expect(res.blocked).toBe(true);
        expect(res.errorReason).toContain('RGV587_ERROR');
    });

    it('LOW Regression: buildShopSummaryRow does not set brand = shopName, computes real dataCompleteness, and sets changeType to null before monitoring evaluation', async () => {
        const translator = new TranslatorService({ enabled: false, persistToStore: false });
        const currencyService = new CurrencyService('USD', { persistToStore: false });
        const shopRow = await buildShopSummaryRow({
            shopInfo: {
                shopId: '108472391',
                shopName: '极客外设专营店',
                platform: 'taobao',
            },
            shopUrl: 'https://shop108472391.taobao.com',
            catalogueItemIds: ['111', '222'],
            translator,
            currencyService,
        });

        expect(shopRow.brand).toBeNull();
        expect(shopRow.dataCompleteness).toBeLessThan(100);
        expect(shopRow.missingFields).toContain('sellerScores');
        expect(shopRow.changeType).toBeNull();
    });
});

describe('8. Regressions for Issues #3-#9, #11-#12', () => {
    it('Issue #3 Regression: allows tmall.hk and its subdomains (detail.tmall.hk, brand.tmall.hk)', () => {
        expect(isAllowedTaobaoTmallHost('tmall.hk')).toBe(true);
        expect(isAllowedTaobaoTmallHost('detail.tmall.hk')).toBe(true);
        expect(isAllowedTaobaoTmallHost('brand.tmall.hk')).toBe(true);

        const hkProduct = classifyUrl('https://detail.tmall.hk/hk/item.htm?id=789012345678');
        expect(hkProduct.type).toBe('product');
        expect(hkProduct.itemId).toBe('789012345678');
        expect(hkProduct.platform).toBe('tmall');

        const hkShop = classifyUrl('https://cosmetics.tmall.hk/search.htm?search=y');
        expect(hkShop.type).toBe('shop');
        expect(hkShop.platform).toBe('tmall');
    });

    it('Issue #4 Regression: GTX sends POST form body, caps batches at ~5 KB encoded, backs off exponentially on 429, sets titleEn null + translationStatus "failed" on failure, stores bounded shard records, and supports paid providers', async () => {
        // 1. Batch capping at ~5 KB encoded
        const longChineseStrings = Array.from({ length: 30 }, (_, i) => `超长测试商品标题编号${i}_${'测试内容'.repeat(25)}`);
        const chunks = splitIntoEncodedBatches(longChineseStrings, 4800);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
            expect(encodeURIComponent(chunk.join('\n')).length).toBeLessThanOrEqual(4800);
        }

        // 2. POST form body & exponential backoff on HTTP 429
        const callTimestamps: number[] = [];
        const methodsUsed: string[] = [];
        const bodiesSent: string[] = [];
        const gtx = new FreeGtxTranslationProvider({
            maxRetries: 3,
            baseBackoffMs: 25,
            customFetch: (async (_url: string | URL | Request, init?: RequestInit) => {
                callTimestamps.push(Date.now());
                methodsUsed.push(init?.method ?? 'GET');
                bodiesSent.push(String(init?.body ?? ''));
                if (callTimestamps.length < 3) {
                    return new Response('Too Many Requests', { status: 429 });
                }
                return new Response(JSON.stringify([[['Translated Headphones', '新款耳机']]]), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }) as typeof fetch,
        });

        const translated = await gtx.translateBatch(['新款耳机']);
        expect(translated).toEqual(['Translated Headphones']);
        expect(methodsUsed).toEqual(['POST', 'POST', 'POST']);
        expect(bodiesSent[0]).toContain('q=');
        expect(callTimestamps).toHaveLength(3);
        const gap1 = callTimestamps[1] - callTimestamps[0];
        const gap2 = callTimestamps[2] - callTimestamps[1];
        expect(gap1).toBeGreaterThanOrEqual(35); // 25 * 2^0 * 2 (429 multiplier) = 50ms
        expect(gap2).toBeGreaterThanOrEqual(75); // 25 * 2^1 * 2 = 100ms

        // 3. On failure, sets titleEn to null (not Chinese text) and translationStatus to "failed"
        const failingTranslator = new TranslatorService({
            enabled: true,
            persistToStore: false,
            maxRetries: 1,
            provider: {
                name: 'AlwaysFailProvider',
                translateText: async () => {
                    throw new Error('429 Too Many Requests');
                },
                translateBatch: async () => {
                    throw new Error('429 Too Many Requests');
                },
            },
        });
        const currencyService = new CurrencyService('USD', { persistToStore: false });
        const failedProduct = await assembleProductOutput({
            partial: {
                itemId: '678901234567',
                title: '翻译失败测试商品标题',
                price: 99,
            },
            translator: failingTranslator,
            currencyService,
            selectedAgents: ['superbuy'],
            includeShopInfo: true,
        });
        expect(failedProduct.title).toBe('翻译失败测试商品标题');
        expect(failedProduct.titleEn).toBeNull();
        expect(failedProduct.translationStatus).toBe('failed');

        // 4. Bounded multi-record KV store cache
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-trans-shards-'));
        const prevDir = process.env.APIFY_LOCAL_STORAGE_DIR;
        process.env.APIFY_LOCAL_STORAGE_DIR = tempDir;
        try {
            const shardedTranslator = new TranslatorService({
                enabled: true,
                persistToStore: true,
                shardCount: 4,
                maxEntriesPerShard: 3,
                provider: {
                    name: 'MockProvider',
                    translateText: async (t) => `[EN] ${t.replace(/[\u4e00-\u9fff]+/g, 'item')}`,
                    translateBatch: async (ts) => ts.map((t) => `[EN] ${t.replace(/[\u4e00-\u9fff]+/g, 'item')}`),
                },
            });
            const inputs = Array.from({ length: 16 }, (_, idx) => `商品缓存测试词条_${idx}`);
            await shardedTranslator.translateBatchWithStatus(inputs);
            await shardedTranslator.flushToKvStore();

            // Total cache size is bounded by shardCount (4) * maxEntriesPerShard (3) = 12
            expect(shardedTranslator.getCacheSize()).toBeLessThanOrEqual(12);
            expect(shardedTranslator.getShardCount()).toBeGreaterThan(1);

            const store = await Actor.openKeyValueStore(TRANSLATION_STORE_NAME);
            const shardIndex = await store.getValue<string[]>(TRANSLATION_INDEX_KEY);
            expect(Array.isArray(shardIndex)).toBe(true);
            expect(shardIndex!.length).toBeGreaterThan(1);
            for (const shardKey of shardIndex!) {
                const shardRecord = await store.getValue<Record<string, string>>(shardKey);
                expect(Object.keys(shardRecord ?? {}).length).toBeLessThanOrEqual(3);
            }
        } finally {
            if (prevDir === undefined) delete process.env.APIFY_LOCAL_STORAGE_DIR;
            else process.env.APIFY_LOCAL_STORAGE_DIR = prevDir;
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }

        // 5. Pluggable paid providers (DeepL & Google Cloud via API key)
        const deeplProvider = createTranslationProvider({ provider: 'deepl', apiKey: 'mock-deepl-placeholder' });
        expect(deeplProvider).toBeInstanceOf(DeepLTranslationProvider);
        const googleProvider = createTranslationProvider({ provider: 'google', apiKey: 'mock-gcloud-placeholder' });
        expect(googleProvider).toBeInstanceOf(GoogleCloudTranslationProvider);
    });

    it('Issue #5 & #7 Regression: conditional free shipping (满X包邮) gives shippingFee null + shippingNote, and originalPriceFallback is true whenever any fallback is used', () => {
        const parsed = parseMtopDetailData('678901234567', {
            item: { title: '条件包邮与SKU原价回退商品' },
            price: {
                price: { priceText: '80.00' },
                extraPrices: [{ priceText: '120.00' }],
            },
            delivery: {
                from: '广东广州',
                postage: '满88元包邮',
            },
            skuBase: {
                props: [{ pid: '1', name: '规格', values: [{ vid: '1', name: 'A' }, { vid: '2', name: 'B' }, { vid: '3', name: 'C' }] }],
                skus: [
                    { skuId: '101', propPath: '1:1' },
                    { skuId: '102', propPath: '1:2' },
                    { skuId: '103', propPath: '1:3' },
                ],
            },
            skuCore: {
                sku2info: {
                    '101': { quantity: 10, price: { priceText: '85.00' }, extraPrices: [{ priceText: '100.00' }] },
                    '102': { quantity: 10, price: { priceText: '85.00' } }, // Falls back to ownSkuPrice 85 -> originalPriceFallback must be true!
                    '103': { quantity: 10 }, // Falls back to item price 80 -> originalPriceFallback must be true!
                },
            },
        });

        expect(parsed.shippingFee).toBeNull();
        expect(parsed.shippingNote).toBe('满88元包邮');

        expect(parsed.skus?.[0].originalPrice).toBe(100);
        expect(parsed.skus?.[0].originalPriceFallback).toBe(false);

        expect(parsed.skus?.[1].originalPrice).toBe(85);
        expect(parsed.skus?.[1].originalPriceFallback).toBe(true);

        expect(parsed.skus?.[2].originalPrice).toBe(80);
        expect(parsed.skus?.[2].originalPriceFallback).toBe(true);
    });

    it('Issue #6 Regression: input_schema.json minPrice and maxPrice have type "number", not "integer"', async () => {
        const schemaRaw = await fs.readFile(path.resolve('.actor/input_schema.json'), 'utf8');
        const schema = JSON.parse(schemaRaw) as {
            properties: Record<string, { type: string }>;
        };
        expect(schema.properties.minPrice.type).toBe('number');
        expect(schema.properties.maxPrice.type).toBe('number');

        const normalized = validateAndNormalizeInput({
            keywords: ['测试'],
            minPrice: 9.9,
            maxPrice: 199.99,
        });
        expect(normalized.searchFilters?.minPrice).toBe(9.9);
        expect(normalized.searchFilters?.maxPrice).toBe(199.99);
    });

    it('Issue #8 Regression: when several deals exist and only the best one is applied (no confirmed stacking), sets priceType "partial" and lists the others in unappliedDiscounts', () => {
        const res = computeSingleFinalPrice({
            price: 300,
            promotions: ['满200减30', '领券减20元', '限时9.5折'],
            isDetailFetched: true,
        });
        expect(res.finalPrice).toBe(270);
        expect(res.priceType).toBe('partial');
        expect(res.unappliedDiscounts).toEqual(['领券减20元', '限时9.5折']);
    });

    it('Issue #9 & #12 Regression: BillingManager does not charge final-price for a plain listed promo price (only coupon, shop_discount, or threshold), and README matches proxy & pricing behaviour', async () => {
        const baseRecord = {
            itemId: '123456',
            url: 'https://item.taobao.com/item.htm?id=123456',
            platform: 'taobao' as const,
            title: '测试商品',
            titleEn: 'Test Product',
            brand: null,
            categoryPath: null,
            mainImage: null,
            images: [],
            descriptionImages: [],
            videoUrl: null,
            attributes: {},
            attributesEn: {},
            price: 100,
            originalPrice: 120,
            promoPrice: 85,
            finalPrice: 85,
            finalPriceDiscounts: [
                {
                    type: 'promo' as const,
                    label: '促销价85元',
                    amountOff: 15,
                    applied: true,
                },
            ],
            unappliedDiscounts: [],
            priceType: 'exact_final' as const,
            currency: 'USD',
            priceConverted: 11.9,
            exchangeRate: 0.14,
            exchangeRateDate: '2026-11-19',
            exchangeRateSource: 'live' as const,
            translationStatus: 'ok' as const,
            salesText: null,
            salesCount: null,
            stock: null,
            skus: [],
            shipFrom: null,
            shippingFee: 0,
            shippingNote: null,
            shopId: null,
            shopName: null,
            shopType: null,
            shopUrl: null,
            sellerScores: null,
            creditLevel: null,
            shopAgeYears: null,
            shopProductCount: null,
            agentLinks: {},
            dataCompleteness: 80,
            missingFields: [],
            status: 'ok' as const,
            errorReason: null,
            scrapedAt: new Date().toISOString(),
            changeType: null,
            previousValues: {},
        };

        // Plain promo type must NOT trigger final-price charge
        expect(BillingManager.hasRealAppliedDeal(baseRecord)).toBe(false);

        // Coupon, shop_discount, and threshold DO trigger final-price charge
        for (const validType of ['coupon', 'shop_discount', 'threshold'] as const) {
            expect(
                BillingManager.hasRealAppliedDeal({
                    ...baseRecord,
                    finalPriceDiscounts: [{ type: validType, label: '优惠', amountOff: 10, applied: true }],
                }),
            ).toBe(true);
        }

        const readme = await fs.readFile(path.resolve('README.md'), 'utf8');
        expect(readme).toContain('never charged for a plain listed promo price');
        expect(readme).toContain('Actor.createProxyConfiguration(input.proxyConfiguration)');
        expect(readme).toContain('proxyUrls');
    });

    it('Issue #11 Regression: MonitoringService shards by a hash of itemId across 64 buckets and loads only the shards needed', async () => {
        // Different itemIds with the same 2-digit prefix ("67...") distribute across different hash buckets in 00..63
        const bucketsSeen = new Set<string>();
        for (let i = 0; i < 40; i++) {
            const b = getItemShardBucket(`67890123${String(i).padStart(4, '0')}`);
            expect(Number(b)).toBeGreaterThanOrEqual(0);
            expect(Number(b)).toBeLessThan(MONITORING_SHARD_COUNT);
            bucketsSeen.add(b);
        }
        expect(bucketsSeen.size).toBeGreaterThan(10);

        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-mon-shards-'));
        const prevDir = process.env.APIFY_LOCAL_STORAGE_DIR;
        process.env.APIFY_LOCAL_STORAGE_DIR = tempDir;
        try {
            const scope = 'lazy_shard_test';
            const store = await Actor.openKeyValueStore(MONITORING_STORE_NAME);
            const targetItemId = '678901234567';
            const targetBucket = getItemShardBucket(targetItemId);
            const otherBucket = targetBucket === '00' ? '01' : '00';

            await store.setValue(getShardIndexKey(scope), [targetBucket, otherBucket]);
            await store.setValue(getShardRecordKey(scope, targetBucket), {
                [targetItemId]: {
                    hash: 'old_hash',
                    title: '旧标题',
                    price: 100,
                    originalPrice: 100,
                    promoPrice: null,
                    finalPrice: 100,
                    stock: 10,
                    salesCount: 5,
                    skuDigest: '',
                    updatedAt: '2026-11-18T00:00:00.000Z',
                },
            });
            await store.setValue(getShardRecordKey(scope, otherBucket), {
                '999999999999': {
                    hash: 'other_hash',
                    title: '其他分片商品',
                    price: 50,
                    originalPrice: 50,
                    promoPrice: null,
                    finalPrice: 50,
                    stock: 5,
                    salesCount: 1,
                    skuDigest: '',
                    updatedAt: '2026-11-18T00:00:00.000Z',
                },
            });

            const mon = new MonitoringService(true, undefined, {
                persistToStore: true,
                monitoringKey: scope,
            });
            await mon.init();
            // init() must NOT preload any shard buckets
            expect(mon.getLoadedBucketCount()).toBe(0);

            const translator = new TranslatorService({ enabled: false, persistToStore: false });
            const currencyService = new CurrencyService('USD', { persistToStore: false });
            const prod = await assembleProductOutput({
                partial: { itemId: targetItemId, title: '新标题', price: 90 },
                translator,
                currencyService,
                selectedAgents: [],
                includeShopInfo: false,
            });

            const evalRes = await mon.evaluateAsync(prod);
            expect(evalRes.product.changeType).toBe('changed');
            // Only the 1 shard needed for targetItemId was loaded!
            expect(mon.getLoadedBucketCount()).toBe(1);
        } finally {
            if (prevDir === undefined) delete process.env.APIFY_LOCAL_STORAGE_DIR;
            else process.env.APIFY_LOCAL_STORAGE_DIR = prevDir;
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });
});

describe('9. Launch-Ready Regressions (Part 1 Fixes #1-#9)', () => {
    it('Fix #1 Regression: wraps each fetchGtxRaw batch in try/catch (keeping & caching successful batches), respects Retry-After or 2-5s backoff on 429, and stops GTX after 3 consecutive 429s with single warning', async () => {
        // 1a. Multi-batch partial failure: Batch 1 succeeds (kept & cached), Batch 2 fails (only Batch 2 strings nulled)
        let batchCall = 0;
        const gtxPartial = new FreeGtxTranslationProvider({
            maxRetries: 1,
            baseBackoffMs: 5,
            maxBatchEncodedBytes: 60, // Force 2 batches
            customFetch: (async () => {
                batchCall += 1;
                if (batchCall === 1) {
                    return new Response(JSON.stringify([[['First Batch Item', '第一批商品词条一']]]), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                return new Response('Internal Server Error', { status: 500 });
            }) as typeof fetch,
        });

        const servicePartial = new TranslatorService({
            enabled: true,
            persistToStore: false,
            provider: gtxPartial,
        });

        const partialRes = await servicePartial.translateBatchWithStatus(['第一批商品词条一', '第二批失败商品词条二']);
        expect(partialRes.results).toEqual(['First Batch Item', null]);
        expect(partialRes.status).toBe('partial');
        expect(servicePartial.getCacheSize()).toBe(1);
        expect(await servicePartial.translate('第一批商品词条一')).toBe('First Batch Item');

        // 1b. Respects Retry-After header on 429
        const retryTimestamps: number[] = [];
        const gtxRetryAfter = new FreeGtxTranslationProvider({
            maxRetries: 3,
            customFetch: (async () => {
                retryTimestamps.push(Date.now());
                if (retryTimestamps.length === 1) {
                    return new Response('Too Many Requests', {
                        status: 429,
                        headers: { 'Retry-After': '0.06' },
                    });
                }
                return new Response(JSON.stringify([[['Retry After Translated', '重试头部测试词条']]]), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }) as typeof fetch,
        });

        const retryAfterOut = await gtxRetryAfter.translateBatch(['重试头部测试词条']);
        expect(retryAfterOut).toEqual(['Retry After Translated']);
        expect(retryTimestamps).toHaveLength(2);
        expect(retryTimestamps[1] - retryTimestamps[0]).toBeGreaterThanOrEqual(45);

        // 1c. After 3 consecutive 429s in a run, stops calling GTX for the rest of the run, marks remaining strings translationStatus "failed", and logs once
        let gtx429Calls = 0;
        const warnSpy = vi.spyOn(log, 'warning');
        try {
            const gtxTripped = new FreeGtxTranslationProvider({
                maxRetries: 3,
                baseBackoffMs: 5,
                maxBatchEncodedBytes: 60, // Multiple batches
                customFetch: (async () => {
                    gtx429Calls += 1;
                    return new Response('Too Many Requests', { status: 429 });
                }) as typeof fetch,
            });

            const serviceTripped = new TranslatorService({
                enabled: true,
                persistToStore: false,
                provider: gtxTripped,
            });

            const res1 = await serviceTripped.translateBatchWithStatus([
                '连续限流测试词条一',
                '连续限流测试词条二',
            ]);
            // Stopped after 3 consecutive 429s — 2nd batch was never even requested!
            expect(gtx429Calls).toBe(3);
            expect(gtxTripped.isRateLimitTripped()).toBe(true);
            expect(res1.results).toEqual([null, null]);
            expect(res1.status).toBe('failed');

            // Subsequent calls in the same run do not call GTX at all and mark translationStatus "failed"
            const res2 = await serviceTripped.translateBatchWithStatus(['后续不再请求词条三']);
            expect(gtx429Calls).toBe(3);
            expect(res2.results).toEqual([null]);
            expect(res2.status).toBe('failed');

            const gtxWarnCalls = warnSpy.mock.calls.filter((c) =>
                String(c[0]).includes('3 consecutive HTTP 429'),
            );
            expect(gtxWarnCalls).toHaveLength(1);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('Fix #2 Regression: DeepL caps at 50 texts per request and Google Cloud caps at 128 texts per request while keeping the byte cap', async () => {
        const deeplBatchSizes: number[] = [];
        const deepl = new DeepLTranslationProvider({
            apiKey: 'test-deepl-key:fx',
            maxBatchEncodedBytes: 100_000,
            customFetch: (async (_url: string | URL | Request, init?: RequestInit) => {
                const params = new URLSearchParams(String(init?.body ?? ''));
                const texts = params.getAll('text');
                deeplBatchSizes.push(texts.length);
                return new Response(
                    JSON.stringify({ translations: texts.map((t, idx) => ({ text: `DL_${idx}_${t}` })) }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }) as typeof fetch,
        });

        const inputs120 = Array.from({ length: 120 }, (_, i) => `词${i}`);
        const deeplOut = await deepl.translateBatch(inputs120);
        expect(deeplOut).toHaveLength(120);
        expect(deeplBatchSizes).toEqual([50, 50, 20]);

        const googleBatchSizes: number[] = [];
        const google = new GoogleCloudTranslationProvider({
            apiKey: 'test-google-key',
            maxBatchEncodedBytes: 100_000,
            customFetch: (async (_url: string | URL | Request, init?: RequestInit) => {
                const body = JSON.parse(String(init?.body ?? '{}')) as { q: string[] };
                googleBatchSizes.push(body.q.length);
                return new Response(
                    JSON.stringify({
                        data: { translations: body.q.map((t, idx) => ({ translatedText: `GC_${idx}_${t}` })) },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }) as typeof fetch,
        });

        const inputs300 = Array.from({ length: 300 }, (_, i) => `词${i}`);
        const googleOut = await google.translateBatch(inputs300);
        expect(googleOut).toHaveLength(300);
        expect(googleBatchSizes).toEqual([128, 128, 44]);
    });

    it('Fix #3 Regression: when useApifyProxy is true with no proxyUrls and no apifyProxyGroups, sets apifyProxyGroups to ["RESIDENTIAL"] and apifyProxyCountry to "US" if missing, and rejects mainland China', () => {
        const norm1 = validateAndNormalizeInput({
            keywords: ['蓝牙耳机'],
            proxyConfiguration: { useApifyProxy: true },
        });
        expect(norm1.proxyConfiguration?.apifyProxyGroups).toEqual(['RESIDENTIAL']);
        expect(norm1.proxyConfiguration?.apifyProxyCountry).toBe('US');

        const norm2 = validateAndNormalizeInput({
            keywords: ['蓝牙耳机'],
            proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: [], apifyProxyCountry: 'SG' },
        });
        expect(norm2.proxyConfiguration?.apifyProxyGroups).toEqual(['RESIDENTIAL']);
        expect(norm2.proxyConfiguration?.apifyProxyCountry).toBe('SG');

        expect(() =>
            validateAndNormalizeInput({
                keywords: ['蓝牙耳机'],
                proxyConfiguration: { useApifyProxy: true, apifyProxyCountry: 'CN' },
            }),
        ).toThrow(/cannot be "CN"/i);
    });

    it('Fix #6 Regression: respects chosen translationProvider, logs warning and falls back to GTX when deepl/google has no key, and never switches from GTX to a paid provider just because a key exists', () => {
        const warnSpy = vi.spyOn(log, 'warning');
        try {
            // 1. GTX with API keys present -> stays FreeGtxTranslationProvider
            const pGtxWithKeys = createTranslationProvider({
                provider: 'gtx',
                apiKey: 'some-paid-key',
                deeplApiKey: 'some-deepl-key',
                googleTranslateApiKey: 'some-google-key',
            });
            expect(pGtxWithKeys).toBeInstanceOf(FreeGtxTranslationProvider);

            // Default provider (omitted) with apiKey -> stays FreeGtxTranslationProvider
            const pDefaultWithKey = createTranslationProvider({
                apiKey: 'some-paid-key',
            });
            expect(pDefaultWithKey).toBeInstanceOf(FreeGtxTranslationProvider);

            // 2. DeepL chosen without API key -> logs warning and falls back to GTX
            const pDeeplNoKey = createTranslationProvider({ provider: 'deepl' });
            expect(pDeeplNoKey).toBeInstanceOf(FreeGtxTranslationProvider);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/deepl.*without an API key/i));

            // 3. Google chosen without API key -> logs warning and falls back to GTX
            const pGoogleNoKey = createTranslationProvider({ provider: 'google' });
            expect(pGoogleNoKey).toBeInstanceOf(FreeGtxTranslationProvider);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/google.*without an API key/i));
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('Fix #7 Regression: production TranslatorService does not treat "[EN]" prefix with remaining Chinese characters as a complete cacheable translation', async () => {
        const translator = new TranslatorService({
            enabled: true,
            persistToStore: false,
            provider: {
                name: 'UntranslatedPrefixProvider',
                translateText: async (t) => `[EN] ${t}`,
                translateBatch: async (ts) => ts.map((t) => `[EN] ${t}`),
            },
        });

        const res = await translator.translateBatchWithStatus(['仍含中文的测试标题']);
        expect(res.status).toBe('partial');
        // Must NOT be cached because it still contains Chinese characters
        expect(translator.getCacheSize()).toBe(0);
    });

    it('Fix #8 Regression: for text like "满88元包邮 快递 8.00", sets shippingFee to 8 and keeps the condition in shippingNote', () => {
        const parsed = parseMtopDetailData('678901234567', {
            item: { title: '条件包邮含快递费测试商品' },
            price: { price: { priceText: '59.00' } },
            delivery: {
                from: '浙江金华',
                postage: '满88元包邮 快递 8.00',
            },
        });

        expect(parsed.shippingFee).toBe(8);
        expect(parsed.shippingNote).toContain('满88元包邮');
    });

    it('Fix #9 Regression: translationApiKey is marked isSecret: true in .actor/input_schema.json', async () => {
        const schemaRaw = await fs.readFile(path.resolve('.actor/input_schema.json'), 'utf8');
        const schema = JSON.parse(schemaRaw) as {
            properties: Record<string, { isSecret?: boolean }>;
        };
        expect(schema.properties.translationApiKey?.isSecret).toBe(true);
    });
});

describe('10. Launch-Ready Regressions (429 backoff, shipping regex, keyword-only prefill)', () => {
    it('default TranslatorService 429 retry waits 2-5s because it does not inject the 100ms service default into GTX', async () => {
        vi.useFakeTimers();
        const originalFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls += 1;
            if (fetchCalls === 1) {
                return new Response('Too Many Requests', { status: 429 });
            }
            return new Response(JSON.stringify([[['Default Backoff Translated', '默认退避测试词条']]]), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        try {
            const translator = new TranslatorService({
                enabled: true,
                persistToStore: false,
            });

            let settled = false;
            const pending = translator.translateBatchWithStatus(['默认退避测试词条']).finally(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(0);
            expect(fetchCalls).toBe(1);
            expect(settled).toBe(false);

            await vi.advanceTimersByTimeAsync(1999);
            expect(fetchCalls).toBe(1);
            expect(settled).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            const res = await pending;
            expect(fetchCalls).toBe(2);
            expect(res.results[0]).toBe('Default Backoff Translated');
        } finally {
            globalThis.fetch = originalFetch;
            vi.useRealTimers();
        }
    });

    it('parses shipping fees from 快递/运费/邮费 or ¥/￥ only: "2件包邮" is null with a note, "满88元包邮 快递 8.00" is 8, "包邮" is 0, "快递 0.00" is 0', () => {
        const twoPieceFree = parseMtopDetailData('678901234567', {
            item: { title: '两件包邮测试商品' },
            price: { price: { priceText: '59.00' } },
            delivery: { postage: '2件包邮' },
        });
        expect(twoPieceFree.shippingFee).toBeNull();
        expect(twoPieceFree.shippingNote).toBe('2件包邮');

        const mixed = parseMtopDetailData('678901234567', {
            item: { title: '条件包邮含快递费测试商品' },
            price: { price: { priceText: '59.00' } },
            delivery: { postage: '满88元包邮 快递 8.00' },
        });
        expect(mixed.shippingFee).toBe(8);
        expect(mixed.shippingNote).toContain('满88元包邮');

        const freeShip = parseMtopDetailData('678901234567', {
            item: { title: '包邮测试商品' },
            price: { price: { priceText: '59.00' } },
            delivery: { postage: '包邮' },
        });
        expect(freeShip.shippingFee).toBe(0);

        const zeroExpress = parseMtopDetailData('678901234567', {
            item: { title: '快递零元测试商品' },
            price: { price: { priceText: '59.00' } },
            delivery: { postage: '快递 0.00' },
        });
        expect(zeroExpress.shippingFee).toBe(0);
    });

    it('input schema default/prefill is a small keyword search, not product IDs or shop mode, and empty input {} works', async () => {
        const schemaRaw = await fs.readFile(path.resolve('.actor/input_schema.json'), 'utf8');
        const schema = JSON.parse(schemaRaw) as {
            properties: {
                startUrls?: { prefill?: Array<{ url?: string } | string> };
                itemIds?: { default?: string[] };
                keywords?: { prefill?: string[]; default?: string[] };
                maxItemsPerQuery?: { default?: number; prefill?: number };
                includeDetails?: { default?: boolean };
            };
        };
        const startPrefill = schema.properties.startUrls?.prefill ?? [];
        expect(startPrefill).toEqual([]);
        expect(JSON.stringify(startPrefill)).not.toContain('678901234567');
        expect(schema.properties.itemIds?.default ?? []).toEqual([]);
        expect(schema.properties.keywords?.prefill).toEqual(['机械键盘']);
        expect(schema.properties.keywords?.default).toEqual(['机械键盘']);
        expect(schema.properties.maxItemsPerQuery?.default).toBe(10);
        expect(schema.properties.maxItemsPerQuery?.prefill).toBe(10);
        expect(schema.properties.includeDetails?.default).toBe(false);

        const fromPrefill = validateAndNormalizeInput({
            startUrls: [],
            keywords: schema.properties.keywords?.prefill,
        });
        expect(fromPrefill.startUrls).toEqual([]);
        expect(fromPrefill.keywords).toEqual(['机械键盘']);
        expect(fromPrefill.includeDetails).toBe(false);
        expect(fromPrefill.maxItemsPerQuery).toBe(10);

        const fromEmpty = validateAndNormalizeInput({});
        expect(fromEmpty.keywords).toEqual(['机械键盘']);
        expect(fromEmpty.itemIds ?? []).toEqual([]);
        expect(fromEmpty.startUrls ?? []).toEqual([]);
        expect(fromEmpty.includeDetails).toBe(false);
        expect(fromEmpty.maxItemsPerQuery).toBe(10);

        const tasks = buildInitialTasks(fromEmpty);
        expect(tasks.some((t) => t.type === 'search' && t.keyword === '机械键盘')).toBe(true);
        expect(tasks.some((t) => t.type === 'product' || t.type === 'shop')).toBe(false);
    });
});

describe('10. v1.1 Anti-RGV587 Strategies, DEBUG_PROBE, Playwright Fallback Fixtures & Schema Validation', () => {
    it('DEBUG_PROBE records URL type, status code, proxy group/country, cookie names only, response size, and 500-char body preview without leaking cookie values or tokens', () => {
        const probe = new DebugProbeCollector({ proxyGroup: 'RESIDENTIAL', proxyCountry: 'CN' });
        const rawCookieHeader =
            '_m_h5_tk=secretToken1234567890abcdef123456_1732000000; _m_h5_tk_enc=encSecretValue999; cna=AxYz1234567890; t=tbSessionTokenSecret';
        const setCookieHeaders = [
            '_m_h5_tk=newSecretTokenabcdef123456789012_1732000100; Domain=.taobao.com; Path=/; HttpOnly; SameSite=None; Secure',
            'x5secdata=superSecretX5SecDataTokenValue; Max-Age=3600; Path=/',
        ];

        const names = extractCookieNamesOnly([rawCookieHeader, setCookieHeaders]);
        expect(names).toEqual(['_m_h5_tk', '_m_h5_tk_enc', 'cna', 't', 'x5secdata']);
        expect(JSON.stringify(names)).not.toContain('secretToken');
        expect(JSON.stringify(names)).not.toContain('Domain');
        expect(JSON.stringify(names)).not.toContain('HttpOnly');

        const longBody =
            `mtopjsonp1({"ret":["SUCCESS::调用成功"],"_m_h5_tk":"secretToken1234567890abcdef123456_1732000000","data":{"title":"测试商品` +
            'A'.repeat(700) +
            '"}})';
        probe.record({
            url: 'https://h5api.m.taobao.com/h5/mtop.taobao.detail.getdetail/6.0/?appKey=12574478&sign=abcdef0123456789abcdef0123456789&t=1732000000',
            statusCode: 200,
            cookieSources: [rawCookieHeader, setCookieHeaders],
            body: longBody,
        });

        const report = probe.getReport();
        expect(report.totalRequestsRecorded).toBe(1);
        const entry = report.requests[0]!;
        expect(entry.urlType).toBe('mtop_detail');
        expect(entry.statusCode).toBe(200);
        expect(entry.proxyGroup).toBe('RESIDENTIAL');
        expect(entry.proxyCountry).toBe('CN');
        expect(entry.cookiesPresent).toEqual(['_m_h5_tk', '_m_h5_tk_enc', 'cna', 't', 'x5secdata']);
        expect(entry.responseSize).toBe(Buffer.byteLength(longBody, 'utf8'));
        expect(entry.bodyPreview.length).toBeLessThanOrEqual(500);
        expect(entry.url).toContain('sign=%5BREDACTED%5D');
        expect(entry.url).not.toContain('abcdef0123456789abcdef0123456789');
        expect(entry.bodyPreview).not.toContain('secretToken1234567890abcdef123456');
        expect(sanitizeProbeUrl('https://world.taobao.com/item/slug.htm?token=mySecret123')).not.toContain('mySecret123');
        expect(sanitizeBodyPreview('cookie2=secretCookieValue987654; ok')).not.toContain('secretCookieValue987654');
    });

    it('normalizes taobaoCookies from both raw Cookie header strings and Cookie-Editor JSON arrays, and filters poison x5secdata cookies from session jars', async () => {
        const rawHeader = normalizeUserCookieString('cna=abc123; _m_h5_tk=tok123_1700000000; cookie2=sess456');
        expect(rawHeader).toBe('cna=abc123; _m_h5_tk=tok123_1700000000; cookie2=sess456');

        const jsonCookies = normalizeUserCookieString(
            JSON.stringify([
                { name: 'cna', value: 'jsonCna999' },
                { name: '_m_h5_tk', value: 'jsonTok888_1700000000' },
                { name: 'cookie2', value: 'jsonSess777' },
            ]),
        );
        expect(jsonCookies).toBe('cna=jsonCna999; _m_h5_tk=jsonTok888_1700000000; cookie2=jsonSess777');

        const observedCookies: string[] = [];
        const client = new TaobaoH5Client({
            userCookie: jsonCookies,
            enableSessionWarmup: false,
            baseBackoffMs: 1,
            customFetch: async (_url, options) => {
                observedCookies.push(options.headers.Cookie ?? options.headers.cookie ?? '');
                return {
                    statusCode: 200,
                    headers: {
                        'set-cookie': [
                            '_m_h5_tk=freshToken1111111111111111111111_1732000000; Path=/; Domain=.taobao.com',
                            '_m_h5_tk_enc=freshEnc2222222222222222222222; Path=/; Domain=.taobao.com',
                            'x5secdata=poisonCaptchaFlagShouldBeIgnored; Path=/; Domain=.taobao.com',
                        ],
                    },
                    body: 'mtopjsonp1({"ret":["SUCCESS::调用成功"],"data":{"ok":true}})',
                };
            },
        });

        const res = await client.requestMtop({
            platform: 'taobao',
            api: 'mtop.taobao.detail.getdetail',
            version: '6.0',
            data: { id: '681674848244' },
        });
        expect(res.ok).toBe(true);
        const jar = client.getTokenJarSnapshot('h5api.m.taobao.com');
        expect(jar.token).toBe('freshToken1111111111111111111111');
        expect(jar.extraCookies['x5secdata']).toBeUndefined();
        expect(observedCookies[0]).toContain('cookie2=jsonSess777');
    });

    it('detects RGV587 in both MTOP JSON and HTML (<!--rgv587_flag:sm-->), retires the Crawlee SessionPool session, and rotates proxy session + fallback country', async () => {
        const proxyCalls: Array<{ sessionId: string; country?: string }> = [];
        let callIndex = 0;

        const client = new TaobaoH5Client({
            enableSessionWarmup: true,
            forceWarmupWithCustomFetch: true,
            proxyCountry: 'CN',
            proxyFallbackCountries: ['CN', 'HK', 'TW', 'SG'],
            baseBackoffMs: 1,
            getProxyUrl: async (sessionId, countryCode) => {
                proxyCalls.push({ sessionId, country: countryCode });
                return `http://proxy.example.com:8000?session=${sessionId}&country=${countryCode}`;
            },
            customFetch: async (url) => {
                if (url.includes('world.taobao.com') || url.includes('mmstat.com') || url.includes('gettimestamp')) {
                    return {
                        statusCode: 200,
                        headers: {
                            'set-cookie': [
                                '_m_h5_tk=warmToken0123456789abcdef012345_1732000000; Path=/',
                                '_m_h5_tk_enc=warmEnc0123456789abcdef012345; Path=/',
                                'cna=warmCnaValue123; Path=/',
                                't=warmTValue456; Path=/',
                            ],
                        },
                        body: '{"ret":["SUCCESS::调用成功"],"data":{"t":"1732000000123"}}',
                    };
                }
                callIndex += 1;
                if (callIndex === 1) {
                    return {
                        statusCode: 200,
                        headers: {},
                        body: 'mtopjsonp1({"ret":["RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!"],"data":{}})',
                    };
                }
                return {
                    statusCode: 200,
                    headers: {},
                    body: 'mtopjsonp1({"ret":["SUCCESS::调用成功"],"data":{"item":{"itemId":"681674848244"}}})',
                };
            },
        });

        const firstSessionId = client.getCurrentSessionId();
        const mtopRes = await client.requestMtop({
            platform: 'taobao',
            api: 'mtop.taobao.detail.getdetail',
            version: '6.0',
            data: { id: '681674848244' },
        });

        expect(mtopRes.ok).toBe(true);
        const secondSessionId = client.getCurrentSessionId();
        expect(secondSessionId).not.toBe(firstSessionId);
        expect(client.getRetiredSessionIds()).toContain(firstSessionId);
        expect(client.getActiveProxyCountry()).toBe('HK');
        expect(proxyCalls.some((c) => c.country === 'CN')).toBe(true);
        expect(proxyCalls.some((c) => c.country === 'HK')).toBe(true);

        // Also verify HTML <!--rgv587_flag:sm--> login-wall detection rotates session
        const htmlBlockedClient = new TaobaoH5Client({
            enableSessionWarmup: false,
            proxyCountry: 'CN',
            proxyFallbackCountries: ['CN', 'TW'],
            baseBackoffMs: 1,
            customFetch: async () => ({
                statusCode: 200,
                headers: {},
                body: '<html><!--rgv587_flag:sm--><body><script>window.location.href="https://login.taobao.com/member/login.jhtml";</script></body></html>',
            }),
        });
        const htmlRes = await htmlBlockedClient.fetchHtmlPage('https://item.taobao.com/item.htm?id=681674848244', 1);
        expect(htmlRes.ok).toBe(false);
        expect(htmlRes.blocked).toBe(true);
        expect(htmlRes.errorReason).toContain('RGV587');
        expect(htmlBlockedClient.getActiveProxyCountry()).toBe('TW');
    });

    it('parses Playwright fallback product, search, and shop captures from real stripped fixtures', async () => {
        const pdpHtml = await fs.readFile(path.resolve('test/fixtures/world_taobao_pdp_ice.html'), 'utf8');
        const searchHtml = await fs.readFile(path.resolve('test/fixtures/world_taobao_search_ice.html'), 'utf8');
        const shopHtml = await fs.readFile(path.resolve('test/fixtures/world_taobao_shop_ice.html'), 'utf8');
        const mtopRaw = await fs.readFile(path.resolve('test/fixtures/mtop_getdetail_captured.json'), 'utf8');
        const mtopPayload = JSON.parse(mtopRaw) as Record<string, unknown>;

        // 1. Product parsing from SSR ICE HTML fixture
        const pdpFromHtml = parsePlaywrightProductCapture({
            itemId: '681674848244',
            platform: 'taobao',
            html: pdpHtml,
        });
        expect(pdpFromHtml).not.toBeNull();
        expect(pdpFromHtml?.itemId).toBe('681674848244');
        expect(pdpFromHtml?.title).toContain('AirPods Pro2保护套');
        expect(pdpFromHtml?.price).toBe(15.8);
        expect(pdpFromHtml?.originalPrice).toBe(25.8);
        expect(pdpFromHtml?.shopId).toBe('546420755');
        expect(pdpFromHtml?.shopName).toBe('数码配件严选店');
        expect(pdpFromHtml?.categoryPath).toBe('3C数码配件 > 蓝牙耳机保护套');
        expect(pdpFromHtml?.descriptionImages?.length).toBe(2);
        // v1.2: review variant labels are no longer emitted as fake SKUs (they have no own price/stock)
        expect(pdpFromHtml?.skus?.length).toBe(0);
        expect(Object.keys(pdpFromHtml?.attributes ?? {})).toContain('颜色分类');

        // 2. Product parsing from intercepted MTOP payload fixture
        const pdpFromMtop = parsePlaywrightProductCapture({
            itemId: '681674848244',
            platform: 'taobao',
            html: '<html></html>',
            interceptedMtopPayloads: [mtopPayload],
        });
        expect(pdpFromMtop).not.toBeNull();
        expect(pdpFromMtop?.price).toBe(15.8);
        expect(pdpFromMtop?.salesCount).toBe(1000);
        expect(pdpFromMtop?.attributes?.['材质']).toBe('液态硅胶');

        // 3. Search parsing from SSR ICE HTML fixture
        const searchCaptured = parsePlaywrightSearchCapture({ html: searchHtml });
        expect(searchCaptured.items.length).toBe(2);
        expect(searchCaptured.items[0]?.itemId).toBe('681674848244');
        expect(searchCaptured.items[0]?.itemIdStr).toBe('t09dA0K5v06V3B1c4iI1F0T6-GI1v4m6G7S8fG36');
        expect(searchCaptured.items[0]?.price).toBe(15.8);
        expect(searchCaptured.items[0]?.brand).toBe('Apple/苹果');

        // 4. Shop parsing from SSR ICE HTML fixture
        const shopCaptured = parsePlaywrightShopCapture({
            shopUrl: 'https://shop546420755.taobao.com',
            shopId: '546420755',
            html: shopHtml,
        });
        expect(shopCaptured).not.toBeNull();
        expect(shopCaptured?.shopInfo.shopName).toBe('数码配件严选店');
        expect(shopCaptured?.items.length).toBe(2);
        expect(shopCaptured?.items[0]?.itemId).toBe('681674848244');
    });

    it('emits clear blocked-run status message, dataset errorReason guidance, and KV note while charging 0 product events when everything is blocked', async () => {
        const guidance = buildBlockedRunGuidance({
            proxyCountry: 'CN',
            hasCustomCookies: false,
            blockRatePercent: 100,
            lastErrorReason: 'MTOP anti-bot block: RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!',
        });
        expect(guidance.note).toContain('RGV587_ERROR');
        expect(guidance.note).toContain('No product events were charged');
        expect(guidance.note).toContain('proxyCountry');
        expect(guidance.note).toContain('taobaoCookies');
        expect(guidance.troubleshootingSteps.length).toBeGreaterThanOrEqual(3);

        const failSpy = vi.spyOn(Actor, 'fail').mockResolvedValue(undefined);
        const statusSpy = vi.spyOn(Actor, 'setStatusMessage').mockResolvedValue(undefined);
        const emittedRows: unknown[] = [];

        try {
            const blockedClient = new TaobaoH5Client({
                enableSessionWarmup: false,
                maxRetries: 1,
                baseBackoffMs: 1,
                requestDelayMs: 0,
                customFetch: async () => ({
                    statusCode: 200,
                    headers: {},
                    body: 'mtopjsonp1({"ret":["RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!"],"data":{}})',
                }),
            });

            const { summary, debugProbe } = await runTaobaoScraper(
                {
                    itemIds: ['999999999991'],
                    includeDetails: true,
                    translateToEnglish: false,
                    enableSessionWarmup: false,
                    enablePlaywrightFallback: false,
                    proxyCountry: 'CN',
                    requestDelayMs: 0,
                },
                {
                    h5Client: blockedClient,
                    onRecordEmitted: async (rec) => {
                        emittedRows.push(rec);
                    },
                },
            );

            expect(summary.countsByStatus.failed).toBe(1);
            expect(summary.countsByStatus.ok).toBe(0);
            expect(summary.billing.eventsCharged['listing']).toBe(0);
            expect(summary.billing.eventsCharged['product-detail']).toBe(0);
            expect(summary.billing.eventsCharged['final-price']).toBe(0);
            expect(summary.blockedRunNote).toContain('No product events were charged');
            expect(summary.blockedRunNote).toContain('taobaoCookies');
            expect(summary.troubleshootingAdvice?.length).toBeGreaterThanOrEqual(3);
            expect(debugProbe?.totalRequestsRecorded).toBeGreaterThan(0);
            expect(statusSpy).toHaveBeenCalled();
            expect(failSpy).toHaveBeenCalled();

            const failedRow = emittedRows[0] as { status: string; errorReason: string };
            expect(failedRow.status).toBe('failed');
            expect(failedRow.errorReason).toContain('Try another proxyCountry');
            expect(failedRow.errorReason).toContain('taobaoCookies');
        } finally {
            failSpy.mockRestore();
            statusSpy.mockRestore();
        }
    });

    it('validates .actor/actor.json, .actor/input_schema.json, .actor/dataset_schema.json, and .actor/pay_per_event.json', async () => {
        const actorJson = JSON.parse(await fs.readFile(path.resolve('.actor/actor.json'), 'utf8')) as {
            version: string;
            name: string;
        };
        expect(actorJson.name).toBe('taobao-tmall-scraper');
        expect(actorJson.version).toBe('1.2');

        const inputSchema = JSON.parse(await fs.readFile(path.resolve('.actor/input_schema.json'), 'utf8')) as {
            schemaVersion: number;
            properties: Record<string, { type?: string; isSecret?: boolean; default?: unknown; enum?: string[] }>;
        };
        expect(inputSchema.schemaVersion).toBe(1);
        expect(inputSchema.properties.proxyCountry?.default).toBe('CN');
        expect(inputSchema.properties.proxyCountry?.enum).toContain('CN');
        expect(inputSchema.properties.proxyCountry?.enum).toContain('HK');
        expect(inputSchema.properties.proxyCountry?.enum).toContain('TW');
        expect(inputSchema.properties.proxyCountry?.enum).toContain('SG');
        expect(inputSchema.properties.enableSessionWarmup?.type).toBe('boolean');
        expect(inputSchema.properties.enableSessionWarmup?.default).toBe(true);
        expect(inputSchema.properties.enablePlaywrightFallback?.type).toBe('boolean');
        expect(inputSchema.properties.enablePlaywrightFallback?.default).toBe(true);
        expect(inputSchema.properties.taobaoCookies?.isSecret).toBe(true);
        expect(inputSchema.properties.cookie?.isSecret).toBe(true);

        const datasetSchema = JSON.parse(await fs.readFile(path.resolve('.actor/dataset_schema.json'), 'utf8')) as {
            actorSpecification: number;
            fields: { properties: Record<string, unknown> };
            views: Record<string, unknown>;
        };
        expect(datasetSchema.actorSpecification).toBe(1);
        expect(datasetSchema.fields.properties.itemId).toBeDefined();
        expect(datasetSchema.fields.properties.finalPrice).toBeDefined();
        expect(datasetSchema.views.overview).toBeDefined();

        const ppeSchema = JSON.parse(await fs.readFile(path.resolve('.actor/pay_per_event.json'), 'utf8')) as {
            events: Record<string, { eventPriceUsd: number }>;
        };
        expect(Object.keys(ppeSchema.events)).toEqual([
            'actor-start',
            'listing',
            'product-detail',
            'final-price',
        ]);
        expect(ppeSchema.events['actor-start']?.eventPriceUsd).toBe(0.001);
        expect(ppeSchema.events['listing']?.eventPriceUsd).toBe(0.0015);
        expect(ppeSchema.events['product-detail']?.eventPriceUsd).toBe(0.0035);
        expect(ppeSchema.events['final-price']?.eventPriceUsd).toBe(0.005);
    });
});


describe('v1.3 Regressions: deadline-aware circuit breaker and platform start fee', () => {
    it('trips immediately instead of sleeping when the run deadline leaves no time for a cooldown', async () => {
        const cb = new CircuitBreaker({ threshold: 2, pauseDurationMs: 60_000 });
        cb.setDeadline(Date.now() + 10_000);
        const t0 = Date.now();
        await cb.recordBlock('block_1');
        await cb.recordBlock('block_2');
        expect(Date.now() - t0).toBeLessThan(1_000);
        expect(cb.isTripped()).toBe(true);
        expect(cb.getStats().pausedCycles).toBe(0);
    });

    it('caps the cooldown pause so it ends at least 30s before the deadline', async () => {
        const cb = new CircuitBreaker({ threshold: 1, pauseDurationMs: 60_000 });
        cb.setDeadline(Date.now() + 30_000 + 5_500);
        const t0 = Date.now();
        await cb.recordBlock('block_1');
        expect(Date.now() - t0).toBeGreaterThanOrEqual(4_000);
        expect(Date.now() - t0).toBeLessThan(7_000);
        expect(cb.isTripped()).toBe(false);
        expect(cb.getStats().pausedCycles).toBe(1);
    }, 15_000);

    it('records the platform apify-actor-start fee per GB without calling Actor.charge', () => {
        const prev = process.env.ACTOR_MEMORY_MBYTES;
        process.env.ACTOR_MEMORY_MBYTES = '2048';
        const spy = vi.spyOn(Actor, 'charge');
        try {
            const billing = new BillingManager();
            billing.recordPlatformStartFee();
            expect(spy).not.toHaveBeenCalled();
            expect(billing.getSummary().eventsCharged['actor-start']).toBe(2);
            expect(billing.getSummary().estimatedCostUsd).toBeCloseTo(0.002, 6);
        } finally {
            spy.mockRestore();
            if (prev === undefined) delete process.env.ACTOR_MEMORY_MBYTES;
            else process.env.ACTOR_MEMORY_MBYTES = prev;
        }
    });
});
