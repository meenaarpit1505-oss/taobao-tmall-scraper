export type DebugProbeUrlType =
    | 'warmup'
    | 'mtop_detail'
    | 'mtop_search'
    | 'mtop_shop'
    | 'product_detail'
    | 'search'
    | 'category'
    | 'shop'
    | 'short_link'
    | 'playwright'
    | 'other';

export interface DebugProbeEntry {
    timestamp: string;
    url: string;
    urlType: DebugProbeUrlType;
    statusCode: number;
    proxyGroup: string;
    proxyCountry: string | null;
    cookiesPresent: string[];
    responseSize: number;
    bodyPreview: string;
}

export interface DebugProbeReport {
    generatedAt: string;
    totalRequests: number;
    totalRequestsRecorded: number;
    proxyGroup: string;
    proxyCountry: string | null;
    requests: DebugProbeEntry[];
}

const COOKIE_ATTRIBUTE_NAMES = new Set([
    'path',
    'domain',
    'expires',
    'max-age',
    'maxage',
    'secure',
    'httponly',
    'samesite',
    'priority',
    'partitioned',
    'version',
]);

/**
 * Extracts ONLY cookie names from Cookie headers, Set-Cookie arrays, or cookie maps.
 * Never returns cookie values or tokens.
 */
export function extractCookieNamesOnly(
    ...rawArgs: Array<
        | string
        | string[]
        | Record<string, string>
        | Array<string | string[] | Record<string, string> | undefined | null>
        | undefined
        | null
    >
): string[] {
    const sources: Array<string | string[] | Record<string, string> | undefined | null> =
        rawArgs.length === 1 && Array.isArray(rawArgs[0]) && rawArgs[0].some((x) => Array.isArray(x) || typeof x === 'object')
            ? (rawArgs[0] as Array<string | string[] | Record<string, string> | undefined | null>)
            : (rawArgs as Array<string | string[] | Record<string, string> | undefined | null>);
    const names = new Set<string>();

    const addFromCookieString = (raw: string, isSetCookie: boolean): void => {
        if (!raw || typeof raw !== 'string') return;
        const segments = raw.split(';');
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i]!.trim();
            if (!segment) continue;
            // In Set-Cookie headers, only the first segment is the cookie name=value pair;
            // subsequent segments are attributes (Path, Domain, SameSite, etc.).
            if (isSetCookie && i > 0) break;
            const eqIdx = segment.indexOf('=');
            if (eqIdx <= 0) continue;
            const rawName = segment.slice(0, eqIdx).trim();
            if (!rawName) continue;
            if (COOKIE_ATTRIBUTE_NAMES.has(rawName.toLowerCase())) continue;
            if (/^[A-Za-z0-9_.-]+$/.test(rawName)) {
                names.add(rawName);
            }
        }
    };

    for (const source of sources) {
        if (!source) continue;
        if (typeof source === 'string') {
            addFromCookieString(source, false);
        } else if (Array.isArray(source)) {
            for (const item of source) {
                if (typeof item === 'string') {
                    // Could be a Set-Cookie line or a bare cookie name
                    if (item.includes('=')) {
                        addFromCookieString(item, true);
                    } else if (/^[A-Za-z0-9_.-]+$/.test(item.trim()) && !COOKIE_ATTRIBUTE_NAMES.has(item.trim().toLowerCase())) {
                        names.add(item.trim());
                    }
                }
            }
        } else if (typeof source === 'object') {
            for (const key of Object.keys(source)) {
                const cleanKey = key.trim();
                if (cleanKey && /^[A-Za-z0-9_.-]+$/.test(cleanKey) && !COOKIE_ATTRIBUTE_NAMES.has(cleanKey.toLowerCase())) {
                    names.add(cleanKey);
                }
            }
        }
    }

    return [...names].sort();
}

/**
 * Redacts sensitive query params or credentials from a URL before storing in DEBUG_PROBE.
 */
export function sanitizeProbeUrl(rawUrl: string): string {
    if (!rawUrl) return '';
    try {
        const parsed = new URL(rawUrl);
        parsed.username = '';
        parsed.password = '';
        for (const key of [...parsed.searchParams.keys()]) {
            if (/^(sign|token|_m_h5_tk|_m_h5_tk_enc|cookie|cookies|sessionid|access_token|auth)$/i.test(key)) {
                parsed.searchParams.set(key, '[REDACTED]');
            }
        }
        return parsed.toString();
    } catch {
        return rawUrl.replace(/(sign|_m_h5_tk|_m_h5_tk_enc|token|cookie)=[^&\s]+/gi, '$1=[REDACTED]');
    }
}

/**
 * Scrubs any cookie values or MTOP tokens from a response body and returns at most `maxLength` chars.
 */
