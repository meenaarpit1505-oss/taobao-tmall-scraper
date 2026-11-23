/**
 * Parses Taobao/Tmall sales band strings such as:
 * - "1万+" -> 10000
 * - "2.5万+人付款" -> 25000
 * - "500+" -> 500
 * - "已售 1000+" -> 1000
 * - "月销 3000" -> 3000
 * - "10万+" -> 100000
 * - "0人付款" -> 0
 * Returns the lower-bound integer count or null if unparseable.
 */
export function parseSalesCount(salesText: string | null | undefined): number | null {
    if (!salesText || typeof salesText !== 'string') return null;
    const cleaned = salesText.replace(/,/g, '').trim();
    if (!cleaned) return null;

    // Strip time-window prefixes/clauses such as "近30天", "最近7天", "24小时内", "过去1个月", "365天内"
    const withoutTimeWindow = cleaned
        .replace(/(?:最近|近|过去|超)?\s*\d+\s*(?:天|日|小时|周|个?月|年)(?:内)?/g, ' ')
        .trim();
    const target = withoutTimeWindow || cleaned;

    // Match Chinese ten-thousand (万) or hundred-million (亿) units
    const wanMatch = target.match(/(\d+(?:\.\d+)?)\s*万/);
    if (wanMatch) {
        const num = parseFloat(wanMatch[1]);
        if (!Number.isNaN(num)) {
            return Math.round(num * 10000);
        }
    }

    const yiMatch = target.match(/(\d+(?:\.\d+)?)\s*亿/);
    if (yiMatch) {
        const num = parseFloat(yiMatch[1]);
        if (!Number.isNaN(num)) {
            return Math.round(num * 100000000);
        }
    }

    // Match English 'k' / 'w' shorthand sometimes returned in JSON feeds
    const kMatch = target.match(/(\d+(?:\.\d+)?)\s*[kK]\b/);
    if (kMatch) {
        const num = parseFloat(kMatch[1]);
        if (!Number.isNaN(num)) {
            return Math.round(num * 1000);
        }
    }

    const wMatch = target.match(/(\d+(?:\.\d+)?)\s*[wW]\b/);
    if (wMatch) {
        const num = parseFloat(wMatch[1]);
        if (!Number.isNaN(num)) {
            return Math.round(num * 10000);
        }
    }

    // Plain integer or decimal number
    const numMatch = target.match(/(\d+(?:\.\d+)?)/);
    if (numMatch) {
        const num = parseFloat(numMatch[1]);
        if (!Number.isNaN(num)) {
            return Math.floor(num);
        }
    }

    return null;
}

/**
 * Normalizes protocol-relative URLs (e.g. "//img.alicdn.com/...") to "https://..."
 */
export function normalizeUrl(url: string | null | undefined): string | null {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('//')) {
        return `https:${trimmed}`;
    }
    if (!/^https?:\/\//i.test(trimmed)) {
        return `https://${trimmed.replace(/^\/+/, '')}`;
    }
    return trimmed;
}

/**
 * Parses a price string or number into a clean number (or null).
 * Handles ranges like "19.90-39.90" by returning the lower bound when extractMin=true.
 */
export function parsePriceNumber(val: unknown, extractMin = true): number | null {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number') {
        return Number.isFinite(val) && val >= 0 ? Math.round(val * 100) / 100 : null;
    }
    if (typeof val !== 'string') return null;
    const cleaned = val.replace(/[¥￥,\s]/g, '').trim();
    if (!cleaned) return null;

    if (cleaned.includes('-')) {
        if (!extractMin) return null;
        const parts = cleaned.split('-').map((p) => parseFloat(p.trim())).filter((n) => Number.isFinite(n) && n >= 0);
        if (parts.length > 0) {
            return Math.round(Math.min(...parts) * 100) / 100;
        }
        return null;
    }

    const parsed = parseFloat(cleaned);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed * 100) / 100;
}

/**
 * Masks any personal buyer/reviewer nickname to ensure zero PII is stored.
 * e.g. "张三丰123" -> "张***3", "ab" -> "a***"
 */
export function maskPersonalName(name: string | null | undefined): string {
    if (!name || typeof name !== 'string') return '***';
    const trimmed = name.trim();
    if (trimmed.length <= 1) return '***';
    if (trimmed.length === 2) return `${trimmed[0]}***`;
    return `${trimmed[0]}***${trimmed[trimmed.length - 1]}`;
}

