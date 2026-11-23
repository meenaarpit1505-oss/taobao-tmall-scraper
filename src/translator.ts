import { gotScraping } from 'got-scraping';
import { createHash } from 'node:crypto';
import { Actor, log } from 'apify';
import type { TranslationStatus } from './types.js';

export interface TranslationProvider {
    readonly name: string;
    translateText(text: string): Promise<string>;
    translateBatch?(texts: string[]): Promise<string[]>;
}

export const TRANSLATION_STORE_NAME = 'taobao-tmall-translations';
export const TRANSLATION_KV_KEY = 'TRANSLATION_CACHE_ZH_EN';
export const TRANSLATION_INDEX_KEY = 'TRANSLATION_CACHE_ZH_EN_INDEX';
export const TRANSLATION_SHARD_COUNT = 16;
export const DEFAULT_MAX_ENTRIES_PER_SHARD = 250;
export const MAX_GTX_BATCH_ENCODED_BYTES = 4800; // ~5 KB encoded cap
export const MAX_DEEPL_BATCH_TEXTS = 50;
export const MAX_GOOGLE_CLOUD_BATCH_TEXTS = 128;
export const MAX_CONSECUTIVE_GTX_429 = 3;

export function getTranslationShardKey(text: string, shardCount: number = TRANSLATION_SHARD_COUNT): string {
    const digest = createHash('sha256').update(String(text ?? ''), 'utf8').digest();
    const bucket = digest.readUInt32BE(0) % Math.max(1, shardCount);
    return `${TRANSLATION_KV_KEY}_SHARD_${String(bucket).padStart(2, '0')}`;
}

/**
 * Splits an array of strings into batches whose URL-encoded payload (`encodeURIComponent(batch.join('\n')).length`)
 * never exceeds `maxEncodedBytes` (~5 KB encoded) and whose item count never exceeds `maxItemsPerBatch`.
 */
