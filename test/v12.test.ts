import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Actor } from 'apify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrencyService } from '../src/currency.js';
import { TaobaoH5Client } from '../src/h5Client.js';
import { runTaobaoScraper } from '../src/main.js';
import { MonitoringService } from '../src/monitoring.js';
import { assembleProductOutput, computePriceRange, isPlaceholderPrice, sanitizePlaceholderPrices } from '../src/pipeline.js';
import { parsePlaywrightProductCapture } from '../src/playwrightFallback.js';
import { parseSeoPdpApiData, parseWorldTaobaoPdpHtml } from '../src/sources/productDetailSource.js';
import { parseFreeGoogleTranslateBody, TranslatorService } from '../src/translator.js';
import type { DataSourceResult, PartialProductData, ProductOutput } from '../src/types.js';

const disabledTranslator = () => new TranslatorService({ enabled: false, persistToStore: false });
const usdCurrency = () =>
    new CurrencyService('USD', {
        customFetcher: async () => ({ base: 'CNY', date: '2026-11-22', rates: { CNY: 1, USD: 0.14 }, source: 'mock' }),
    });

const seoInner = {
    normalItemResponse: {
        item: {
            itemId: 623613723417,
            title: '机械键盘 青轴 87键',
            images: ['//img.alicdn.com/a.jpg', '//img.alicdn.com/b.jpg'],
            seoItemType: 'taobao',
            location: '广东深圳',
        },
        itemPrice: { originalPrice: '199.00', promotionPrice: '159.00-189.00' },
        seller: { shopId: 123456, shopName: '键盘小店' },
        freeShipping: true,
    },
    skuBase: {
        props: [{ pid: '1', name: '颜色', values: [{ vid: '11', name: '黑' }, { vid: '12', name: '白' }] }],
        skus: [
            { skuId: '9001', propPath: '1:11' },
            { skuId: '9002', propPath: '1:12' },
        ],
    },
    skuCore: {
        sku2info: {
            '9001': { quantity: 5, price: { priceText: '159.00' } },
            '9002': { quantity: 0, price: { priceText: '189.00' } },
        },
    },
};

