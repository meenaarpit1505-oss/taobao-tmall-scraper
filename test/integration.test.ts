import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Actor } from 'apify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingManager } from '../src/billing.js';
import { CurrencyService } from '../src/currency.js';
import { TaobaoH5Client } from '../src/h5Client.js';
import { runTaobaoScraper } from '../src/main.js';
import { MonitoringService } from '../src/monitoring.js';
import { LayeredProductDetailSource } from '../src/sources/productDetailSource.js';
import { LayeredSearchListingSource } from '../src/sources/searchSource.js';
import { LayeredShopCatalogueSource } from '../src/sources/shopSource.js';
import { TranslatorService } from '../src/translator.js';
import type { ProductOutput } from '../src/types.js';

function createTestDependencies(customFetch: ConstructorParameters<typeof TaobaoH5Client>[0]['customFetch']) {
    const h5Client = new TaobaoH5Client({
        requestDelayMs: 0,
        baseBackoffMs: 5,
        customFetch,
    });
    const detailSource = new LayeredProductDetailSource(h5Client);
    const searchSource = new LayeredSearchListingSource(h5Client);
    const shopSource = new LayeredShopCatalogueSource(h5Client);
    const mockTranslateToAscii = (text: string) =>
        `[EN] ${text.replace(/[\u4e00-\u9fff]/g, (ch) => `U${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`;
    const translator = new TranslatorService({
        enabled: true,
        provider: {
            name: 'MockDeterministicTranslator',
            translateText: async (text: string) => mockTranslateToAscii(text),
            translateBatch: async (texts: string[]) => texts.map(mockTranslateToAscii),
        },
    });
    const currencyService = new CurrencyService('USD', {
        customFetcher: async () => ({
            base: 'CNY',
            date: '2026-11-18',
            rates: { CNY: 1, USD: 0.14 },
            source: 'mock',
        }),
    });

    return {
        h5Client,
        detailSource,
        searchSource,
        shopSource,
        translator,
        currencyService,
    };
}

describe('Integration Tests — All Modes (Product, Short Link, Search, Shop, Monitoring & Billing)', () => {
    let tempStorageDir = '';
    const prevStorageEnv = process.env.APIFY_LOCAL_STORAGE_DIR;
    const prevCrawleeEnv = process.env.CRAWLEE_STORAGE_DIR;

    beforeEach(async () => {
        tempStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taobao-actor-test-'));
        process.env.APIFY_LOCAL_STORAGE_DIR = tempStorageDir;
        process.env.CRAWLEE_STORAGE_DIR = tempStorageDir;
    });

    afterEach(async () => {
        if (prevStorageEnv === undefined) delete process.env.APIFY_LOCAL_STORAGE_DIR;
        else process.env.APIFY_LOCAL_STORAGE_DIR = prevStorageEnv;
        if (prevCrawleeEnv === undefined) delete process.env.CRAWLEE_STORAGE_DIR;
        else process.env.CRAWLEE_STORAGE_DIR = prevCrawleeEnv;

        if (tempStorageDir) {
            await fs.rm(tempStorageDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('CRITICAL #1 Regression: runs the real request path (real TaobaoH5Client + gotScraping network layer) with a proxyConfiguration mock without crashing on session.id', async () => {
        const proxyRequests: string[] = [];
        const server = http.createServer((req, res) => {
            const reqUrl = req.url ?? '';
            proxyRequests.push(reqUrl);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            if (reqUrl.includes('m.tb.cn')) {
                res.end(`<script>var url = 'http://shop888999.taobao.com';</script>`);
                return;
            }
            res.end(`
                <html>
                    <head><title>真实代理测试店铺 - 淘宝网</title></head>
                    <body>
                        <div class="slogo-shopname">真实代理测试店铺</div>
                        <div class="J_TItems">
                            <dl class="item" data-id="98765432101">
                                <a class="item-name" href="//item.taobao.com/item.htm?id=98765432101">真实网络层代理商品</a>
                                <span class="c-price">66.00</span>
                                <span class="sale-num">100+</span>
                            </dl>
                        </div>
                    </body>
                </html>
            `);
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const addr = server.address() as { port: number };
        const localProxyUrl = `http://127.0.0.1:${addr.port}`;

        const sessionIdsSeen: Array<string | undefined> = [];
        const proxyConfigMock = {
            newUrl: vi.fn(async (sessionId?: string) => {
                sessionIdsSeen.push(sessionId);
                return localProxyUrl;
            }),
        };

        const createProxySpy = vi
            .spyOn(Actor, 'createProxyConfiguration')
            .mockResolvedValue(proxyConfigMock as unknown as Awaited<ReturnType<typeof Actor.createProxyConfiguration>>);

        try {
            const emitted: ProductOutput[] = [];
            const { summary } = await runTaobaoScraper(
                {
                    startUrls: ['http://m.tb.cn/h.5realProxyPath'],
                    includeDetails: false,
                    translateToEnglish: false,
                    proxyConfiguration: {
                        useApifyProxy: true,
                        apifyProxyCountry: 'US',
                    },
                },
                {
                    monitoringService: new MonitoringService(false, undefined, { persistToStore: false }),
                    currencyService: new CurrencyService('USD', {
                        customFetcher: async () => ({
                            base: 'CNY',
                            date: '2026-11-18',
                            rates: { CNY: 1, USD: 0.14 },
                            source: 'live',
                        }),
                    }),
                    onRecordEmitted: async (r) => {
                        emitted.push(r);
                    },
                },
            );

            expect(proxyConfigMock.newUrl).toHaveBeenCalled();
            expect(sessionIdsSeen[0]).toMatch(/^tb_sess_/);
            expect(proxyRequests.length).toBeGreaterThanOrEqual(2);
            expect(summary.countsByStatus.ok).toBe(1);
            const product = emitted.find((r) => r.recordType === 'product');
            expect(product?.itemId).toBe('98765432101');
            expect(product?.title).toBe('真实网络层代理商品');
        } finally {
            createProxySpy.mockRestore();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('Mode 1 (Product / Item ID Mode): scrapes full H5 details, SKUs, real final price, and falls back to world.taobao.com when ID 404s on H5', async () => {
        const deps = createTestDependencies(async (url) => {
            // Item 1111111111: succeeds via MTOP H5 detail API with SKUs and promotions
            if (url.includes('mtop.taobao.pcdetail.data.get') && url.includes('1111111111')) {
                return {
                    statusCode: 200,
                    headers: {},
                    body: JSON.stringify({
                        ret: ['SUCCESS::调用成功'],
                        data: {
                            item: {
                                title: '旗舰降噪蓝牙耳机',
                                brand: 'SoundMax',
                                categoryPath: '数码/耳机',
                                images: ['//img.alicdn.com/img1.jpg', '//img.alicdn.com/img2.jpg'],
                                vagueSellCount: '2.5万+',
                            },
                            price: {
                                price: { priceText: '299.00' },
                                extraPrices: [{ priceText: '399.00' }],
                                shopProm: [{ title: '店铺活动', content: ['满200减30'] }],
                            },
                            resource: {
                                coupon: {
                                    couponList: [{ title: '领券减20元' }],
                                },
                            },
                            skuBase: {
                                props: [
                                    {
                                        pid: '1627207',
                                        name: '颜色分类',
                                        values: [
                                            { vid: '101', name: '曜石黑', image: '//img.alicdn.com/sku_black.jpg' },
                                            { vid: '102', name: '月光白', image: '//img.alicdn.com/sku_white.jpg' },
                                        ],
                                    },
                                ],
                                skus: [
                                    { skuId: '5001', propPath: '1627207:101' },
                                    { skuId: '5002', propPath: '1627207:102' },
                                ],
                            },
                            skuCore: {
                                sku2info: {
                                    '0': { quantity: 200, price: { priceText: '299.00' } },
                                    '5001': { quantity: 120, price: { priceText: '299.00' } },
                                    '5002': { quantity: 80, price: { priceText: '319.00' } },
                                },
                            },
                            delivery: {
                                from: '广东深圳',
                                postage: '快递: 免运费',
                            },
                            seller: {
                                shopId: '998877',
                                shopName: 'SoundMax官方旗舰店',
                                tmall: true,
                                evaluates: [
                                    { title: '宝贝描述', score: '4.9' },
                                    { title: '卖家服务', score: '4.8' },
                                    { title: '物流服务', score: '4.9' },
                                ],
                                creditLevel: '20',
                                starts: '6年老店',
                                allItemCount: '158',
                            },
                            props: {
                                propsList: [{ name: '连接方式', value: '蓝牙5.4' }],
                            },
                        },
                    }),
                };
            }

            // Item 2222222222: 404s on MTOP H5 APIs, succeeds via world.taobao.com fallback URL
            if (url.includes('2222222222') && url.includes('h5api.m.')) {
                return {
                    statusCode: 200,
                    headers: {},
                    body: JSON.stringify({ ret: ['FAIL_BIZ_ITEM_NOT_FOUND::商品不存在'] }),
                };
            }
            if (url === 'https://world.taobao.com/item/2222222222.htm') {
                return {
                    statusCode: 200,
                    headers: {},
                    body: `
                        <html>
                            <head><title>复古机械键盘 - 淘宝网</title></head>
                            <body>
                                <h1 class="tb-main-title">复古机械键盘</h1>
                                <span class="tb-rmb-num">199.00</span>
                                <ul id="J_UlThumb"><li><img src="//img.alicdn.com/kb.jpg" /></li></ul>
                                <ul id="J_AttrUL"><li>品牌: KeyPro</li></ul>
                                <div class="tb-shop-name"><a href="//shop555.taobao.com">KeyPro外设店</a></div>
                            </body>
                        </html>
                    `,
                };
            }

            return { statusCode: 404, headers: {}, body: 'Not Found' };
        });

        const emitted: ProductOutput[] = [];
        const { summary } = await runTaobaoScraper(
            {
                itemIds: ['1111111111', '2222222222'],
                currency: 'USD',
                translateToEnglish: true,
                proxyConfiguration: { useApifyProxy: false },
            },
            {
                ...deps,
                monitoringService: new MonitoringService(false),
                onRecordEmitted: async (r) => {
                    emitted.push(r);
                },
            },
        );

        expect(summary.countsByStatus.ok).toBe(2);
        expect(emitted).toHaveLength(2);

        const item1 = emitted.find((i) => i.itemId === '1111111111')!;
        expect(item1.platform).toBe('tmall');
        expect(item1.title).toBe('旗舰降噪蓝牙耳机');
        expect(item1.titleEn).toMatch(/^\[EN\] /);
        expect(item1.translationStatus).toBe('ok');
        expect(item1.salesCount).toBe(25000);
        // Single best deal at 299 is 满200减30 (30 off) -> 269
        expect(item1.finalPrice).toBe(269);
        expect(item1.priceConverted).toBe(37.66); // 269 * 0.14
        expect(item1.skus).toHaveLength(2);
        expect(item1.skus[0].finalPrice).toBe(269);
        expect(item1.skus[1].finalPrice).toBe(289);
        expect(item1.sellerScores).toEqual({ description: 4.9, service: 4.8, logistics: 4.9 });
        expect(item1.agentLinks.superbuy).toContain('superbuy.com');

        const item2 = emitted.find((i) => i.itemId === '2222222222')!;
        expect(item2.title).toBe('复古机械键盘');
        expect(item2.price).toBe(199);
        expect(item2.brand).toBe('KeyPro');
    });

    it('Mode 2 (Short Link Mode): resolves m.tb.cn embedded JS redirect to product detail', async () => {
        const deps = createTestDependencies(async (url) => {
            if (url.includes('m.tb.cn')) {
                return {
                    statusCode: 200,
                    headers: {},
                    body: `<script>var url = 'https://item.taobao.com/item.htm?id=3333333333';</script>`,
                };
            }
            if (url.includes('3333333333')) {
                return {
                    statusCode: 200,
                    headers: {},
                    body: JSON.stringify({
                        ret: ['SUCCESS::调用成功'],
                        data: {
                            item: { title: '短链测试保温杯', images: ['//img.alicdn.com/cup.jpg'], vagueSellCount: '500+' },
                            price: { price: { priceText: '59.00' } },
                        },
                    }),
                };
            }
            return { statusCode: 404, headers: {}, body: '' };
        });

        const emitted: ProductOutput[] = [];
        await runTaobaoScraper(
            {
                startUrls: ['https://m.tb.cn/h.5shortLinkTest'],
                proxyConfiguration: { useApifyProxy: false },
            },
            {
                ...deps,
                monitoringService: new MonitoringService(false),
                onRecordEmitted: async (r) => {
                    emitted.push(r);
                },
            },
        );

        expect(emitted).toHaveLength(1);
        expect(emitted[0].itemId).toBe('3333333333');
        expect(emitted[0].title).toBe('短链测试保温杯');
        expect(emitted[0].salesCount).toBe(500);
    });

    it('Mode 3 (Search & Category Mode): scrapes world.taobao.com listings with searchFilters', async () => {
        const deps = createTestDependencies(async (url) => {
            if (url.includes('world.taobao.com/search')) {
                const pageConfig = {
                    mods: {
                        itemlist: {
                            data: {
                                auctions: [
                                    {
                                        nid: '4444444441',
                                        raw_title: '天猫无线鼠标A',
                                        view_price: '129.00',
                                        view_sales: '1万+人付款',
                                        item_loc: '广东 广州',
                                        nick: '外设旗舰店',
                                        user_id: '8001',
                                        pic_url: '//img.alicdn.com/m1.jpg',
                                        detail_url: '//detail.tmall.com/item.htm?id=4444444441',
                                        shopcard: { isTmall: true },
                                    },
                                    {
                                        nid: '4444444442',
                                        raw_title: '普通鼠标B',
                                        view_price: '29.00',
                                        view_sales: '100人付款',
                                        item_loc: '浙江 杭州',
                                        nick: '普通配件店',
                                        user_id: '8002',
                                        pic_url: '//img.alicdn.com/m2.jpg',
                                        detail_url: '//item.taobao.com/item.htm?id=4444444442',
                                        shopcard: { isTmall: false },
                                    },
                                ],
                            },
                        },
                    },
                };
                return {
                    statusCode: 200,
                    headers: {},
                    body: `<script>g_page_config = ${JSON.stringify(pageConfig)};</script>`,
                };
            }
            return { statusCode: 404, headers: {}, body: '' };
        });

        const emitted: ProductOutput[] = [];
        await runTaobaoScraper(
            {
                keywords: ['无线鼠标'],
                searchFilters: {
                    tmallOnly: true,
                    minPrice: 50,
                    maxPrice: 200,
                    location: '广州',
                    sort: 'sales',
                },
                includeDetails: false,
                maxItemsPerQuery: 10,
                proxyConfiguration: { useApifyProxy: false },
            },
            {
                ...deps,
                monitoringService: new MonitoringService(false),
                onRecordEmitted: async (r) => {
                    emitted.push(r);
                },
            },
        );

        expect(emitted).toHaveLength(1);
        expect(emitted[0].itemId).toBe('4444444441');
        expect(emitted[0].platform).toBe('tmall');
        expect(emitted[0].salesCount).toBe(10000);
        // Since includeDetails=false, finalPrice is null (never guessed)
        expect(emitted[0].finalPrice).toBeNull();
    });

    it('Mode 4 (Shop Mode): outputs paginated shop products plus a shop row with full catalogue', async () => {
        const deps = createTestDependencies(async (url) => {
            if (url.includes('shop777888.taobao.com')) {
                return {
                    statusCode: 200,
                    headers: {},
                    body: `
                        <html>
                            <head><title>极客数码馆 - 淘宝网</title></head>
                            <body>
                                <div class="slogo-shopname">极客数码馆</div>
                                <div class="shopdsr-item">描述 4.9</div>
                                <div class="shopdsr-item">服务 4.8</div>
                                <div class="shopdsr-item">物流 4.9</div>
                                <div class="J_TItems">
                                    <dl class="item" data-id="5555555551">
                                        <a class="item-name" href="//item.taobao.com/item.htm?id=5555555551">氮化镓充电器65W</a>
                                        <span class="c-price">89.00</span>
                                        <span class="sale-num">1000+</span>
                                        <img src="//img.alicdn.com/c1.jpg" />
                                    </dl>
                                    <dl class="item" data-id="5555555552">
                                        <a class="item-name" href="//item.taobao.com/item.htm?id=5555555552">快充数据线100W</a>
                                        <span class="c-price">19.90</span>
                                        <span class="sale-num">500+</span>
                                        <img src="//img.alicdn.com/c2.jpg" />
                                    </dl>
                                </div>
                            </body>
                        </html>
                    `,
                };
            }
            return { statusCode: 404, headers: {}, body: '' };
        });

        const emitted: ProductOutput[] = [];
        const { summary } = await runTaobaoScraper(
            {
                startUrls: ['https://shop777888.taobao.com'],
                includeDetails: false,
                maxItemsPerQuery: 10,
                proxyConfiguration: { useApifyProxy: false },
            },
            {
                ...deps,
                monitoringService: new MonitoringService(false),
                onRecordEmitted: async (r) => {
                    emitted.push(r);
                },
            },
        );

        expect(summary.shopRecordsEmitted).toBe(1);
        const shopRow = emitted.find((r) => r.recordType === 'shop')!;
        expect(shopRow).toBeDefined();
        expect(shopRow.shopName).toBe('极客数码馆');
        expect(shopRow.shopCatalogueItemIds).toEqual(['5555555551', '5555555552']);

        const productRows = emitted.filter((r) => r.recordType === 'product');
        expect(productRows).toHaveLength(2);
    });

    it('Mode 5 (Monitoring Mode & Billing): emits only new/changed items with previousValues and respects maxChargeUsd', async () => {
        let currentPrice = '150.00';
        const deps = createTestDependencies(async (url) => {
            if (url.includes('6666666661')) {
                return {
                    statusCode: 200,
                    headers: {},
                    body: JSON.stringify({
                        ret: ['SUCCESS::调用成功'],
                        data: {
                            item: { title: '监控商品A', images: ['//img.alicdn.com/a.jpg'] },
                            price: { price: { priceText: currentPrice } },
                        },
                    }),
                };
            }
            return { statusCode: 404, headers: {}, body: '' };
        });

        const sharedMonitoring = new MonitoringService(true, undefined, { persistToStore: false });

        // Run 1: item is 'new'
        const run1Records: ProductOutput[] = [];
        await runTaobaoScraper(
            {
                itemIds: ['6666666661'],
                monitoringMode: true,
                proxyConfiguration: { useApifyProxy: false },
            },
            {
                ...deps,
                monitoringService: sharedMonitoring,
                onRecordEmitted: async (r) => {
                    run1Records.push(r);
                },
            },
        );
        expect(run1Records).toHaveLength(1);
        expect(run1Records[0].changeType).toBe('new');

        // Run 2: same price -> 'unchanged', skipped in monitoringMode
        const run2Records: ProductOutput[] = [];
        await runTaobaoScraper(
            {
                itemIds: ['6666666661'],
                monitoringMode: true,
                proxyConfiguration: { useApifyProxy: false },
            },
            {
                ...deps,
                monitoringService: sharedMonitoring,
                onRecordEmitted: async (r) => {
                    run2Records.push(r);
                },
            },
        );
        expect(run2Records).toHaveLength(0);

        // Run 3: price drops to 120.00 -> 'changed', emitted with previousValues
        currentPrice = '120.00';
        const run3Records: ProductOutput[] = [];
        const billing = new BillingManager({ maxChargeUsd: 1.0 });
        await runTaobaoScraper(
            {
                itemIds: ['6666666661'],
                monitoringMode: true,
                proxyConfiguration: { useApifyProxy: false },
            },
            {
                ...deps,
                monitoringService: sharedMonitoring,
                billingManager: billing,
                onRecordEmitted: async (r) => {
                    run3Records.push(r);
                },
            },
        );
        expect(run3Records).toHaveLength(1);
        expect(run3Records[0].changeType).toBe('changed');
        expect(run3Records[0].previousValues).toMatchObject({ price: 150, finalPrice: 150 });
        expect(billing.getSummary().eventsCharged['product-detail']).toBe(1);
    });

    it('HIGH #5 & #6 Regression: skips optional final-price event when budget only fits product-detail, always pushes charged rows, and only commits monitoring state after push (sharded & keyed per task)', async () => {
        const deps = createTestDependencies(async (url) => {
            if (url.includes('7777777701')) {
                return {
                    statusCode: 200,
                    headers: {},
                    body: JSON.stringify({
                        ret: ['SUCCESS::调用成功'],
                        data: {
                            item: { title: '预算测试商品1', images: ['//img.alicdn.com/b1.jpg'] },
                            price: {
                                price: { priceText: '200.00' },
                                shopProm: [{ title: '店铺活动', content: ['满100减20'] }],
                            },
                        },
                    }),
                };
            }
            if (url.includes('8888888802')) {
                return {
                    statusCode: 200,
                    headers: {},
                    body: JSON.stringify({
                        ret: ['SUCCESS::调用成功'],
                        data: {
                            item: { title: '超出预算商品2', images: ['//img.alicdn.com/b2.jpg'] },
                            price: { price: { priceText: '100.00' } },
                        },
                    }),
                };
            }
            return { statusCode: 404, headers: {}, body: '' };
        });

        // Budget = $0.0080:
        // actor-start ($0.001) + product-detail ($0.0035) = $0.0045 (fits!)
        // Adding final-price ($0.005) would be $0.0095 (exceeds $0.0060!)
        // Item 1 must skip final-price charge, still be pushed, and be recorded in monitoring.
        // Item 2 cannot afford product-detail ($0.0045 + $0.0035 = $0.0080 > $0.0060), so it is NOT pushed and NOT marked seen in monitoring!
        const monitoring = new MonitoringService(true, undefined, {
            persistToStore: false,
            monitoringKey: 'task_budget_test_1',
        });
        expect(monitoring.getScopeKey()).toBe('task_budget_test_1');

        const emitted: ProductOutput[] = [];
        const { summary } = await runTaobaoScraper(
            {
                itemIds: ['7777777701', '8888888802'],
                monitoringMode: true,
                monitoringKey: 'task_budget_test_1',
                maxChargeUsd: 0.006,
                proxyConfiguration: { useApifyProxy: false },
            },
            {
                ...deps,
                monitoringService: monitoring,
                onRecordEmitted: async (r) => {
                    emitted.push(r);
                },
            },
        );

        // Item 1 was charged product-detail ($0.0035) without final-price ($0.005), and was pushed!
        expect(emitted).toHaveLength(1);
        expect(emitted[0].itemId).toBe('7777777701');
        expect(emitted[0].finalPrice).toBeNull();
        expect(summary.billing.eventsCharged['product-detail']).toBe(1);
        expect(summary.billing.eventsCharged['final-price']).toBe(0);

        // Verify Item 2 ('8888888802') was NOT marked as seen in monitoring because it was not pushed
        const evalItem2 = monitoring.evaluate({
            ...emitted[0],
            itemId: '8888888802',
            title: '超出预算商品2',
        });
        expect(evalItem2.product.changeType).toBe('new');
    });

    it('MEDIUM #10, #11, #13, #14 Regression: continues search pagination on raw results when page 1 filters to 0, uses shop /search.htm on page 1 with dedupe, emits uncharged failed rows for bad inputs/queries, and calls Actor.fail when all inputs fail', async () => {
        const requestedUrls: string[] = [];
        const deps = createTestDependencies(async (url) => {
            requestedUrls.push(url);
            // Search page 1: 20 raw items, all Taobao (filtered out by tmallOnly: true), hasNextPage = true
            if (
                url.includes('world.taobao.com/search') &&
                url.includes('page=1') &&
                url.includes(encodeURIComponent('跨页过滤测试'))
            ) {
                const rawAuctions = Array.from({ length: 20 }, (_, idx) => ({
                    nid: `${9100000000 + idx}`,
                    raw_title: `淘宝普通商品_${idx}`,
                    view_price: '50.00',
                    detail_url: `//item.taobao.com/item.htm?id=${9100000000 + idx}`,
                    shopcard: { isTmall: false },
                }));
                return {
                    statusCode: 200,
                    headers: {},
                    body: `<script>g_page_config = ${JSON.stringify({ mods: { itemlist: { data: { auctions: rawAuctions } } } })};</script>`,
                };
            }
            // Search page 2: has a Tmall item that passes filter!
            if (
                url.includes('world.taobao.com/search') &&
                url.includes('page=2') &&
                url.includes(encodeURIComponent('跨页过滤测试'))
            ) {
                return {
                    statusCode: 200,
                    headers: {},
                    body: `<script>g_page_config = ${JSON.stringify({
                        mods: {
                            itemlist: {
                                data: {
                                    auctions: [
                                        {
                                            nid: '9200000001',
                                            raw_title: '天猫精选商品Page2',
                                            view_price: '120.00',
                                            detail_url: '//detail.tmall.com/item.htm?id=9200000001',
                                            shopcard: { isTmall: true },
                                        },
                                    ],
                                },
                            },
                        },
                    })};</script>`,
                };
            }
            // Shop page 1: must request /search.htm?search=y&pageNo=1
            if (url.includes('shop333444.taobao.com/search.htm') && url.includes('pageNo=1')) {
                return {
                    statusCode: 200,
                    headers: {},
                    body: `
                        <html>
                            <body>
                                <div class="slogo-shopname">去重测试店铺</div>
                                <div class="J_TItems">
                                    <dl class="item" data-id="9300000001"><a class="item-name" href="//item.taobao.com/item.htm?id=9300000001">店铺商品1</a><span class="c-price">39.00</span></dl>
                                    <dl class="item" data-id="9300000001"><a class="item-name" href="//item.taobao.com/item.htm?id=9300000001">店铺商品1重复</a><span class="c-price">39.00</span></dl>
                                </div>
                            </body>
                        </html>
                    `,
                };
            }
            return { statusCode: 404, headers: {}, body: 'Not Found' };
        });

        const emitted: ProductOutput[] = [];
        const { summary } = await runTaobaoScraper(
            {
                startUrls: ['https://example.com/unsupported', 'https://shop333444.taobao.com'],
                itemIds: ['invalid_id_xyz'],
                keywords: ['跨页过滤测试'],
                searchFilters: { tmallOnly: true },
                includeDetails: false,
                maxItemsPerQuery: 5,
                proxyConfiguration: { useApifyProxy: false },
            },
            {
                ...deps,
                monitoringService: new MonitoringService(false, undefined, { persistToStore: false }),
                onRecordEmitted: async (r) => {
                    emitted.push(r);
                },
            },
        );

        // Verify shop page 1 used /search.htm?search=y&pageNo=1 and deduped itemId 9300000001
        expect(requestedUrls.some((u) => u.includes('shop333444.taobao.com/search.htm?search=y&pageNo=1'))).toBe(true);
        const shopRow = emitted.find((r) => r.recordType === 'shop')!;
        expect(shopRow.shopCatalogueItemIds).toEqual(['9300000001']);

        // Verify search continued to page 2 despite page 1 filtering down to 0 items
        expect(emitted.some((r) => r.itemId === '9200000001')).toBe(true);

        // Verify invalid URL and invalid itemId produced failed rows and were NOT charged
        const failedRows = emitted.filter((r) => r.status === 'failed');
        expect(failedRows).toHaveLength(2);
        expect(summary.billing.eventsCharged.listing).toBe(2); // Only the 2 valid products (9200000001 and 9300000001)

        // Verify when EVERY input fails (failed search + failed shop), failed rows are pushed and Actor.fail is called
        const failSpy = vi.spyOn(Actor, 'fail').mockResolvedValue(undefined as never);
        const allFailedEmitted: ProductOutput[] = [];
        const { summary: failSummary } = await runTaobaoScraper(
            {
                keywords: ['必败搜索词'],
                startUrls: ['https://shop999999999.taobao.com'],
                includeDetails: false,
                proxyConfiguration: { useApifyProxy: false },
            },
            {
                ...deps,
                monitoringService: new MonitoringService(false, undefined, { persistToStore: false }),
                onRecordEmitted: async (r) => {
                    allFailedEmitted.push(r);
                },
            },
        );
        expect(allFailedEmitted).toHaveLength(2);
        expect(allFailedEmitted.every((r) => r.status === 'failed')).toBe(true);
        // Issue #10 Regression: failed search rows set query to the keyword and itemId to null
        const failedSearchRow = allFailedEmitted.find((r) => r.recordType !== 'shop')!;
        expect(failedSearchRow.itemId).toBeNull();
        expect(failedSearchRow.query).toBe('必败搜索词');
        expect(failSummary.billing.eventsCharged.listing).toBe(0);
        expect(failSpy).toHaveBeenCalledTimes(1);
        failSpy.mockRestore();
    });

    it('Issue #1 Regression: monitoring run does NOT call Actor.fail when items are unchanged and one fails; only calls Actor.fail when every task failed (failedTasks === tasks.length)', async () => {
        const deps = createTestDependencies(async (url) => {
            if (url.includes('8100000001')) {
                return {
                    statusCode: 200,
                    headers: {},
                    body: JSON.stringify({
                        ret: ['SUCCESS::调用成功'],
                        data: {
                            item: { title: '监控未变更商品', images: ['//img.alicdn.com/u1.jpg'] },
                            price: { price: { priceText: '100.00' } },
                        },
                    }),
                };
            }
            // Item 8100000002 fails on all layers
            return { statusCode: 404, headers: {}, body: 'Not Found' };
        });

        const sharedMonitoring = new MonitoringService(true, undefined, { persistToStore: false });

        // Run 1: seed item 8100000001 into monitoring state
        await runTaobaoScraper(
            {
                itemIds: ['8100000001'],
                monitoringMode: true,
                proxyConfiguration: { useApifyProxy: false },
            },
            {
                ...deps,
                monitoringService: sharedMonitoring,
                onRecordEmitted: async () => undefined,
            },
        );

        // Run 2: item 8100000001 is unchanged (skipped) and item 8100000002 fails (1 of 2 tasks failed)
        const failSpy = vi.spyOn(Actor, 'fail').mockResolvedValue(undefined as never);
        try {
            const run2Emitted: ProductOutput[] = [];
            const { summary } = await runTaobaoScraper(
                {
                    itemIds: ['8100000001', '8100000002'],
                    monitoringMode: true,
                    proxyConfiguration: { useApifyProxy: false },
                },
                {
                    ...deps,
                    monitoringService: sharedMonitoring,
                    onRecordEmitted: async (r) => {
                        run2Emitted.push(r);
                    },
                },
            );

            // Unchanged/skipped row is counted as a success; Actor.fail must NOT be called!
            expect(failSpy).not.toHaveBeenCalled();
            expect(summary.monitoringCounts.skippedUnchanged).toBe(1);
            expect(summary.countsByStatus.failed).toBe(1);
            expect(summary.uniqueProductsProcessed).toBe(2);
            expect(summary.successRatePercent).toBe(50);

            // Run 3: every task fails (failedTasks === tasks.length) -> Actor.fail IS called
            await runTaobaoScraper(
                {
                    itemIds: ['8100000002', '8100000003'],
                    monitoringMode: true,
                    proxyConfiguration: { useApifyProxy: false },
                },
                {
                    ...deps,
                    monitoringService: sharedMonitoring,
                    onRecordEmitted: async () => undefined,
                },
            );
            expect(failSpy).toHaveBeenCalledTimes(1);
        } finally {
            failSpy.mockRestore();
        }
    });

    it('Issue #2 Regression: custom proxyUrls receive requests via real Actor.createProxyConfiguration, and on the Apify platform Actor.fail is called if createProxyConfiguration throws or returns undefined', async () => {
        const proxyRequests: string[] = [];
        const server = http.createServer((req, res) => {
            const reqUrl = req.url ?? '';
            proxyRequests.push(reqUrl);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <html>
                    <head><title>自定义代理测试店铺 - 淘宝网</title></head>
                    <body>
                        <div class="slogo-shopname">自定义代理测试店铺</div>
                        <div class="J_TItems">
                            <dl class="item" data-id="98765432199">
                                <a class="item-name" href="//item.taobao.com/item.htm?id=98765432199">自定义proxyUrls商品</a>
                                <span class="c-price">88.00</span>
                            </dl>
                        </div>
                    </body>
                </html>
            `);
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const addr = server.address() as { port: number };
        const customProxyUrl = `http://127.0.0.1:${addr.port}`;

        try {
            // 1. Custom proxyUrls with useApifyProxy: false (using REAL Actor.createProxyConfiguration!)
            const emitted: ProductOutput[] = [];
            const { summary } = await runTaobaoScraper(
                {
                    startUrls: ['http://shop888999.taobao.com'],
                    includeDetails: false,
                    translateToEnglish: false,
                    proxyConfiguration: {
                        useApifyProxy: false,
                        proxyUrls: [customProxyUrl],
                    },
                },
                {
                    monitoringService: new MonitoringService(false, undefined, { persistToStore: false }),
                    currencyService: new CurrencyService('USD', { persistToStore: false }),
                    onRecordEmitted: async (r) => {
                        emitted.push(r);
                    },
                },
            );

            // Custom proxy server must have received the requests!
            expect(proxyRequests.length).toBeGreaterThanOrEqual(1);
            expect(summary.countsByStatus.ok).toBe(1);
            expect(emitted.find((r) => r.recordType === 'product')?.itemId).toBe('98765432199');

            // 2. Fix #4 & #5 Regression: On the Apify platform (Actor.isAtHome() === true), when proxy is disabled or unavailable,
            // fails with "A proxy is required: enable Apify Proxy (RESIDENTIAL) or provide proxyUrls." and does NOT charge actor-start!
            const isAtHomeSpy = vi.spyOn(Actor, 'isAtHome').mockReturnValue(true);
            const failSpy = vi.spyOn(Actor, 'fail').mockResolvedValue(undefined as never);
            const createProxySpy = vi.spyOn(Actor, 'createProxyConfiguration');

            try {
                // 2a. Proxy disabled / returns undefined on platform
                createProxySpy.mockResolvedValueOnce(undefined);
                const { summary: failSummary1 } = await runTaobaoScraper(
                    {
                        keywords: ['test'],
                        proxyConfiguration: { useApifyProxy: false },
                    },
                    {
                        monitoringService: new MonitoringService(false, undefined, { persistToStore: false }),
                        currencyService: new CurrencyService('USD', { persistToStore: false }),
                    },
                );
                expect(failSpy).toHaveBeenCalledTimes(1);
                expect(failSpy.mock.calls[0][0]).toBe(
                    'A proxy is required: enable Apify Proxy (RESIDENTIAL) or provide proxyUrls.',
                );
                // Fix #4: actor-start must NOT be charged when proxy setup fails
                expect(failSummary1.billing.eventsCharged['actor-start']).toBe(0);

                // 2b. Throws error on platform
                createProxySpy.mockRejectedValueOnce(new Error('Invalid proxy group RESIDENTIAL'));
                const { summary: failSummary2 } = await runTaobaoScraper(
                    {
                        keywords: ['test'],
                        proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
                    },
                    {
                        monitoringService: new MonitoringService(false, undefined, { persistToStore: false }),
                        currencyService: new CurrencyService('USD', { persistToStore: false }),
                    },
                );
                expect(failSpy).toHaveBeenCalledTimes(2);
                expect(failSpy.mock.calls[1][0]).toBe(
                    'A proxy is required: enable Apify Proxy (RESIDENTIAL) or provide proxyUrls.',
                );
                // Fix #4: actor-start must NOT be charged when proxy setup throws
                expect(failSummary2.billing.eventsCharged['actor-start']).toBe(0);
            } finally {
                createProxySpy.mockRestore();
                failSpy.mockRestore();
                isAtHomeSpy.mockRestore();
            }
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('LOW Regression: hits ACTOR_MAX_TOTAL_CHARGE_USD spending limit across multiple items in an isolated storage dir and stops cleanly', async () => {
        const prevEnv = process.env.ACTOR_MAX_TOTAL_CHARGE_USD;
        // Budget = $0.009:
        // actor-start ($0.001) + 2 product-detail items ($0.0035 * 2 = $0.007) = $0.008 (fits 2 items, stops before 3rd item!)
        process.env.ACTOR_MAX_TOTAL_CHARGE_USD = '0.009';
        try {
            const deps = createTestDependencies(async (url) => {
                const idMatch = url.match(/950000000(\d)/);
                if (idMatch) {
                    return {
                        statusCode: 200,
                        headers: {},
                        body: JSON.stringify({
                            ret: ['SUCCESS::调用成功'],
                            data: {
                                item: { title: `限额测试商品_${idMatch[1]}`, images: ['//img.alicdn.com/x.jpg'] },
                                price: { price: { priceText: '88.00' } },
                            },
                        }),
                    };
                }
                return { statusCode: 404, headers: {}, body: '' };
            });

            const emitted: ProductOutput[] = [];
            const { summary } = await runTaobaoScraper(
                {
                    itemIds: ['9500000001', '9500000002', '9500000003', '9500000004'],
                    maxConcurrency: 1,
                    proxyConfiguration: { useApifyProxy: false },
                },
                {
                    ...deps,
                    monitoringService: new MonitoringService(false, undefined, { persistToStore: false }),
                    onRecordEmitted: async (r) => {
                        emitted.push(r);
                    },
                },
            );

            expect(emitted).toHaveLength(2);
            expect(summary.billing.limitReached).toBe(true);
            expect(summary.billing.eventsCharged['actor-start']).toBe(1);
            expect(summary.billing.eventsCharged['product-detail']).toBe(2);
            expect(summary.billing.estimatedCostUsd).toBeLessThanOrEqual(0.009);
        } finally {
            if (prevEnv === undefined) delete process.env.ACTOR_MAX_TOTAL_CHARGE_USD;
            else process.env.ACTOR_MAX_TOTAL_CHARGE_USD = prevEnv;
        }
    });
});