/**
 * Sanitizes text to strip any accidentally embedded reviewer/buyer patterns.
 */
export function sanitizeNoPiiText(text: string | null | undefined): string | null {
    if (text === null || text === undefined) return null;
    return text.replace(/(?:买家|用户|评论者)[:：]\s*([^\s,，。]+)/g, (_m, nick: string) => `用户:${maskPersonalName(nick)}`);
}

/**
 * Computes data completeness (0-100) and lists missing fields on a product record.
 */
export function computeDataCompleteness(record: {
    itemId?: string | null;
    title?: string | null;
    price?: number | null;
    mainImage?: string | null;
    images?: string[];
    skus?: unknown[];
    attributes?: Record<string, string>;
    shopName?: string | null;
    salesText?: string | null;
    stock?: number | null;
    brand?: string | null;
    categoryPath?: string | null;
    shipFrom?: string | null;
}): { dataCompleteness: number; missingFields: string[] } {
    const checks: Array<{ field: string; weight: number; present: boolean }> = [
        { field: 'itemId', weight: 10, present: Boolean(record.itemId) },
        { field: 'title', weight: 15, present: Boolean(record.title && record.title.trim()) },
        { field: 'price', weight: 15, present: record.price !== null && record.price !== undefined },
        { field: 'mainImage', weight: 10, present: Boolean(record.mainImage) },
        { field: 'images', weight: 8, present: Array.isArray(record.images) && record.images.length > 0 },
        { field: 'skus', weight: 12, present: Array.isArray(record.skus) && record.skus.length > 0 },
        { field: 'attributes', weight: 8, present: Boolean(record.attributes && Object.keys(record.attributes).length > 0) },
        { field: 'shopName', weight: 8, present: Boolean(record.shopName) },
        { field: 'salesText', weight: 4, present: Boolean(record.salesText) },
        { field: 'stock', weight: 4, present: record.stock !== null && record.stock !== undefined },
        { field: 'brand', weight: 2, present: Boolean(record.brand) },
        { field: 'categoryPath', weight: 2, present: Boolean(record.categoryPath) },
        { field: 'shipFrom', weight: 2, present: Boolean(record.shipFrom) },
    ];

    let score = 0;
    const missingFields: string[] = [];
    for (const check of checks) {
        if (check.present) {
            score += check.weight;
        } else {
            missingFields.push(check.field);
        }
    }

    return {
        dataCompleteness: Math.min(100, Math.max(0, score)),
        missingFields,
    };
}

/**
 * Computes data completeness (0-100) and lists missing fields on a shop summary record.
 */
export function computeShopCompleteness(shop: {
    shopId?: string | null;
    shopName?: string | null;
    shopUrl?: string | null;
    sellerScores?: unknown | null;
    creditLevel?: string | null;
    shopAgeYears?: number | null;
    shopProductCount?: number | null;
    shipFrom?: string | null;
    catalogueItemIds?: string[];
}): { dataCompleteness: number; missingFields: string[] } {
    const checks: Array<{ field: string; weight: number; present: boolean }> = [
        { field: 'shopId', weight: 15, present: Boolean(shop.shopId) },
        { field: 'shopName', weight: 20, present: Boolean(shop.shopName && shop.shopName.trim()) },
        { field: 'shopUrl', weight: 15, present: Boolean(shop.shopUrl) },
        { field: 'shopCatalogueItemIds', weight: 15, present: Array.isArray(shop.catalogueItemIds) && shop.catalogueItemIds.length > 0 },
        { field: 'sellerScores', weight: 10, present: Boolean(shop.sellerScores) },
        { field: 'creditLevel', weight: 8, present: Boolean(shop.creditLevel) },
        { field: 'shopAgeYears', weight: 7, present: shop.shopAgeYears !== null && shop.shopAgeYears !== undefined },
        { field: 'shopProductCount', weight: 5, present: shop.shopProductCount !== null && shop.shopProductCount !== undefined },
        { field: 'shipFrom', weight: 5, present: Boolean(shop.shipFrom) },
    ];

    let score = 0;
    const missingFields: string[] = [];
    for (const check of checks) {
        if (check.present) {
            score += check.weight;
        } else {
            missingFields.push(check.field);
        }
    }

    return {
        dataCompleteness: Math.min(100, Math.max(0, score)),
        missingFields,
    };
}