export function splitIntoEncodedBatches(
    texts: string[],
    maxEncodedBytes: number = MAX_GTX_BATCH_ENCODED_BYTES,
    maxItemsPerBatch: number = Number.POSITIVE_INFINITY,
): string[][] {
    const batches: string[][] = [];
    let currentBatch: string[] = [];
    let currentEncodedLen = 0;

    for (const text of texts) {
        const encodedItemLen = encodeURIComponent(text).length;
        const sepLen = currentBatch.length > 0 ? 3 : 0; // '%0A' is 3 encoded chars
        if (
            currentBatch.length > 0 &&
            (currentBatch.length >= maxItemsPerBatch ||
                currentEncodedLen + sepLen + encodedItemLen > maxEncodedBytes)
        ) {
            batches.push(currentBatch);
            currentBatch = [text];
            currentEncodedLen = encodedItemLen;
        } else {
            currentBatch.push(text);
            currentEncodedLen += sepLen + encodedItemLen;
        }
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
}

/**
 * Comprehensive Taobao/Tmall Chinese-to-English e-commerce dictionary used to speed up common
 * SKU/attribute terms when they completely translate the term.
 */
const ECOMMERCE_GLOSSARY: Array<[RegExp, string]> = [
    [/颜色分类/g, 'Color'],
    [/颜色/g, 'Color'],
    [/尺码/g, 'Size'],
    [/尺寸/g, 'Dimensions'],
    [/规格/g, 'Specification'],
    [/款式/g, 'Style'],
    [/套餐类型/g, 'Package Type'],
    [/官方标配/g, 'Official Standard'],
    [/品牌/g, 'Brand'],
    [/材质/g, 'Material'],
    [/产地/g, 'Origin'],
    [/货号/g, 'Item No'],
    [/适用性别/g, 'Gender'],
    [/适用季节/g, 'Season'],
    [/风格/g, 'Style'],
    [/上市年份季节/g, 'Release Season'],
    [/厚薄/g, 'Thickness'],
    [/版型/g, 'Fit'],
    [/袖长/g, 'Sleeve Length'],
    [/领型/g, 'Collar Type'],
    [/裤长/g, 'Pants Length'],
    [/面料/g, 'Fabric'],
    [/图案/g, 'Pattern'],
    [/流行元素/g, 'Popular Elements'],
    [/发货地/g, 'Ship From'],
    [/保修期/g, 'Warranty'],
    [/型号/g, 'Model'],
    [/连接方式/g, 'Connection Mode'],
    [/蓝牙耳机/g, 'Bluetooth Earphones'],
    [/无线耳机/g, 'Wireless Earphones'],
    [/降噪/g, 'Noise Cancelling'],
    [/机械键盘/g, 'Mechanical Keyboard'],
    [/客制化/g, 'Custom'],
    [/无线鼠标/g, 'Wireless Mouse'],
    [/连衣裙/g, 'Dress'],
    [/T恤/gi, 'T-Shirt'],
    [/卫衣/g, 'Hoodie'],
    [/外套/g, 'Jacket'],
    [/牛仔裤/g, 'Jeans'],
    [/休闲裤/g, 'Casual Pants'],
    [/运动鞋/g, 'Sneakers'],
    [/双肩包/g, 'Backpack'],
    [/手提包/g, 'Handbag'],
    [/手机壳/g, 'Phone Case'],
    [/充电宝/g, 'Power Bank'],
    [/数据线/g, 'Data Cable'],
    [/保温杯/g, 'Thermos Cup'],
    [/曜石黑/g, 'Obsidian Black'],
    [/星空灰/g, 'Space Gray'],
    [/深空灰/g, 'Space Gray'],
    [/月光白/g, 'Moonlight White'],
    [/象牙白/g, 'Ivory White'],
    [/珍珠白/g, 'Pearl White'],
    [/玫瑰金/g, 'Rose Gold'],
    [/香槟金/g, 'Champagne Gold'],
    [/樱花粉/g, 'Sakura Pink'],
    [/雾霾蓝/g, 'Haze Blue'],
    [/藏青色/g, 'Navy Blue'],
    [/军绿色/g, 'Army Green'],
    [/卡其色/g, 'Khaki'],
    [/杏色/g, 'Apricot'],
    [/米白色/g, 'Off-White'],
    [/米色/g, 'Beige'],
    [/黑色/g, 'Black'],
    [/白色/g, 'White'],
    [/红色/g, 'Red'],
    [/蓝色/g, 'Blue'],
    [/绿色/g, 'Green'],
    [/黄色/g, 'Yellow'],
    [/紫色/g, 'Purple'],
    [/粉色/g, 'Pink'],
    [/灰色/g, 'Gray'],
    [/棕色/g, 'Brown'],
    [/咖色/g, 'Coffee'],
    [/银色/g, 'Silver'],
    [/金色/g, 'Gold'],
    [/透明/g, 'Transparent'],
    [/均码/g, 'One Size'],
    [/大号/g, 'Large'],
    [/中号/g, 'Medium'],
    [/小号/g, 'Small'],
    [/加绒/g, 'Fleece-Lined'],
    [/加厚/g, 'Thickened'],
    [/薄款/g, 'Thin'],
    [/常规款/g, 'Regular'],
    [/升级版/g, 'Upgraded Version'],
    [/旗舰版/g, 'Flagship Edition'],
    [/标准版/g, 'Standard Edition'],
    [/尊享版/g, 'Premium Edition'],
    [/礼盒装/g, 'Gift Box'],
    [/默认规格/g, 'Default Variant'],
    [/新款/g, 'New'],
    [/春夏/g, 'Spring/Summer'],
    [/秋冬/g, 'Autumn/Winter'],
    [/夏季/g, 'Summer'],
    [/冬季/g, 'Winter'],
    [/春季/g, 'Spring'],
    [/秋季/g, 'Autumn'],
    [/男款/g, 'Men'],
    [/女款/g, 'Women'],
    [/男女同款/g, 'Unisex'],
    [/正品/g, 'Authentic'],
    [/纯棉/g, '100% Cotton'],
    [/不锈钢/g, 'Stainless Steel'],
    [/铝合金/g, 'Aluminum Alloy'],
    [/中国大陆/g, 'Mainland China'],
];

/**
 * Applies dictionary replacement for common Chinese e-commerce terms.
 */
export function applyGlossaryTranslation(text: string): string {
    let result = text;
    for (const [pattern, replacement] of ECOMMERCE_GLOSSARY) {
        result = result.replace(pattern, ` ${replacement} `);
    }
    return result.replace(/\s+/g, ' ').trim();
}

/**
 * Checks whether a string contains Chinese (CJK) characters.
 */
export function containsChinese(text: string): boolean {
    return /[\u4e00-\u9fff]/.test(text);
}

/**
 * Free / zero-key Google GTX translation provider:
 * - Sends requests via POST with form-urlencoded body (`q=...`)
 * - Caps each batch at ~5 KB encoded (`MAX_GTX_BATCH_ENCODED_BYTES`)
 * - Retries with exponential backoff on HTTP 429 and transient errors
 */
/**
 * Parses either the `translate_a/single?client=gtx` shape (`[[["seg","src",...],...],...]`) or the
 * `clients5 translate_a/t?client=dict-chrome-ex` shape (`["text"]` or `[["text","zh-CN"]]`).
 */
export function parseFreeGoogleTranslateBody(rawBody: string): string | null {
    let data: unknown;
    try {
        data = JSON.parse(rawBody);
    } catch {
        return null;
    }
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0];
    if (typeof first === 'string') {
        return data.filter((x): x is string => typeof x === 'string').join('\n');
    }
    if (Array.isArray(first)) {
        if (typeof first[0] === 'string' && (first.length === 2 && typeof first[1] === 'string') && !Array.isArray(first[0])) {
            // clients5 shape: [["text","zh-CN"], ...]
            return data
                .map((entry) => (Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : ''))
                .join('\n');
        }
        // gtx shape
        const segs = (first as unknown[])
            .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
            .join('');
        return segs || null;
    }
    return null;
}

export class FreeGtxTranslationProvider implements TranslationProvider {
    public readonly name = 'GoogleGtxTranslationProvider';
    private readonly timeoutMs: number;
    private readonly maxRetries: number;
    private readonly baseBackoffMs: number;
    private readonly hasCustomBaseBackoff: boolean;
    private readonly maxBatchEncodedBytes: number;
    private readonly customFetch?: typeof fetch;
    private readonly proxyUrlProvider?: () => Promise<string | undefined>;
    private lastFailureReason: string | null = null;
    private consecutive429s = 0;
    private rateLimitTripped = false;
    private rateLimitWarningLogged = false;

    constructor(options?: {
        timeoutMs?: number;
        maxRetries?: number;
        baseBackoffMs?: number;
        maxBatchEncodedBytes?: number;
        customFetch?: typeof fetch;
        proxyUrlProvider?: () => Promise<string | undefined>;
    }) {
        this.proxyUrlProvider = options?.proxyUrlProvider;
        this.timeoutMs = options?.timeoutMs ?? 4500;
        this.maxRetries = Math.min(3, Math.max(1, options?.maxRetries ?? 3));
        this.baseBackoffMs = options?.baseBackoffMs ?? 150;
        this.hasCustomBaseBackoff = options?.baseBackoffMs !== undefined;
        this.maxBatchEncodedBytes = options?.maxBatchEncodedBytes ?? MAX_GTX_BATCH_ENCODED_BYTES;
        this.customFetch = options?.customFetch;
    }

    public isRateLimitTripped(): boolean {
        return this.rateLimitTripped;
    }

