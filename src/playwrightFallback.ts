import { launchPlaywright, type ProxyConfiguration } from '@crawlee/playwright';
import { devices, type Browser } from 'playwright';
import { log } from 'apify';
import type { DebugProbeCollector } from './debugProbe.js';
import { isBlockOrCaptchaResponse, normalizeUserCookieString } from './h5Client.js';
import { getSlugForItemId } from './itemSlugRegistry.js';
import { parseHtmlDetailFallback, parseMtopDetailData, parseSeoPdpApiData } from './sources/productDetailSource.js';
import { applySearchFilters, mapSearchJsonItem, parseWorldTaobaoSearchHtml } from './sources/searchSource.js';
import { parseShopHtml } from './sources/shopSource.js';
import type { DataSourceResult, PartialProductData, PlatformType, SearchFilters } from './types.js';

/**
 * Unwraps JSON or JSONP body string from an intercepted MTOP response.
 */
export function parseInterceptedMtopBody(rawBody: string): { ret?: string[]; data?: Record<string, unknown> } | null {
    if (!rawBody || typeof rawBody !== 'string') return null;
    let jsonText = rawBody.trim();
    const jsonpMatch = jsonText.match(/^[a-zA-Z0-9_$]+\(([\s\S]*)\)\s*;?$/);
    if (jsonpMatch?.[1]) {
        jsonText = jsonpMatch[1];
    }
    try {
        const parsed = JSON.parse(jsonText) as { ret?: string[]; data?: Record<string, unknown> };
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Pure parser for Playwright product detail fallback:
 * 1. Inspects any intercepted MTOP detail responses (`mtop.taobao.pcdetail.data.get`, `mtop.taobao.detail.getdetail`, `mtop.ovs.traffic.landing.seopdp.querySeoPdpPage`)
 * 2. Inspects rendered page HTML (`window.__ICE_APP_CONTEXT__`, `window.__INITIAL_DATA__`, `_DATA_Detail`, and DOM elements).
 */
export function parsePlaywrightProductCapture(params: {
    itemId: string;
    pageUrl?: string;
    html: string;
    interceptedMtopBodies?: string[];
    interceptedMtopPayloads?: Array<Record<string, unknown> | string>;
    preferredPlatform?: PlatformType;
    platform?: PlatformType;
}): PartialProductData | null {
    const preferredPlatform = params.preferredPlatform ?? params.platform ?? 'taobao';
    const pageUrl =
        params.pageUrl ??
        (preferredPlatform === 'tmall'
            ? `https://detail.tmall.com/item.htm?id=${params.itemId}`
            : `https://item.taobao.com/item.htm?id=${params.itemId}`);
    const { itemId, html } = params;
    const rawBodies = [
        ...(params.interceptedMtopBodies ?? []),
        ...(params.interceptedMtopPayloads ?? []).map((p) => (typeof p === 'string' ? p : JSON.stringify(p))),
    ];

    // 1. Check intercepted MTOP responses first
    for (const bodyStr of rawBodies) {
        const parsedMtop = parseInterceptedMtopBody(bodyStr);
        if (!parsedMtop?.data) continue;
        const retJoined = Array.isArray(parsedMtop.ret) ? parsedMtop.ret.join(' | ') : '';
        if (retJoined && !retJoined.includes('SUCCESS')) continue;

        // Overseas SEO PDP payload (`data.result` JSON string), incl. real SKUs when present
        if (typeof parsedMtop.data.result === 'string') {
            const fromOvs = parseSeoPdpApiData(itemId, parsedMtop.data, preferredPlatform);
            if (fromOvs && fromOvs.title) return fromOvs;
        }

        const fromMtop = parseMtopDetailData(itemId, parsedMtop.data, preferredPlatform);
        if (fromMtop && fromMtop.title) {
            return fromMtop;
        }
    }

    // 2. Check rendered page HTML (world.taobao.com `__ICE_APP_CONTEXT__` / `__INITIAL_DATA__` / DOM)
    if (html && html.trim()) {
        const fromHtml = parseHtmlDetailFallback(itemId, html, pageUrl, preferredPlatform);
        if (fromHtml && fromHtml.title) {
            return fromHtml;
        }
    }

    return null;
}

/**
 * Pure parser for Playwright search/category listing fallback:
 * 1. Inspects intercepted MTOP search responses
 * 2. Inspects rendered page HTML (`window.__ICE_APP_CONTEXT__`, `g_page_config`, DOM cards).
 */
export function parsePlaywrightSearchCapture(params: {
    html: string;
    interceptedMtopBodies?: string[];
    filters?: SearchFilters;
}): { items: PartialProductData[]; hasNextPage: boolean } {
    const { html, interceptedMtopBodies = [], filters } = params;
    const items: PartialProductData[] = [];
    const seenIds = new Set<string>();

    const pushItem = (item: PartialProductData | null) => {
        if (!item || !item.itemId || seenIds.has(item.itemId)) return;
        seenIds.add(item.itemId);
        items.push(item);
    };

    for (const bodyStr of interceptedMtopBodies) {
        const parsedMtop = parseInterceptedMtopBody(bodyStr);
        if (!parsedMtop?.data) continue;
        const rawList =
            (parsedMtop.data.itemsArray as unknown[]) ??
            (parsedMtop.data.result as unknown[]) ??
            (parsedMtop.data.listItem as unknown[]) ??
            ((parsedMtop.data.itemListModuleResponse as Record<string, unknown>)?.itemList as unknown[]) ??
            [];
        if (Array.isArray(rawList)) {
            for (const entry of rawList) {
                if (entry && typeof entry === 'object') {
                    pushItem(mapSearchJsonItem(entry as Record<string, unknown>));
                }
            }
        }
    }

    if (html && html.trim()) {
        const htmlParsed = parseWorldTaobaoSearchHtml(html);
        for (const item of htmlParsed.items) {
            pushItem(item);
        }
    }

    const filtered = applySearchFilters(items, filters);
    return {
        items: filtered,
        hasNextPage: items.length >= 20,
    };
}

/**
 * Pure parser for Playwright shop catalogue fallback.
 */
export function parsePlaywrightShopCapture(params: {
    shopUrl: string;
    shopId?: string;
    html: string;
    interceptedMtopBodies?: string[];
}): {
    shopInfo: Partial<PartialProductData>;
    items: PartialProductData[];
    hasNextPage: boolean;
} {
    const { shopUrl, shopId, html, interceptedMtopBodies = [] } = params;
    const parsedFromHtml = parseShopHtml(html || '', shopUrl, shopId);
    const seenIds = new Set(parsedFromHtml.items.map((i) => i.itemId));

    for (const bodyStr of interceptedMtopBodies) {
        const parsedMtop = parseInterceptedMtopBody(bodyStr);
        if (!parsedMtop?.data) continue;
        const rawList =
            (parsedMtop.data.itemsArray as unknown[]) ??
            (parsedMtop.data.listItem as unknown[]) ??
            ((parsedMtop.data.itemListModuleResponse as Record<string, unknown>)?.itemList as unknown[]) ??
            [];
        if (Array.isArray(rawList)) {
            for (const entry of rawList) {
                if (entry && typeof entry === 'object') {
                    const mapped = mapSearchJsonItem(entry as Record<string, unknown>);
                    if (mapped && !seenIds.has(mapped.itemId)) {
                        seenIds.add(mapped.itemId);
                        parsedFromHtml.items.push({
                            ...mapped,
                            ...parsedFromHtml.shopInfo,
                        });
                    }
                }
            }
        }
    }

    return parsedFromHtml;
}

export interface PlaywrightFallbackOptions {
    enabled: boolean;
    /** Legacy option (unused since v1.2; proxies come from getProxyUrl). */
    proxyConfiguration?: ProxyConfiguration;
    /** Returns a sticky proxy URL for a session id + country (RESIDENTIAL). */
    getProxyUrl?: (sessionId: string, countryCode?: string) => Promise<string | undefined>;
    userCookie?: string;
    debugProbe?: DebugProbeCollector;
    proxyGroup?: string;
    proxyCountry?: string;
    /** Country used for the overseas m.intl.taobao.com page (default TW). */
    browserProxyCountry?: string;
    navigationTimeoutMs?: number;
    waitForDataMs?: number;
}

const DETAIL_API_PATTERN = /querySeoPdpPage|mtop\.taobao\.detail\.data\.get|mtop\.taobao\.detail\.getdetail|pcdetail/i;

/**
 * Strategy 2b (v1.2): ONE shared headless Chromium per run (no new crawler per item, which overloaded memory),
 * serialized one page at a time, loading the overseas mobile detail page `m.intl.taobao.com/detail/detail.html?id=`
 * through a sticky RESIDENTIAL proxy session and intercepting the page's own signed MTOP detail responses.
 * Images/fonts/media are blocked to save memory and proxy traffic. Every step has a hard timeout.
 */
export class PlaywrightFallbackService {
    private readonly enabled: boolean;
    private readonly getProxyUrl?: (sessionId: string, countryCode?: string) => Promise<string | undefined>;
    private readonly userCookie?: string;
    private readonly debugProbe?: DebugProbeCollector;
    private readonly proxyGroup: string;
    private readonly browserCountry: string;
    private readonly navigationTimeoutMs: number;
    private readonly waitForDataMs: number;
    private browser: Browser | null = null;
    private browserSessionCounter = 0;
    private queue: Promise<unknown> = Promise.resolve();
    private consecutiveFailures = 0;
    private disabledReason: string | null = null;

    constructor(options: PlaywrightFallbackOptions) {
        this.enabled = options.enabled;
        this.getProxyUrl = options.getProxyUrl;
        this.userCookie = normalizeUserCookieString(options.userCookie);
        this.debugProbe = options.debugProbe;
        this.proxyGroup = options.proxyGroup ?? 'RESIDENTIAL';
        this.browserCountry = (options.browserProxyCountry ?? 'TW').toUpperCase();
        this.navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
        this.waitForDataMs = options.waitForDataMs ?? 20_000;
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    public getDisabledReason(): string | null {
        return this.disabledReason;
    }

    private async ensureBrowser(): Promise<Browser> {
        if (this.browser && this.browser.isConnected()) return this.browser;
        this.browserSessionCounter += 1;
        const sessionId = `pw_${this.browserSessionCounter}_${Math.random().toString(36).slice(2, 8)}`;
        const proxyUrl = this.getProxyUrl ? await this.getProxyUrl(sessionId, this.browserCountry) : undefined;
        this.browser = await withTimeout(
            launchPlaywright({
                useIncognitoPages: true,
                ...(proxyUrl ? { proxyUrl } : {}),
                launchOptions: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
                },
            }),
            45_000,
            'Launching Chromium',
        );
        return this.browser;
    }

    private async resetBrowser(): Promise<void> {
        const b = this.browser;
        this.browser = null;
        if (b) {
            await withTimeout(b.close(), 10_000, 'Closing Chromium').catch(() => undefined);
        }
    }

    public async close(): Promise<void> {
        await this.resetBrowser();
    }

    private async capturePageAndMtop(targetUrl: string): Promise<{
        statusCode: number;
        finalUrl: string;
        html: string;
        interceptedMtopBodies: string[];
        cookieNames: string[];
    } | null> {
        if (!this.enabled) return null;
        const browser = await this.ensureBrowser();
        const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 13'];
        const context = await browser.newContext({
            ...iphone,
            locale: 'zh-TW',
            timezoneId: 'Asia/Taipei',
        });
        const interceptedMtopBodies: string[] = [];
        let gotDetailSuccess = false;
        try {
            if (this.userCookie) {
                const cookies = this.userCookie
                    .split(';')
                    .map((pair) => {
                        const eq = pair.indexOf('=');
                        if (eq <= 0) return null;
                        return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: '.taobao.com', path: '/' };
                    })
                    .filter((c): c is NonNullable<typeof c> => Boolean(c && c.name && c.value));
                if (cookies.length > 0) await context.addCookies(cookies).catch(() => undefined);
            }
            await context.route('**/*', (route) => {
                const req = route.request();
                const type = req.resourceType();
                // Block the "open in Taobao app" callout redirect (ace.tb.cn / tbopen://) which navigates away from the SSR page
                if (type === 'document' && /(^|\.)ace\.tb\.cn\/|^tbopen:|s\.click\.taobao\.com/i.test(req.url().replace(/^https?:\/\//, ''))) {
                    return route.abort().catch(() => undefined);
                }
                if (type === 'image' || type === 'media' || type === 'font') {
                    return route.abort().catch(() => undefined);
                }
                return route.continue().catch(() => undefined);
            });
            const page = await context.newPage();
            page.on('response', async (response) => {
                try {
                    const rUrl = response.url();
                    if (rUrl.includes('/h5/mtop.') || rUrl.includes('h5api')) {
                        const text = await response.text();
                        if (!text) return;
                        interceptedMtopBodies.push(text);
                        if (DETAIL_API_PATTERN.test(rUrl) && text.includes('SUCCESS')) gotDetailSuccess = true;
                    }
                } catch {
                    // Ignore detached frame / body read errors
                }
            });
            const response = await page
                .goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs })
                .catch((err: unknown) => {
                    log.warning(`Playwright navigation issue for ${targetUrl}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
                    return null;
                });
            const initialHtml = response ? await withTimeout(response.text(), 5_000, 'Reading document').catch(() => '') : '';
            const hasSsr = initialHtml.includes('__ICE_APP_CONTEXT__');
            const waitUntil = Date.now() + (hasSsr ? Math.min(3_000, this.waitForDataMs) : this.waitForDataMs);
            while (!gotDetailSuccess && Date.now() < waitUntil) {
                await page.waitForTimeout(500);
                if (interceptedMtopBodies.some((b) => /RGV587|FAIL_SYS_USER_VALIDATE|punish/i.test(b))) break;
            }
            await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
            const liveHtml = await withTimeout(page.content(), 5_000, 'Reading page HTML').catch(() => '');
            // Prefer the server-rendered document when the live DOM lost the SSR state (client redirects / re-renders)
            const html = liveHtml.includes('__ICE_APP_CONTEXT__') || !hasSsr ? liveHtml || initialHtml : initialHtml;
            const contextCookies = await context.cookies().catch(() => []);
            const result = {
                statusCode: response?.status() ?? 0,
                finalUrl: page.url(),
                html,
                interceptedMtopBodies: [...interceptedMtopBodies],
                cookieNames: contextCookies.map((c) => c.name),
            };
            this.debugProbe?.record({
                url: targetUrl,
                urlType: 'playwright',
                statusCode: result.statusCode,
                proxyGroup: this.proxyGroup,
                proxyCountry: this.getProxyUrl ? this.browserCountry : null,
                cookiesPresent: result.cookieNames,
                body: interceptedMtopBodies.find((b) => DETAIL_API_PATTERN.test(b)) ?? interceptedMtopBodies[0] ?? html,
            });
            return result;
        } finally {
            await withTimeout(context.close(), 10_000, 'Closing context').catch(() => undefined);
        }
    }

    public async fetchProductDetail(
        itemId: string,
        preferredPlatform: PlatformType = 'taobao',
        itemIdStr?: string | null,
    ): Promise<DataSourceResult<PartialProductData>> {
        if (!this.enabled) {
            return { ok: false, errorReason: 'Playwright fallback is disabled' };
        }
        if (this.disabledReason) {
            return { ok: false, blocked: true, errorReason: `Playwright fallback skipped: ${this.disabledReason}` };
        }
        // Serialize: only one browser page at a time (memory-safe at 1-2 GB)
        const run = this.queue.then(() => this.fetchProductDetailInner(itemId, preferredPlatform, itemIdStr));
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async fetchProductDetailInner(
        itemId: string,
        preferredPlatform: PlatformType,
        itemIdStr?: string | null,
    ): Promise<DataSourceResult<PartialProductData>> {
        const slug = itemIdStr ?? getSlugForItemId(itemId);
        const candidateUrls = [
            `https://m.intl.taobao.com/detail/detail.html?id=${itemId}`,
            ...(slug ? [`https://world.taobao.com/item/${slug}.htm`] : []),
        ];
        let lastReason = `Playwright fallback could not extract product detail for ${itemId}`;
        let blocked = false;

        for (const url of candidateUrls) {
            let capture: Awaited<ReturnType<PlaywrightFallbackService['capturePageAndMtop']>> = null;
            try {
                capture = await withTimeout(
                    this.capturePageAndMtop(url),
                    this.navigationTimeoutMs + this.waitForDataMs + 25_000,
                    `Playwright capture of ${url}`,
                );
            } catch (err) {
                lastReason = `Playwright error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
                await this.resetBrowser();
                continue;
            }
            if (!capture) continue;

            const parsed = parsePlaywrightProductCapture({
                itemId,
                pageUrl: capture.finalUrl || url,
                html: capture.html,
                interceptedMtopBodies: capture.interceptedMtopBodies,
                preferredPlatform,
            });
            if (parsed && parsed.title) {
                this.consecutiveFailures = 0;
                return { ok: true, data: { ...parsed, detailSource: parsed.detailSource === 'world_ssr' ? 'playwright_world' : 'playwright' } };
            }

            const mtopBlocked = capture.interceptedMtopBodies.some((b) => /RGV587|FAIL_SYS_USER_VALIDATE|x5secdata|punish/i.test(b));
            const blockCheck = isBlockOrCaptchaResponse(capture.statusCode, capture.html);
            if (mtopBlocked || blockCheck.blocked) {
                blocked = true;
                lastReason = `Playwright page was blocked (${blockCheck.reason ?? 'MTOP RGV587 / slider in browser'})`;
                await this.resetBrowser(); // new sticky proxy session next time
            } else {
                const apis = capture.interceptedMtopBodies.length;
                lastReason = `Playwright loaded ${url} (HTTP ${capture.statusCode}) but found no product data (${apis} MTOP responses captured)`;
            }
        }

        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= 3) {
            this.disabledReason = `browser fallback failed ${this.consecutiveFailures} items in a row this run (last: ${lastReason})`;
            await this.resetBrowser();
        }
        return { ok: false, blocked, errorReason: lastReason };
    }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