export function sanitizeBodyPreview(body: string, maxLength = 500): string {
    if (!body) return '';
    const scrubbed = body
        .replace(
            /\b(_m_h5_tk|_m_h5_tk_enc|cookie2|cna|isg|tfstk|x5secdata|x5sec|_tb_token_|unb|sgcookie|uc1|uc3|uc4|lgc|tracknick)=[^;\s"'&<>]+/gi,
            '$1=[REDACTED]',
        )
        .replace(
            /(["'](?:_m_h5_tk|_m_h5_tk_enc|cookie2|cna|isg|tfstk|x5secdata|x5sec|_tb_token_|token|sign)["']\s*:\s*["'])[^"']+(["'])/gi,
            '$1[REDACTED]$2',
        )
        .replace(/\b[a-z0-9]{20,64}_\d{10,15}\b/gi, '[REDACTED_H5_TOKEN]');
    return scrubbed.slice(0, maxLength);
}

/**
 * Infers the URL type for DEBUG_PROBE classification.
 */
export function inferDebugProbeUrlType(url: string, explicitType?: DebugProbeUrlType): DebugProbeUrlType {
    if (explicitType) return explicitType;
    const lower = url.toLowerCase();
    if (lower.includes('eg.js') || lower.includes('gettimestamp') || lower.includes('baichuan.smb.get')) {
        return 'warmup';
    }
    if (lower.includes('/h5/mtop.')) {
        if (lower.includes('detail') || lower.includes('seopdp')) return 'mtop_detail';
        if (lower.includes('shop')) return 'mtop_shop';
        return 'mtop_search';
    }
    if (/https?:\/\/(?:e|m|s)?\.?tb\.cn\//i.test(lower)) {
        return 'short_link';
    }
    if (lower.includes('/dianpu/') || /shop\d+\./i.test(lower) || lower.includes('/search.htm')) {
        return 'shop';
    }
    if (lower.includes('/category/') || lower.includes('cat=')) {
        return 'category';
    }
    if (lower.includes('/product/') || lower.includes('s.taobao.com/search') || lower.includes('q=')) {
        return 'search';
    }
    if (lower.includes('/item/') || lower.includes('/item.htm') || lower.includes('/detail.htm') || lower.includes('/detail.html')) {
        return 'product_detail';
    }
    return 'other';
}

export class DebugProbeCollector {
    private readonly entries: DebugProbeEntry[] = [];
    private readonly maxEntries: number;
    private defaultProxyGroup: string;
    private defaultProxyCountry: string | null;

    constructor(options?: { maxEntries?: number; proxyGroup?: string; proxyCountry?: string | null }) {
        this.maxEntries = options?.maxEntries ?? 500;
        this.defaultProxyGroup = options?.proxyGroup ?? 'NONE';
        this.defaultProxyCountry = options?.proxyCountry ?? null;
    }

    setProxyMetadata(proxyGroup: string, proxyCountry: string | null): void {
        this.defaultProxyGroup = proxyGroup;
        this.defaultProxyCountry = proxyCountry;
    }

    record(params: {
        url: string;
        urlType?: DebugProbeUrlType;
        statusCode: number;
        proxyGroup?: string;
        proxyCountry?: string | null;
        cookieSources?: Array<string | string[] | Record<string, string> | undefined | null>;
        cookiesPresent?: string[];
        body: string;
        responseSize?: number;
    }): void {
        if (this.entries.length >= this.maxEntries) return;

        const cookiesPresent = extractCookieNamesOnly([
            ...(params.cookieSources ?? []),
            params.cookiesPresent ?? [],
        ]);
        const bodyStr = typeof params.body === 'string' ? params.body : String(params.body ?? '');

        this.entries.push({
            timestamp: new Date().toISOString(),
            url: sanitizeProbeUrl(params.url),
            urlType: inferDebugProbeUrlType(params.url, params.urlType),
            statusCode: params.statusCode,
            proxyGroup: params.proxyGroup ?? this.defaultProxyGroup,
            proxyCountry: params.proxyCountry !== undefined ? params.proxyCountry : this.defaultProxyCountry,
            cookiesPresent,
            responseSize: params.responseSize ?? Buffer.byteLength(bodyStr, 'utf8'),
            bodyPreview: sanitizeBodyPreview(bodyStr, 500),
        });
    }

    getEntries(): DebugProbeEntry[] {
        return [...this.entries];
    }

    getReport(): DebugProbeReport {
        return {
            generatedAt: new Date().toISOString(),
            totalRequests: this.entries.length,
            totalRequestsRecorded: this.entries.length,
            proxyGroup: this.defaultProxyGroup,
            proxyCountry: this.defaultProxyCountry,
            requests: [...this.entries],
        };
    }
}