    private parseRetryAfterMs(res: Response): number | null {
        const raw = res.headers?.get?.('retry-after');
        if (!raw || !raw.trim()) return null;
        const trimmed = raw.trim();
        if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
            const seconds = parseFloat(trimmed);
            if (Number.isFinite(seconds) && seconds >= 0) {
                return Math.round(seconds * 1000);
            }
        }
        const parsedDate = Date.parse(trimmed);
        if (!Number.isNaN(parsedDate)) {
            return Math.max(0, parsedDate - Date.now());
        }
        return null;
    }

    public async fetchGtxRaw(queryText: string): Promise<string> {
        if (this.rateLimitTripped) {
            throw new Error('GTX translation skipped: stopped for the rest of the run after 3 consecutive HTTP 429s');
        }

        if (!this.customFetch && this.proxyUrlProvider) {
            // Production on Apify (proxy available): multi-route chain incl. proxied retries
            return this.fetchViaFreeRoutes(queryText);
        }
        if (!this.customFetch) {
            // Local / no proxy: classic GTX loop with 429 backoff, then one direct try on the clients5 endpoint
            try {
                return await this.fetchGtxLegacy(queryText);
            } catch (legacyErr) {
                if (this.rateLimitTripped) throw legacyErr;
                return this.fetchViaFreeRoutes(queryText);
            }
        }
        return this.fetchGtxLegacy(queryText);
    }

    private async fetchGtxLegacy(queryText: string): Promise<string> {
        let lastErr: unknown;
        const fetchFn = this.customFetch ?? fetch;
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            if (this.rateLimitTripped) {
                throw new Error('GTX translation skipped: stopped for the rest of the run after 3 consecutive HTTP 429s');
            }

            let statusCode = 0;
            let retryAfterMs: number | null = null;
            try {
                const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=en&dt=t';
                const body = new URLSearchParams({ q: queryText }).toString();
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), this.timeoutMs);

                const res = await fetchFn(url, {
                    method: 'POST',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                        Accept: 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    },
                    body,
                    signal: controller.signal,
                });
                clearTimeout(timer);
                statusCode = res.status;

                if (statusCode === 429) {
                    this.consecutive429s += 1;
                    retryAfterMs = this.parseRetryAfterMs(res);
                    if (this.consecutive429s >= MAX_CONSECUTIVE_GTX_429) {
                        this.rateLimitTripped = true;
                        if (!this.rateLimitWarningLogged) {
                            this.rateLimitWarningLogged = true;
                            log.warning(
                                'Google GTX returned 3 consecutive HTTP 429 responses; stopping GTX translation for the rest of the run and marking remaining strings as failed.',
                            );
                        }
                        throw new Error('GTX returned HTTP 429 (stopped after 3 consecutive 429s)');
                    }
                } else {
                    this.consecutive429s = 0;
                }

                if (res.ok) {
                    const data = (await res.json()) as unknown[];
                    if (Array.isArray(data) && Array.isArray(data[0])) {
                        const translatedSegments = (data[0] as unknown[])
                            .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
                            .join('');
                        if (translatedSegments.trim()) {
                            return translatedSegments;
                        }
                    }
                }
                lastErr = new Error(`GTX returned HTTP ${res.status}`);
            } catch (err) {
                lastErr = err;
                if (this.rateLimitTripped) {
                    throw lastErr;
                }
            }

            if (attempt < this.maxRetries && !this.rateLimitTripped) {
                let backoff: number;
                if (statusCode === 429) {
                    if (retryAfterMs !== null) {
                        backoff = retryAfterMs;
                    } else if (this.hasCustomBaseBackoff) {
                        backoff = this.baseBackoffMs * Math.pow(2, attempt - 1) * 2;
                    } else {
                        // Wait 2-5s with exponential backoff on 429
                        backoff = Math.min(5000, Math.max(2000, 2000 * Math.pow(2, attempt - 1)));
                    }
                } else {
                    backoff = this.baseBackoffMs * Math.pow(2, attempt - 1);
                }
                await new Promise((resolve) => setTimeout(resolve, backoff));
            }
        }
        throw lastErr ?? new Error('Translation request failed');
    }

    public getLastFailureReason(): string | null {
        return this.lastFailureReason;
    }

    /**
     * Production path (no customFetch): Google's free endpoints rate-limit datacenter IPs (HTTP 429 "Sorry" page or a
     * 302 to google.com/sorry), which is why every item showed translationStatus "failed" on the Apify platform.
     * Try two free Google endpoints directly, then the same endpoints through the run's proxy (fresh session per try).
     */
    private async fetchViaFreeRoutes(queryText: string): Promise<string> {
        const body = new URLSearchParams({ q: queryText }).toString();
        const routes: Array<{ name: string; url: string; viaProxy: boolean }> = this.proxyUrlProvider ? [
            { name: 'clients5', url: 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=zh-CN&tl=en', viaProxy: false },
            { name: 'gtx', url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=en&dt=t', viaProxy: false },
        ] : [
            { name: 'clients5', url: 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=zh-CN&tl=en', viaProxy: false },
        ];
        if (this.proxyUrlProvider) {
            routes.push(
                { name: 'clients5+proxy', url: routes[0]!.url, viaProxy: true },
                { name: 'gtx+proxy', url: routes[1]!.url, viaProxy: true },
                { name: 'clients5+proxy', url: routes[0]!.url, viaProxy: true },
            );
        }
        if (this.rateLimitTripped) {
            throw new Error('GTX translation skipped: stopped for the rest of the run after 3 consecutive HTTP 429s');
        }

        let rateLimitedEverywhere = true;
        const failures: string[] = [];
        for (const route of routes) {
            let proxyUrl: string | undefined;
            if (route.viaProxy) {
                try {
                    proxyUrl = await this.proxyUrlProvider!();
                } catch {
                    proxyUrl = undefined;
                }
                if (!proxyUrl) continue;
            }
            try {
                const res = await gotScraping({
                    url: route.url,
                    method: 'POST',
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    },
                    body,
                    proxyUrl,
                    followRedirect: false,
                    throwHttpErrors: false,
                    timeout: { request: route.viaProxy ? 12_000 : this.timeoutMs },
                    retry: { limit: 0 },
                });
                const status = res.statusCode;
                const text = typeof res.body === 'string' ? res.body : String(res.body);
                if (status === 200) {
                    const parsed = parseFreeGoogleTranslateBody(text);
                    if (parsed && parsed.trim()) {
                        this.consecutive429s = 0;
                        this.lastFailureReason = null;
                        return parsed;
                    }
                    rateLimitedEverywhere = false;
                    failures.push(`${route.name}: unparseable 200 response`);
                    continue;
                }
                const limited = status === 429 || status === 302 || /google\.com\/sorry/i.test(text);
                if (!limited) rateLimitedEverywhere = false;
                failures.push(`${route.name}: HTTP ${status}${limited ? ' (rate-limited)' : ''}`);
            } catch (err) {
                rateLimitedEverywhere = false;
                failures.push(`${route.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        this.lastFailureReason = `All free translation routes failed: ${failures.join('; ')}`;
        if (rateLimitedEverywhere) {
            this.consecutive429s += 1;
            if (this.consecutive429s >= MAX_CONSECUTIVE_GTX_429) {
                this.rateLimitTripped = true;
                if (!this.rateLimitWarningLogged) {
                    this.rateLimitWarningLogged = true;
                    log.warning(
                        'Google GTX returned 3 consecutive HTTP 429 responses on every free route; stopping GTX translation for the rest of the run and marking remaining strings as failed. Provide a DeepL or Google Cloud API key for reliable translation.',
                    );
                }
            }
        }
        throw new Error(this.lastFailureReason);
    }

    public async translateText(text: string): Promise<string> {
        const trimmed = text.trim();
        if (!trimmed || !containsChinese(trimmed)) {
            return trimmed;
        }
        if (this.rateLimitTripped) {
            throw new Error('GTX translation skipped: stopped for the rest of the run after 3 consecutive HTTP 429s');
        }

        // Fast glossary match ONLY if replacing glossary terms removes all Chinese characters
        const glossaryAttempt = applyGlossaryTranslation(trimmed);
        if (!containsChinese(glossaryAttempt)) {
            return glossaryAttempt;
        }

        const raw = await this.fetchGtxRaw(trimmed);
        const clean = raw.trim();
        if (!clean || clean === trimmed) {
            throw new Error('GTX translation returned empty or unchanged Chinese text');
        }
        return clean;
    }

    public async translateBatch(texts: string[]): Promise<string[]> {
        if (texts.length === 0) return [];
        const results = new Array<string>(texts.length).fill('');
        const pendingIndices: number[] = [];
        const pendingTexts: string[] = [];

        for (let i = 0; i < texts.length; i++) {
            const trimmed = texts[i].trim();
            if (!trimmed || !containsChinese(trimmed)) {
                results[i] = trimmed;
                continue;
            }
            if (!this.rateLimitTripped) {
                const glossaryAttempt = applyGlossaryTranslation(trimmed);
                if (!containsChinese(glossaryAttempt)) {
                    results[i] = glossaryAttempt;
                    continue;
                }
            }
            pendingIndices.push(i);
            pendingTexts.push(trimmed.replace(/\r?\n/g, ' '));
        }

        if (pendingTexts.length === 0) {
            return results;
        }

        const chunks = splitIntoEncodedBatches(pendingTexts, this.maxBatchEncodedBytes);
        let offset = 0;

        for (const chunk of chunks) {
            if (this.rateLimitTripped) {
                for (let j = 0; j < chunk.length; j++) {
                    results[pendingIndices[offset + j]] = '';
                }
                offset += chunk.length;
                continue;
            }

            const joined = chunk.join('\n');
            try {
                const rawTranslated = await this.fetchGtxRaw(joined);
                const lines = rawTranslated.split(/\r?\n/).map((s) => s.trim());

                if (lines.length === chunk.length) {
                    for (let j = 0; j < chunk.length; j++) {
                        const targetIdx = pendingIndices[offset + j];
                        const line = lines[j];
                        results[targetIdx] = line && line !== chunk[j] ? line : '';
                    }
                } else {
                    // Line mismatch fallback: translate items in this chunk individually
                    for (let j = 0; j < chunk.length; j++) {
                        const targetIdx = pendingIndices[offset + j];
                        if (this.rateLimitTripped) {
                            results[targetIdx] = '';
                            continue;
                        }
                        try {
                            results[targetIdx] = await this.translateText(chunk[j]);
                        } catch {
                            results[targetIdx] = '';
                        }
                    }
                }
            } catch {
                // Failed batch only nulls its own strings; successful batches are kept and cached
                for (let j = 0; j < chunk.length; j++) {
                    const targetIdx = pendingIndices[offset + j];
                    results[targetIdx] = '';
                }
            }

            offset += chunk.length;
        }

        return results;
    }
}

/**
 * Optional paid DeepL API translation provider (configured via `translationApiKey` / `deeplApiKey`).
 */
export class DeepLTranslationProvider implements TranslationProvider {
    public readonly name = 'DeepLTranslationProvider';
    private readonly apiKey: string;
    private readonly apiUrl: string;
    private readonly timeoutMs: number;
    private readonly maxRetries: number;
    private readonly baseBackoffMs: number;
    private readonly maxBatchEncodedBytes: number;
    private readonly customFetch?: typeof fetch;

    constructor(options: {
        apiKey: string;
        apiUrl?: string;
        timeoutMs?: number;
        maxRetries?: number;
        baseBackoffMs?: number;
        maxBatchEncodedBytes?: number;
        customFetch?: typeof fetch;
    }) {
        this.apiKey = options.apiKey.trim();
        this.apiUrl =
            options.apiUrl ??
            (this.apiKey.endsWith(':fx')
                ? 'https://api-free.deepl.com/v2/translate'
                : 'https://api.deepl.com/v2/translate');
        this.timeoutMs = options.timeoutMs ?? 6000;
        this.maxRetries = options.maxRetries ?? 3;
        this.baseBackoffMs = options.baseBackoffMs ?? 150;
        this.maxBatchEncodedBytes = options.maxBatchEncodedBytes ?? MAX_GTX_BATCH_ENCODED_BYTES;
        this.customFetch = options.customFetch;
    }

    private async requestDeepL(texts: string[]): Promise<string[]> {
        let lastErr: unknown;
        const fetchFn = this.customFetch ?? fetch;
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            let statusCode = 0;
            try {
                const params = new URLSearchParams();
                params.set('source_lang', 'ZH');
                params.set('target_lang', 'EN');
                for (const t of texts) {
                    params.append('text', t);
                }
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), this.timeoutMs);

                const res = await fetchFn(this.apiUrl, {
                    method: 'POST',
                    headers: {
                        Authorization: `DeepL-Auth-Key ${this.apiKey}`,
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                        Accept: 'application/json',
                    },
                    body: params.toString(),
                    signal: controller.signal,
                });
                clearTimeout(timer);
                statusCode = res.status;

                if (res.ok) {
                    const data = (await res.json()) as { translations?: Array<{ text?: string }> };
                    if (Array.isArray(data.translations) && data.translations.length === texts.length) {
                        return data.translations.map((tr) => (tr.text ?? '').trim());
                    }
                }
                lastErr = new Error(`DeepL API returned HTTP ${res.status}`);
            } catch (err) {
                lastErr = err;
            }

            if (attempt < this.maxRetries) {
                const rateLimitMultiplier = statusCode === 429 ? 2 : 1;
                const backoff = this.baseBackoffMs * Math.pow(2, attempt - 1) * rateLimitMultiplier;
                await new Promise((resolve) => setTimeout(resolve, backoff));
            }
        }
        throw lastErr ?? new Error('DeepL translation request failed');
    }

    public async translateText(text: string): Promise<string> {
        const [res] = await this.translateBatch([text]);
        if (!res) throw new Error('DeepL returned empty translation');
        return res;
    }

    public async translateBatch(texts: string[]): Promise<string[]> {
        if (texts.length === 0) return [];
        const chunks = splitIntoEncodedBatches(texts, this.maxBatchEncodedBytes, MAX_DEEPL_BATCH_TEXTS);
        const out: string[] = [];
        for (const chunk of chunks) {
            const translated = await this.requestDeepL(chunk);
            out.push(...translated);
        }
        return out;
    }
}

/**
 * Optional paid Google Cloud Translation v2 API provider (configured via `translationApiKey` / `googleTranslateApiKey`).
 */
export class GoogleCloudTranslationProvider implements TranslationProvider {
    public readonly name = 'GoogleCloudTranslationProvider';
    private readonly apiKey: string;
    private readonly apiUrl: string;
    private readonly timeoutMs: number;
    private readonly maxRetries: number;
    private readonly baseBackoffMs: number;
    private readonly maxBatchEncodedBytes: number;
    private readonly customFetch?: typeof fetch;

    constructor(options: {
        apiKey: string;
        apiUrl?: string;
        timeoutMs?: number;
        maxRetries?: number;
        baseBackoffMs?: number;
        maxBatchEncodedBytes?: number;
        customFetch?: typeof fetch;
    }) {
        this.apiKey = options.apiKey.trim();
        this.apiUrl = options.apiUrl ?? 'https://translation.googleapis.com/language/translate/v2';
        this.timeoutMs = options.timeoutMs ?? 6000;
        this.maxRetries = options.maxRetries ?? 3;
        this.baseBackoffMs = options.baseBackoffMs ?? 150;
        this.maxBatchEncodedBytes = options.maxBatchEncodedBytes ?? MAX_GTX_BATCH_ENCODED_BYTES;
        this.customFetch = options.customFetch;
    }

    private async requestGoogleCloud(texts: string[]): Promise<string[]> {
        let lastErr: unknown;
        const fetchFn = this.customFetch ?? fetch;
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            let statusCode = 0;
            try {
                const url = `${this.apiUrl}?key=${encodeURIComponent(this.apiKey)}`;
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), this.timeoutMs);

                const res = await fetchFn(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json;charset=UTF-8',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify({
                        q: texts,
                        source: 'zh-CN',
                        target: 'en',
                        format: 'text',
                    }),
                    signal: controller.signal,
                });
                clearTimeout(timer);
                statusCode = res.status;

                if (res.ok) {
                    const payload = (await res.json()) as {
                        data?: { translations?: Array<{ translatedText?: string }> };
                    };
                    const list = payload.data?.translations;
                    if (Array.isArray(list) && list.length === texts.length) {
                        return list.map((item) => (item.translatedText ?? '').trim());
                    }
                }
                lastErr = new Error(`Google Cloud Translation API returned HTTP ${res.status}`);
            } catch (err) {
                lastErr = err;
            }

            if (attempt < this.maxRetries) {
                const rateLimitMultiplier = statusCode === 429 ? 2 : 1;
                const backoff = this.baseBackoffMs * Math.pow(2, attempt - 1) * rateLimitMultiplier;
                await new Promise((resolve) => setTimeout(resolve, backoff));
            }
        }
        throw lastErr ?? new Error('Google Cloud translation request failed');
    }

    public async translateText(text: string): Promise<string> {
        const [res] = await this.translateBatch([text]);
        if (!res) throw new Error('Google Cloud returned empty translation');
        return res;
    }

    public async translateBatch(texts: string[]): Promise<string[]> {
        if (texts.length === 0) return [];
        const chunks = splitIntoEncodedBatches(texts, this.maxBatchEncodedBytes, MAX_GOOGLE_CLOUD_BATCH_TEXTS);
        const out: string[] = [];
        for (const chunk of chunks) {
            const translated = await this.requestGoogleCloud(chunk);
            out.push(...translated);
        }
        return out;
    }
}

export function createTranslationProvider(options?: {
    provider?: TranslationProvider | 'gtx' | 'deepl' | 'google';
    apiKey?: string;
    deeplApiKey?: string;
    googleTranslateApiKey?: string;
    maxRetries?: number;
    baseBackoffMs?: number;
    maxBatchEncodedBytes?: number;
    customFetch?: typeof fetch;
    proxyUrlProvider?: () => Promise<string | undefined>;
}): TranslationProvider {
    if (options?.provider && typeof options.provider === 'object') {
        return options.provider;
    }

    const chosenProvider = options?.provider ?? 'gtx';

    if (chosenProvider === 'deepl') {
        const deeplKey = options?.deeplApiKey?.trim() || options?.apiKey?.trim() || '';
        if (deeplKey) {
            return new DeepLTranslationProvider({
                apiKey: deeplKey,
                maxRetries: options?.maxRetries,
                baseBackoffMs: options?.baseBackoffMs,
                maxBatchEncodedBytes: options?.maxBatchEncodedBytes,
                customFetch: options?.customFetch,
            });
        }
        log.warning('Translation provider "deepl" was selected without an API key; falling back to free Google GTX.');
    } else if (chosenProvider === 'google') {
        const googleKey = options?.googleTranslateApiKey?.trim() || options?.apiKey?.trim() || '';
        if (googleKey) {
            return new GoogleCloudTranslationProvider({
                apiKey: googleKey,
                maxRetries: options?.maxRetries,
                baseBackoffMs: options?.baseBackoffMs,
                maxBatchEncodedBytes: options?.maxBatchEncodedBytes,
                customFetch: options?.customFetch,
            });
        }
        log.warning('Translation provider "google" was selected without an API key; falling back to free Google GTX.');
    }

    return new FreeGtxTranslationProvider({
        maxRetries: options?.maxRetries,
        baseBackoffMs: options?.baseBackoffMs,
        maxBatchEncodedBytes: options?.maxBatchEncodedBytes,
        customFetch: options?.customFetch,
        proxyUrlProvider: options?.proxyUrlProvider,
    });
}

export interface TranslatorServiceOptions {
    enabled?: boolean;
    provider?: TranslationProvider | 'gtx' | 'deepl' | 'google';
    apiKey?: string;
    deeplApiKey?: string;
    googleTranslateApiKey?: string;
    initialCache?: Record<string, string>;
    maxConcurrency?: number;
    maxRetries?: number;
    baseBackoffMs?: number;
    persistToStore?: boolean;
    shardCount?: number;
    maxEntriesPerShard?: number;
    /** Optional proxy URL supplier used when Google's free endpoints rate-limit the direct (datacenter) IP. */
    proxyUrlProvider?: () => Promise<string | undefined>;
}

/**
 * Pluggable TranslatorService with:
 * - Persistent named Key-Value Store caching (`taobao-tmall-translations`) stored as several bounded shard records
 * - Request batching (`translateBatch`) capped at ~5 KB encoded
 * - Concurrency limits + retries with exponential backoff
 * - Strict cache hygiene: NEVER caches failed or partial translations (strings still containing CJK)
 * - Sets `titleEn` / failed results to `null` (not the Chinese text) and `translationStatus` to `"failed"` on failure
 */
export class TranslatorService {
    private readonly enabled: boolean;
    private readonly provider: TranslationProvider;
    private readonly shards = new Map<string, Map<string, string>>();
    private readonly dirtyShards = new Set<string>();
    private readonly shardCount: number;
    private readonly maxEntriesPerShard: number;
    private readonly maxConcurrency: number;
    private readonly maxRetries: number;
    private readonly baseBackoffMs: number;
    private readonly persistToStore: boolean;
    private activeCount = 0;
    private readonly waitQueue: Array<() => void> = [];
    private store: Awaited<ReturnType<typeof Actor.openKeyValueStore>> | null = null;
    private dirty = false;

    constructor(options?: TranslatorServiceOptions) {
        this.enabled = options?.enabled ?? true;
        this.maxConcurrency = Math.max(1, options?.maxConcurrency ?? 4);
        this.maxRetries = Math.max(1, options?.maxRetries ?? 3);
        this.baseBackoffMs = options?.baseBackoffMs ?? 100;
        this.persistToStore = options?.persistToStore ?? true;
        this.shardCount = Math.max(1, options?.shardCount ?? TRANSLATION_SHARD_COUNT);
        this.maxEntriesPerShard = Math.max(1, options?.maxEntriesPerShard ?? DEFAULT_MAX_ENTRIES_PER_SHARD);
        this.provider = createTranslationProvider({
            provider: options?.provider,
            apiKey: options?.apiKey,
            deeplApiKey: options?.deeplApiKey,
            googleTranslateApiKey: options?.googleTranslateApiKey,
            maxRetries: this.maxRetries,
            // Pass through only a caller-supplied backoff so the GTX 2–5s 429
            // default is not disabled by TranslatorService's own 100ms default.
            baseBackoffMs: options?.baseBackoffMs,
            proxyUrlProvider: options?.proxyUrlProvider,
        });

        if (options?.initialCache) {
            for (const [k, v] of Object.entries(options.initialCache)) {
                if (typeof v === 'string' && v.trim() && !containsChinese(v)) {
                    this.setCachedValue(k, v, false);
                }
            }
        }
    }

    public getProviderName(): string {
        return this.provider.name;
    }

    /** Last translation failure reason reported by the provider (free GTX only), for RUN_SUMMARY. */
    public getLastFailureReason(): string | null {
        const p = this.provider as { getLastFailureReason?: () => string | null };
        return typeof p.getLastFailureReason === 'function' ? p.getLastFailureReason() : null;
    }

    private getCachedValue(key: string): string | undefined {
        const shardKey = getTranslationShardKey(key, this.shardCount);
        return this.shards.get(shardKey)?.get(key);
    }

    private setCachedValue(key: string, value: string, markDirty = true): void {
        const shardKey = getTranslationShardKey(key, this.shardCount);
        let shard = this.shards.get(shardKey);
        if (!shard) {
            shard = new Map<string, string>();
            this.shards.set(shardKey, shard);
        }
        if (shard.has(key)) {
            shard.delete(key);
        } else if (shard.size >= this.maxEntriesPerShard) {
            // Bounded record eviction: drop oldest entry in this shard
            const oldestKey = shard.keys().next().value;
            if (oldestKey !== undefined) {
                shard.delete(oldestKey);
            }
        }
        shard.set(key, value);
        if (markDirty) {
            this.dirty = true;
            this.dirtyShards.add(shardKey);
        }
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    private async acquireSlot(): Promise<void> {
        if (this.activeCount < this.maxConcurrency) {
            this.activeCount += 1;
            return;
        }
        await new Promise<void>((resolve) => this.waitQueue.push(resolve));
        this.activeCount += 1;
    }

    private releaseSlot(): void {
        this.activeCount = Math.max(0, this.activeCount - 1);
        const next = this.waitQueue.shift();
        if (next) next();
    }

    private async callWithConcurrencyAndRetry<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquireSlot();
        try {
            // Built-in providers already perform their own exponential backoff retries
            const hasInternalRetries =
                this.provider instanceof FreeGtxTranslationProvider ||
                this.provider instanceof DeepLTranslationProvider ||
                this.provider instanceof GoogleCloudTranslationProvider;
            const attempts = hasInternalRetries ? 1 : this.maxRetries;
            let lastErr: unknown;
            for (let attempt = 1; attempt <= attempts; attempt++) {
                try {
                    return await fn();
                } catch (err) {
                    lastErr = err;
                    if (attempt < attempts) {
                        const delay = this.baseBackoffMs * Math.pow(2, attempt - 1);
                        await new Promise((resolve) => setTimeout(resolve, delay));
                    }
                }
            }
            throw lastErr;
        } finally {
            this.releaseSlot();
        }
    }

    public async initFromKvStore(): Promise<void> {
        if (!this.enabled || !this.persistToStore) return;
        try {
            this.store = await Actor.openKeyValueStore(TRANSLATION_STORE_NAME);
            const shardKeys = await this.store.getValue<string[]>(TRANSLATION_INDEX_KEY);
            if (Array.isArray(shardKeys) && shardKeys.length > 0) {
                for (const shardKey of shardKeys) {
                    if (typeof shardKey !== 'string' || !shardKey) continue;
                    const shardData = await this.store.getValue<Record<string, string>>(shardKey);
                    if (shardData && typeof shardData === 'object') {
                        for (const [k, v] of Object.entries(shardData)) {
                            if (typeof v === 'string' && v.trim() && !containsChinese(v)) {
                                this.setCachedValue(k, v, false);
                            }
                        }
                    }
                }
            } else {
                // Backward-compatible fallback: read legacy single record if present and shard it in memory
                    const legacy = await this.store.getValue<Record<string, string>>(TRANSLATION_KV_KEY);
                if (legacy && typeof legacy === 'object') {
                    for (const [k, v] of Object.entries(legacy)) {
                        if (typeof v === 'string' && v.trim() && !containsChinese(v)) {
                            this.setCachedValue(k, v, false);
                        }
                    }
                }
            }
        } catch {
            // Ignore KV load errors in local or restricted environments
        }
    }

    public async flushToKvStore(): Promise<void> {
        if (!this.enabled || !this.dirty || !this.persistToStore) return;
        try {
            if (!this.store) {
                this.store = await Actor.openKeyValueStore(TRANSLATION_STORE_NAME);
            }
            for (const shardKey of this.dirtyShards) {
                const shardMap = this.shards.get(shardKey);
                if (shardMap) {
                    const serialized = Object.fromEntries(shardMap.entries());
                    await this.store.setValue(shardKey, serialized);
                }
            }
            const allShardKeys = Array.from(this.shards.keys()).sort();
            await this.store.setValue(TRANSLATION_INDEX_KEY, allShardKeys);
            this.dirtyShards.clear();
            this.dirty = false;
        } catch {
            // Ignore KV persist errors in local or restricted environments
        }
    }

    /**
     * Checks whether a translated string is a complete, cacheable English translation.
     * Failed or partial translations (empty, identical to Chinese input, or still containing Chinese characters)
     * are NEVER cached.
     */
    private isCompleteTranslation(originalChinese: string, translated: string): boolean {
        const clean = translated.trim();
        if (!clean || clean === originalChinese) return false;
        return !containsChinese(clean);
    }

    public async translate(text: string | null | undefined): Promise<string | null> {
        if (!text) return null;
        if (!this.enabled) return null;
        const trimmed = text.trim();
        if (!trimmed) return null;
        if (!containsChinese(trimmed)) return trimmed;

        const cached = this.getCachedValue(trimmed);
        if (cached !== undefined) {
            return cached;
        }

        if (this.provider instanceof FreeGtxTranslationProvider && this.provider.isRateLimitTripped()) {
            return null;
        }

        // Check fast complete glossary translation first
        const glossaryAttempt = applyGlossaryTranslation(trimmed);
        if (!containsChinese(glossaryAttempt) && this.provider instanceof FreeGtxTranslationProvider) {
            this.setCachedValue(trimmed, glossaryAttempt);
            return glossaryAttempt;
        }

        try {
            const translated = (await this.callWithConcurrencyAndRetry(() => this.provider.translateText(trimmed))).trim();
            if (!translated || translated === trimmed) {
                // Translation failed: return null (do NOT return Chinese text as English translation) and do NOT cache
                return null;
            }
            if (this.isCompleteTranslation(trimmed, translated)) {
                this.setCachedValue(trimmed, translated);
            }
            return translated;
        } catch {
            // Return null when translation fails and NEVER cache
            return null;
        }
    }

    /**
     * Translates a batch of strings in as few provider requests as possible,
     * returning the translated strings (`null` for any failed translation) and an aggregate `TranslationStatus`.
     */
    public async translateBatchWithStatus(
        texts: Array<string | null | undefined>,
    ): Promise<{ results: Array<string | null>; status: TranslationStatus }> {
        if (!this.enabled) {
            return {
                results: texts.map(() => null),
                status: 'disabled',
            };
        }

        const results: Array<string | null> = new Array(texts.length).fill(null);
        const uncachedMap = new Map<string, number[]>();

        let chineseCount = 0;
        let fullSuccessCount = 0;
        let partialCount = 0;
        let failedCount = 0;

        for (let i = 0; i < texts.length; i++) {
            const raw = texts[i];
            if (!raw) {
                results[i] = null;
                continue;
            }
            const trimmed = raw.trim();
            if (!trimmed) {
                results[i] = null;
                continue;
            }
            if (!containsChinese(trimmed)) {
                results[i] = trimmed;
                continue;
            }

            chineseCount += 1;
            const cached = this.getCachedValue(trimmed);
            if (cached !== undefined) {
                results[i] = cached;
                fullSuccessCount += 1;
                continue;
            }

            if (this.provider instanceof FreeGtxTranslationProvider && !this.provider.isRateLimitTripped()) {
                const glossaryAttempt = applyGlossaryTranslation(trimmed);
                if (!containsChinese(glossaryAttempt)) {
                    this.setCachedValue(trimmed, glossaryAttempt);
                    results[i] = glossaryAttempt;
                    fullSuccessCount += 1;
                    continue;
                }
            }

            const existingIndices = uncachedMap.get(trimmed);
            if (existingIndices) {
                existingIndices.push(i);
            } else {
                uncachedMap.set(trimmed, [i]);
            }
        }

        const uniqueUncached = Array.from(uncachedMap.keys());
        if (uniqueUncached.length > 0) {
            let batchOutputs: Array<string | null>;
            if (typeof this.provider.translateBatch === 'function') {
                try {
                    batchOutputs = await this.callWithConcurrencyAndRetry(() =>
                        this.provider.translateBatch!(uniqueUncached),
                    );
                } catch {
                    batchOutputs = new Array(uniqueUncached.length).fill(null);
                }
            } else {
                batchOutputs = await Promise.all(
                    uniqueUncached.map(async (txt) => {
                        try {
                            return await this.callWithConcurrencyAndRetry(() => this.provider.translateText(txt));
                        } catch {
                            return null;
                        }
                    }),
                );
            }

            for (let u = 0; u < uniqueUncached.length; u++) {
                const orig = uniqueUncached[u];
                const rawTranslated = (batchOutputs[u] ?? '').trim();
                const indices = uncachedMap.get(orig) ?? [];

                if (!rawTranslated || rawTranslated === orig) {
                    // Failed: set null (never return Chinese text as English translation) and NEVER cache
                    for (const idx of indices) {
                        results[idx] = null;
                        failedCount += 1;
                    }
                } else if (this.isCompleteTranslation(orig, rawTranslated)) {
                    this.setCachedValue(orig, rawTranslated);
                    for (const idx of indices) {
                        results[idx] = rawTranslated;
                        fullSuccessCount += 1;
                    }
                } else {
                    // Partial translation (still has some CJK): do NOT cache
                    for (const idx of indices) {
                        results[idx] = rawTranslated;
                        partialCount += 1;
                    }
                }
            }
        }

        const isGtxTripped =
            this.provider instanceof FreeGtxTranslationProvider && this.provider.isRateLimitTripped();
        let status: TranslationStatus = 'ok';
        if (chineseCount > 0) {
            if (failedCount === chineseCount || (isGtxTripped && failedCount > 0)) {
                status = 'failed';
            } else if (failedCount > 0 || partialCount > 0) {
                status = 'partial';
            } else {
                status = 'ok';
            }
        }

        return { results, status };
    }

    public async translateAttributes(attributes: Record<string, string>): Promise<Record<string, string>> {
        if (!this.enabled || !attributes || Object.keys(attributes).length === 0) {
            return {};
        }

        const entries = Object.entries(attributes);
        const flatTexts: string[] = [];
        for (const [k, v] of entries) {
            flatTexts.push(k, v);
        }

        const { results } = await this.translateBatchWithStatus(flatTexts);
        const result: Record<string, string> = {};
        for (let i = 0; i < entries.length; i++) {
            const [rawKey, rawVal] = entries[i];
            const keyEn = results[i * 2] ?? rawKey;
            const valEn = results[i * 2 + 1] ?? rawVal;
            result[keyEn] = valEn;
        }
        return result;
    }

    public getCacheSize(): number {
        let total = 0;
        for (const shard of this.shards.values()) {
            total += shard.size;
        }
        return total;
    }

    public getShardCount(): number {
        return this.shards.size;
    }
}