describe('v1.2 fixes', () => {
    let tempStorageDir = '';
    const prevStorageEnv = process.env.APIFY_LOCAL_STORAGE_DIR;
    const prevCrawleeEnv = process.env.CRAWLEE_STORAGE_DIR;
    const prevTimeoutAt = process.env.ACTOR_TIMEOUT_AT;

    beforeEach(async () => {
        tempStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taobao-v12-'));
        process.env.APIFY_LOCAL_STORAGE_DIR = tempStorageDir;
        process.env.CRAWLEE_STORAGE_DIR = tempStorageDir;
    });

    afterEach(async () => {
        if (prevStorageEnv === undefined) delete process.env.APIFY_LOCAL_STORAGE_DIR;
        else process.env.APIFY_LOCAL_STORAGE_DIR = prevStorageEnv;
        if (prevCrawleeEnv === undefined) delete process.env.CRAWLEE_STORAGE_DIR;
        else process.env.CRAWLEE_STORAGE_DIR = prevCrawleeEnv;
        if (prevTimeoutAt === undefined) delete process.env.ACTOR_TIMEOUT_AT;
        else process.env.ACTOR_TIMEOUT_AT = prevTimeoutAt;
        if (tempStorageDir) await fs.rm(tempStorageDir, { recursive: true, force: true }).catch(() => undefined);
    });

    it('Fix 3: rejects 9999/99999 placeholder prices, falls back to a real price, and flags priceWarning', async () => {
        expect(isPlaceholderPrice(9999)).toBe(true);
        expect(isPlaceholderPrice(99999)).toBe(true);
        expect(isPlaceholderPrice(999999)).toBe(true);
        expect(isPlaceholderPrice(9998)).toBe(false);
        expect(isPlaceholderPrice(199)).toBe(false);

        const onlyPlaceholder = sanitizePlaceholderPrices({ itemId: '981046147710', title: 't', price: 9999, originalPrice: 99999 });
        expect(onlyPlaceholder.partial.price).toBeNull();
        expect(onlyPlaceholder.partial.originalPrice).toBeNull();
        expect(onlyPlaceholder.priceWarning).toContain('9999');
        expect(onlyPlaceholder.priceWarning).toContain('No real price');

        const withSku = sanitizePlaceholderPrices({
            itemId: '1019865884154',
            title: 't',
            price: 99999,
            skus: [
                { skuId: 'a', props: 'x', price: 99999, originalPrice: null, stock: 1, image: null },
                { skuId: 'b', props: 'y', price: 128, originalPrice: null, stock: 1, image: null },
            ],
        });
        expect(withSku.partial.price).toBe(128);
        expect(withSku.partial.skus?.[0]?.price).toBeNull();

        const row = await assembleProductOutput({
            partial: { itemId: '981046147710', title: '测试商品', price: 9999, url: 'https://item.taobao.com/item.htm?id=981046147710' },
            translator: disabledTranslator(),
            currencyService: usdCurrency(),
            selectedAgents: [],
            includeShopInfo: true,
        });
        expect(row.price).toBeNull();
        expect(row.priceWarning).toContain('placeholder');
        expect(row.status).toBe('partial');
    });

    it('Fix 3: currency is always CNY, converted values carry convertedCurrency, and minPrice/maxPrice span listing + SKU prices', async () => {
        const currency = usdCurrency();
        await currency.init();
        const row = await assembleProductOutput({
            partial: {
                itemId: '1',
                title: '商品',
                price: 100,
                originalPrice: 150,
                skus: [
                    { skuId: 's1', props: '颜色: 黑', price: 100, originalPrice: 150, stock: 3, image: null },
                    { skuId: 's2', props: '颜色: 白', price: 120, originalPrice: 150, stock: 0, image: null },
                ],
            },
            translator: disabledTranslator(),
            currencyService: currency,
            selectedAgents: [],
            includeShopInfo: true,
        });
        expect(row.currency).toBe('CNY');
        expect(row.convertedCurrency).toBe('USD');
        expect(row.priceConverted).toBe(14);
        expect(row.minPrice).toBe(100);
        expect(row.maxPrice).toBe(120);
        expect(computePriceRange({ itemId: 'x', price: null })).toEqual({ minPrice: null, maxPrice: null });
    });

    it('Fix 2: SEO PDP API payload yields real SKUs with price+stock, all images, shipping, and no 默认规格 placeholder', () => {
        const parsed = parseSeoPdpApiData('623613723417', { result: JSON.stringify(seoInner) }, 'taobao');
        expect(parsed?.title).toBe('机械键盘 青轴 87键');
        expect(parsed?.detailSource).toBe('seo_pdp_api');
        expect(parsed?.images).toHaveLength(2);
        expect(parsed?.skus).toHaveLength(2);
        expect(parsed?.skus?.map((s) => s.price)).toEqual([159, 189]);
        expect(parsed?.skus?.map((s) => s.stock)).toEqual([5, 0]);
        expect(parsed?.skus?.some((s) => s.props.includes('默认规格'))).toBe(false);
        expect(parsed?.maxPrice).toBe(189);
        expect(parsed?.shippingFee).toBe(0);

        // Also accepted when captured by the browser fallback
        const fromBrowser = parsePlaywrightProductCapture({
            itemId: '623613723417',
            html: '<html></html>',
            interceptedMtopBodies: [
                `mtopjsonp3(${JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { result: JSON.stringify(seoInner) } })})`,
            ],
        });
        expect(fromBrowser?.skus).toHaveLength(2);
    });

    it('Fix 2: world.taobao.com SSR parse no longer invents SKUs from review labels or a 默认规格 placeholder', async () => {
        const html = await fs.readFile(path.resolve('test/fixtures/world_taobao_pdp_ice.html'), 'utf8');
        const parsed = parseWorldTaobaoPdpHtml('681674848244', html, 'https://world.taobao.com/item/abc.htm');
        expect(parsed?.skus).toEqual([]);
        expect(parsed?.detailSource).toBe('world_ssr');
        expect(parsed?.minPrice).toBe(15.8);
        expect(parsed?.maxPrice).toBe(25.8);
    });

    it('Fix 4: parses both free Google translate response shapes', () => {
        expect(parseFreeGoogleTranslateBody('[[["Mechanical keyboard","机械键盘",null,null,10]],null,"zh-CN"]')).toBe('Mechanical keyboard');
        expect(parseFreeGoogleTranslateBody('["a\\nb"]')).toBe('a\nb');
        expect(parseFreeGoogleTranslateBody('[["mechanical keyboard","zh-CN"]]')).toBe('mechanical keyboard');
        expect(parseFreeGoogleTranslateBody('<html>Sorry</html>')).toBeNull();
    });

    it('Fix 1 + 6: fast-fail MTOP (1 attempt, overseas host, TW proxy) never trips the HTML circuit breaker and records the real proxy country', async () => {
        const urls: string[] = [];
        const countries: Array<string | undefined> = [];
        const client = new TaobaoH5Client({
            enableSessionWarmup: false,
            requestDelayMs: 0,
            baseBackoffMs: 1,
            proxyCountry: 'CN',
            getProxyUrl: async (_sid, country) => {
                countries.push(country);
                return `http://proxy.local:8000?country=${country}`;
            },
            customFetch: async (url) => {
                urls.push(url);
                return { statusCode: 200, headers: {}, body: 'mtopjsonp1({"ret":["RGV587_ERROR::SM::blocked"],"data":{}})' };
            },
        });
        for (let i = 0; i < 6; i++) {
            const res = await client.requestMtop({
                api: 'mtop.ovs.traffic.landing.seopdp.querySeoPdpPage',
                host: 'h5api-intl.m.taobao.com',
                countryOverride: 'TW',
                maxAttempts: 1,
                skipBreaker: true,
                data: { itemId: '1' },
            });
            expect(res.ok).toBe(false);
            expect(res.blocked).toBe(true);
        }
        expect(urls).toHaveLength(6);
        expect(urls[0]).toContain('h5api-intl.m.taobao.com');
        expect(countries.every((c) => c === 'TW')).toBe(true);
        expect(client.circuitBreaker.isTripped()).toBe(false);
        expect(client.circuitBreaker.getStats().totalBlocks).toBe(0);
        expect(client.isMtopFastFailExhausted()).toBe(true);
        expect(client.getProxyCountriesUsed()).toEqual({ TW: 6 });
        expect(client.getPrimaryProxyCountryUsed()).toBe('TW');
    });

    it('Fix 1: a hanging product emits an uncharged "Timed out" failed row, other items still finish, and RUN_SUMMARY is written', async () => {
        const failSpy = vi.spyOn(Actor, 'fail').mockResolvedValue(undefined);
        const emitted: ProductOutput[] = [];
        try {
            const detailSource = {
                name: 'FakeDetail',
                fetchProductDetail: async (itemId: string): Promise<DataSourceResult<PartialProductData>> => {
                    if (itemId === '1111111') return new Promise(() => undefined); // never resolves
                    return { ok: true, data: { itemId, title: '正常商品', price: 50, isDetailFetched: true } };
                },
            };
            const { summary } = await runTaobaoScraper(
                { itemIds: ['1111111', '2222222'], translateToEnglish: false, proxyConfiguration: { useApifyProxy: false } },
                {
                    h5Client: new TaobaoH5Client({ requestDelayMs: 0, customFetch: async () => ({ statusCode: 404, headers: {}, body: '' }) }),
                    detailSource: detailSource as never,
                    translator: disabledTranslator(),
                    currencyService: usdCurrency(),
                    monitoringService: new MonitoringService(false),
                    perItemTimeoutMs: 300,
                    onRecordEmitted: async (r) => {
                        emitted.push(r);
                    },
                },
            );
            const hung = emitted.find((r) => r.itemId === '1111111');
            expect(hung?.status).toBe('failed');
            expect(hung?.errorReason).toContain('Timed out');
            expect(emitted.find((r) => r.itemId === '2222222')?.status).toBe('ok');
            expect(summary.billing.eventsCharged['product-detail']).toBe(1);
            // Fix 5: products were returned, so no blocked-run note and no false "nothing charged" text
            expect(summary.blockedRunNote).toBeNull();
            expect(summary.blockWarnings?.[0]).toContain('never charged');
            expect(summary.blockWarnings?.[0]).toContain('charged normally');
            const stored = await Actor.getValue<{ recordsEmitted: number }>('RUN_SUMMARY');
            expect(stored?.recordsEmitted).toBe(2);
            expect(await Actor.getValue('BLOCKED_RUN_NOTE')).toBeNull();
            expect(failSpy).not.toHaveBeenCalled();
        } finally {
            failSpy.mockRestore();
        }
    });

    it('Fix 1: near the run timeout, remaining items get an uncharged "Not processed" row instead of vanishing', async () => {
        const failSpy = vi.spyOn(Actor, 'fail').mockResolvedValue(undefined);
        const emitted: ProductOutput[] = [];
        process.env.ACTOR_TIMEOUT_AT = new Date(Date.now() + 30_000).toISOString();
        try {
            const { summary } = await runTaobaoScraper(
                { itemIds: ['3333333'], translateToEnglish: false, proxyConfiguration: { useApifyProxy: false } },
                {
                    h5Client: new TaobaoH5Client({ requestDelayMs: 0, customFetch: async () => ({ statusCode: 404, headers: {}, body: '' }) }),
                    translator: disabledTranslator(),
                    currencyService: usdCurrency(),
                    monitoringService: new MonitoringService(false),
                    onRecordEmitted: async (r) => {
                        emitted.push(r);
                    },
                },
            );
            expect(emitted[0]?.status).toBe('failed');
            expect(emitted[0]?.errorReason).toContain('Not processed');
            expect(summary.stoppedEarlyReason).toContain('timeout');
            expect(summary.billing.eventsCharged['product-detail']).toBe(0);
        } finally {
            failSpy.mockRestore();
        }
    });
});
