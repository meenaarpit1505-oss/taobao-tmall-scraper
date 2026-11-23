import { log } from 'apify';
import { getItemIdForSlug, getSlugForItemId, registerItemSlug, resolveKnownShopIdFromDomain } from './itemSlugRegistry.js';
import type { ActorInput, PlatformType, RoutedTask, SearchFilters } from './types.js';

const SHORT_LINK_HOSTS = new Set(['tb.cn', 'm.tb.cn', 'e.tb.cn', 's.tb.cn', 'uland.taobao.com']);

const ALLOWED_ROOT_DOMAINS = [
    'taobao.com',
    'tmall.com',
    'tmall.hk',
    'tb.cn',
    'm.tb.cn',
    'world.taobao.com',
    'm.intl.taobao.com',
];

export function isAllowedTaobaoTmallHost(hostname: string): boolean {
    const host = hostname.toLowerCase().trim();
    if (!host) return false;
    return ALLOWED_ROOT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

const NON_SHOP_TAOBAO_SUBDOMAINS = new Set([
    'www',
    'item',
    'detail',
    'world',
    's',
    'search',
    'list',
    'h5',
    'h5api',
    'm',
    'main',
    'login',
    'pass',
    'rate',
    'cart',
    'buy',
    'trade',
    'i',
    'my',
    'fav',
    'favorite',
    'guang',
    'ai',
    'uland',
    'err',
    'error',
    'ju',
    'chaoshi',
    'pages',
    'market',
]);

/**
 * Validates raw Actor input and throws a descriptive error if invalid.
 */
export function validateAndNormalizeInput(rawInput: unknown): Required<
    Pick<
        ActorInput,
        | 'maxItemsPerQuery'
        | 'includeDetails'
        | 'includeShopInfo'
        | 'translateToEnglish'
        | 'currency'
        | 'monitoringMode'
        | 'agentLinks'
        | 'maxConcurrency'
    >
> &
    ActorInput {
    if (rawInput !== null && rawInput !== undefined && typeof rawInput !== 'object') {
        throw new Error('Invalid input: Expected a JSON object.');
    }

    const input = (rawInput ?? {}) as ActorInput;

    const startUrls = Array.isArray(input.startUrls) ? input.startUrls : [];
    const itemIds = Array.isArray(input.itemIds) ? input.itemIds : [];
    const keywords = Array.isArray(input.keywords) ? input.keywords.filter((k) => typeof k === 'string' && k.trim().length > 0) : [];

    if (startUrls.length === 0 && itemIds.length === 0 && keywords.length === 0) {
        throw new Error(
            'Input validation error: Please provide at least one of "startUrls", "itemIds", or "keywords" to scrape.',
        );
    }

    // Merge top-level filter inputs (minPrice, maxPrice, tmallOnly, location, sort) with legacy searchFilters
    const hasAnyFilterField =
        input.searchFilters !== undefined ||
        input.minPrice !== undefined ||
        input.maxPrice !== undefined ||
        input.tmallOnly !== undefined ||
        input.location !== undefined ||
        input.sort !== undefined;

    const mergedFilters: SearchFilters | undefined = hasAnyFilterField
        ? {
              ...(input.searchFilters ?? {}),
              ...(input.minPrice !== undefined ? { minPrice: input.minPrice } : {}),
              ...(input.maxPrice !== undefined ? { maxPrice: input.maxPrice } : {}),
              ...(input.tmallOnly !== undefined ? { tmallOnly: input.tmallOnly } : {}),
              ...(input.location !== undefined && input.location.trim() !== ''
                  ? { location: input.location.trim() }
                  : {}),
              ...(input.sort !== undefined ? { sort: input.sort } : {}),
          }
        : undefined;

    // Validate searchFilters
    if (mergedFilters) {
        const { minPrice, maxPrice, sort } = mergedFilters;
        if (minPrice !== undefined && (typeof minPrice !== 'number' || minPrice < 0)) {
            throw new Error('Input validation error: searchFilters.minPrice must be a non-negative number.');
        }
        if (maxPrice !== undefined && (typeof maxPrice !== 'number' || maxPrice < 0)) {
            throw new Error('Input validation error: searchFilters.maxPrice must be a non-negative number.');
        }
        if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
            throw new Error('Input validation error: searchFilters.minPrice cannot be greater than searchFilters.maxPrice.');
        }
        if (sort !== undefined && !['default', 'sales', 'priceAsc', 'priceDesc'].includes(sort)) {
            throw new Error(
                `Input validation error: searchFilters.sort "${sort}" is invalid. Allowed values: default, sales, priceAsc, priceDesc.`,
            );
        }
    }

    // Validate proxy country:
    // - Top-level `proxyCountry` (default 'CN') selects the preferred residential country with HK/TW/SG/US fallbacks.
    // - If `input.proxyCountry` is not set and legacy `proxyConfiguration.apifyProxyCountry` is explicitly 'CN',
    //   keep the validation error for backward compatibility with legacy callers/tests.
    const explicitProxyCountry = typeof input.proxyCountry === 'string' && input.proxyCountry.trim()
        ? input.proxyCountry.trim().toUpperCase()
        : undefined;

    const hasCustomProxyUrls =
        Array.isArray(input.proxyConfiguration?.proxyUrls) && input.proxyConfiguration.proxyUrls.length > 0;
    const hasCustomNewUrlFn = typeof input.proxyConfiguration?.newUrlFunction === 'function';
    const proxyConfig = input.proxyConfiguration
        ? { ...input.proxyConfiguration }
        : {
              useApifyProxy: true,
              apifyProxyGroups: ['RESIDENTIAL'],
              apifyProxyCountry: explicitProxyCountry && explicitProxyCountry !== 'AUTO' ? explicitProxyCountry : 'US',
          };
    const configuredCountry = (proxyConfig.apifyProxyCountry ?? proxyConfig.countryCode)?.trim();
    if (!explicitProxyCountry && configuredCountry && ['CN', 'CHN', 'CHINA'].includes(configuredCountry.toUpperCase())) {
        throw new Error(
            'Input validation error: proxyConfiguration.apifyProxyCountry cannot be "CN" (mainland China) because world.taobao.com blocks or redirects mainland China IPs to login walls. Use "US", "SG", "HK", or "JP" instead, or set top-level "proxyCountry".',
        );
    }
    if (hasCustomProxyUrls || hasCustomNewUrlFn) {
        delete proxyConfig.apifyProxyGroups;
        delete proxyConfig.groups;
        delete proxyConfig.apifyProxyCountry;
        delete proxyConfig.countryCode;
        delete proxyConfig.apifyProxySubdivision;
        delete proxyConfig.subdivisionCode;
    } else {
        if (Array.isArray(proxyConfig.proxyUrls) && proxyConfig.proxyUrls.length === 0) {
            delete proxyConfig.proxyUrls;
        }
        if (proxyConfig.useApifyProxy) {
            const existingGroups = proxyConfig.apifyProxyGroups ?? proxyConfig.groups;
            if (!Array.isArray(existingGroups) || existingGroups.length === 0) {
                proxyConfig.apifyProxyGroups = ['RESIDENTIAL'];
            }
            if (!configuredCountry) {
                proxyConfig.apifyProxyCountry =
                    explicitProxyCountry && explicitProxyCountry !== 'AUTO' ? explicitProxyCountry : 'US';
            }
        }
    }

    const proxyCountry = explicitProxyCountry ?? 'CN';
    const maxItemsPerQuery = Math.max(1, Math.min(5000, Number(input.maxItemsPerQuery ?? 100)));
    const maxConcurrency = Math.max(1, Math.min(25, Number(input.maxConcurrency ?? 3)));
    const currency = (input.currency ?? 'USD').toUpperCase().trim();

    if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error(`Input validation error: currency "${input.currency}" must be a 3-letter ISO currency code (e.g. USD, EUR, GBP).`);
    }

    const validAgents = new Set(['superbuy', 'cssbuy', 'sugargoo', 'cnfans', 'hoobuy']);
    const agentLinks = (input.agentLinks ?? ['superbuy', 'cssbuy', 'sugargoo', 'cnfans', 'hoobuy']).filter((a) =>
        validAgents.has(a),
    );

    const mergedCookie =
        (typeof input.taobaoCookies === 'string' && input.taobaoCookies.trim()) ||
        (typeof input.cookie === 'string' && input.cookie.trim()) ||
        undefined;

    return {
        ...input,
        startUrls,
        itemIds,
        keywords,
        searchFilters: mergedFilters,
        maxItemsPerQuery,
        includeDetails: input.includeDetails ?? true,
        includeShopInfo: input.includeShopInfo ?? true,
        translateToEnglish: input.translateToEnglish ?? true,
        currency,
        monitoringMode: input.monitoringMode ?? false,
        agentLinks,
        proxyConfiguration: proxyConfig,
        maxConcurrency,
        cookie: mergedCookie,
        taobaoCookies: mergedCookie,
        enableSessionWarmup: input.enableSessionWarmup ?? true,
        enablePlaywrightFallback: input.enablePlaywrightFallback ?? true,
        proxyCountry,
    };
}

/**
 * Extracts a numeric Taobao/Tmall item ID from any supported product URL form:
 * - https://item.taobao.com/item.htm?id=1234567890
 * - https://detail.tmall.com/item.htm?id=1234567890
 * - https://detail.tmall.hk/hk/item.htm?id=1234567890
 * - https://m.intl.taobao.com/detail/detail.html?id=1234567890
 * - https://h5.m.taobao.com/awp/core/detail.htm?id=1234567890
 * - https://world.taobao.com/item/1234567890.htm
 * - https://a.m.taobao.com/i1234567890.htm
 */
export function extractWorldTaobaoSlugFromUrl(rawUrl: string): string | null {
    try {
        const parsed = new URL(rawUrl);
        const querySlug = parsed.searchParams.get('itemIdStr') || parsed.searchParams.get('item_id_str');
        if (querySlug && /^[A-Za-z0-9+/=_-]{8,80}$/.test(querySlug.trim())) {
            return querySlug.trim();
        }
        const slugMatch = parsed.pathname.match(/(?:\/lang\/[a-z-]+)?\/item(?:-amp)?\/([A-Za-z0-9+/=_-]{8,80})\.htm/i);
        if (slugMatch && !/^\d+$/.test(slugMatch[1]!)) {
            return slugMatch[1]!;
        }
        return null;
    } catch {
        return null;
    }
}

export function extractItemIdFromUrl(rawUrl: string): string | null {
    try {
        const parsed = new URL(rawUrl);
        const queryId =
            parsed.searchParams.get('id') ||
            parsed.searchParams.get('itemId') ||
            parsed.searchParams.get('item_id') ||
            parsed.searchParams.get('default_item_id');
        const querySlug = extractWorldTaobaoSlugFromUrl(rawUrl);
        if (queryId && /^\d{5,20}$/.test(queryId.trim())) {
            const cleanId = queryId.trim();
            if (querySlug) {
                registerItemSlug(cleanId, querySlug);
            }
            return cleanId;
        }

        // world.taobao.com/item/678901234567.htm
        const worldItemMatch = parsed.pathname.match(/(?:\/lang\/[a-z-]+)?\/item(?:-amp)?\/(\d{5,20})\.htm/i);
        if (worldItemMatch) {
            return worldItemMatch[1]!;
        }

        // world.taobao.com/item/RjRZL1NqR2pVTkxHOTFNTUIvZU8wZz09.htm (encrypted base64 slug)
        if (querySlug) {
            return getItemIdForSlug(querySlug) ?? querySlug;
        }

        // a.m.taobao.com/i678901234567.htm
        const mobileShortItemMatch = parsed.pathname.match(/\/i(\d{5,20})\.htm/i);
        if (mobileShortItemMatch) {
            return mobileShortItemMatch[1]!;
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Detects platform ('taobao' | 'tmall') from a URL.
 */
export function detectPlatformFromUrl(rawUrl: string): PlatformType {
    try {
        const host = new URL(rawUrl).hostname.toLowerCase();
        if (host.includes('tmall.com') || host.includes('tmall.hk')) {
            return 'tmall';
        }
        return 'taobao';
    } catch {
        return 'taobao';
    }
}

/**
 * Builds canonical and fallback URLs for a given numeric itemId.
 * Used when an ID-based page 404s so we can fall back to listing/share/overseas URL forms.
 */
export function buildItemCandidateUrls(itemId: string, preferredPlatform: PlatformType = 'taobao'): string[] {
    const cleanId = String(itemId).trim();
    const urls =
        preferredPlatform === 'tmall'
            ? [
                  `https://detail.tmall.com/item.htm?id=${cleanId}`,
                  `https://world.taobao.com/item/${cleanId}.htm`,
                  `https://m.intl.taobao.com/detail/detail.html?id=${cleanId}`,
                  `https://item.taobao.com/item.htm?id=${cleanId}`,
              ]
            : [
                  `https://item.taobao.com/item.htm?id=${cleanId}`,
                  `https://world.taobao.com/item/${cleanId}.htm`,
                  `https://m.intl.taobao.com/detail/detail.html?id=${cleanId}`,
                  `https://detail.tmall.com/item.htm?id=${cleanId}`,
              ];
    return urls;
}

/**
 * Parses a single URL string into a RoutedTask (product, short_link, shop, search, or category).
 */
export function classifyUrl(rawUrl: string, defaultFilters?: SearchFilters): RoutedTask {
    const trimmed = rawUrl.trim();
    let parsed: URL;
    try {
        parsed = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed);
    } catch {
        throw new Error(`Invalid URL in startUrls: "${rawUrl}"`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Invalid URL protocol in startUrls: "${rawUrl}"`);
    }

    const host = parsed.hostname.toLowerCase();
    if (!isAllowedTaobaoTmallHost(host)) {
        throw new Error(
            `Unsupported domain in startUrls: "${host}". Only taobao.com, tmall.com, tmall.hk, tb.cn, m.tb.cn, world.taobao.com, m.intl.taobao.com and their subdomains are accepted.`,
        );
    }

    const path = parsed.pathname.toLowerCase();
    const platform = detectPlatformFromUrl(parsed.toString());

    // 1. Short links (tb.cn, m.tb.cn, e.tb.cn, etc.)
    if (SHORT_LINK_HOSTS.has(host) || host.endsWith('.tb.cn')) {
        return {
            type: 'short_link',
            url: parsed.toString(),
            platform,
            filters: defaultFilters,
        };
    }

    // 2. Product URLs
    const itemId = extractItemIdFromUrl(parsed.toString());
    const itemSlug = extractWorldTaobaoSlugFromUrl(parsed.toString()) ?? (itemId ? getSlugForItemId(itemId) : null);
    if (
        itemId &&
        (host.startsWith('item.') ||
            host.startsWith('detail.') ||
            host.includes('m.intl.taobao.com') ||
            host.includes('h5.m.taobao.com') ||
            host.includes('a.m.taobao.com') ||
            path.includes('/item.htm') ||
            path.includes('/detail.htm') ||
            path.includes('/detail.html') ||
            /(?:\/lang\/[a-z-]+)?\/item(?:-amp)?\/[A-Za-z0-9+/=_-]+\.htm/i.test(path))
    ) {
        return {
            type: 'product',
            url: parsed.toString(),
            itemId,
            ...(itemSlug ? { itemIdStr: itemSlug } : {}),
            platform,
        };
    }

    // 3. Search URLs (including world.taobao.com/product/<keyword>.htm)
    const qParam = parsed.searchParams.get('q') || parsed.searchParams.get('keyword') || parsed.searchParams.get('key');
    const worldSearchMatch =
        parsed.pathname.match(/\/search\/([^/?#]+)/i) ||
        parsed.pathname.match(/(?:\/lang\/[a-z-]+)?\/product(?:-amp)?\/([^/?#]+)/i);
    if (
        host === 's.taobao.com' ||
        host === 'list.tmall.com' ||
        host === 's.m.taobao.com' ||
        path.includes('/search') ||
        Boolean(worldSearchMatch) ||
        qParam
    ) {
        // Check if it's actually a shop internal search (e.g. shop12345.taobao.com/search.htm)
        const shopMatch = host.match(/^shop(\d+)\.(?:m\.)?taobao\.com$/i);
        const subMatch = host.match(/^([a-z0-9-]+)\.(?:taobao\.com|tmall\.com|tmall\.hk)$/i);
        const isCustomShopHost =
            Boolean(shopMatch) ||
            (Boolean(subMatch) && !NON_SHOP_TAOBAO_SUBDOMAINS.has(subMatch![1].toLowerCase()));

        if (!isCustomShopHost) {
            const decodedKeyword = qParam
                ? qParam.trim()
                : worldSearchMatch
                  ? decodeURIComponent(worldSearchMatch[1]).replace(/\.htm$/i, '').trim()
                  : undefined;
            const catParam = parsed.searchParams.get('cat') || parsed.searchParams.get('catId');
            if (!decodedKeyword && catParam) {
                return {
                    type: 'category',
                    url: parsed.toString(),
                    categoryId: catParam,
                    platform,
                    page: 1,
                    filters: defaultFilters,
                };
            }
            return {
                type: 'search',
                url: parsed.toString(),
                keyword: decodedKeyword,
                platform,
                page: 1,
                filters: defaultFilters,
            };
        }
    }

    // 4. Category URLs (e.g. world.taobao.com/cat/..., world.taobao.com/category/..., list.taobao.com/itemlist/..., etc.)
    const catParam = parsed.searchParams.get('cat') || parsed.searchParams.get('catId') || parsed.searchParams.get('category_id');
    const worldCatMatch = path.match(/\/(?:cat|category(?:-amp)?|list)\/(\d+)/i);
    if (catParam || worldCatMatch || host === 'list.taobao.com') {
        return {
            type: 'category',
            url: parsed.toString(),
            categoryId: catParam || (worldCatMatch ? worldCatMatch[1] : undefined),
            platform,
            page: 1,
            filters: defaultFilters,
        };
    }

    // 5. Shop URLs (e.g. shop123456.taobao.com, world.taobao.com/dianpu/123456.htm, brand.tmall.com, store.taobao.com?shop_id=...)
    const shopIdParam =
        parsed.searchParams.get('shop_id') ||
        parsed.searchParams.get('shopId') ||
        parsed.searchParams.get('user_number_id');
    const shopHostMatch = host.match(/^shop(\d+)\.(?:(?:m|world)\.)?taobao\.com$/i);
    const worldDianpuMatch = path.match(/(?:\/lang\/[a-z-]+)?\/dianpu(?:-amp)?\/(\d+)\.htm/i);
    const subdomainMatch = host.match(/^([a-z0-9-]+)\.(?:taobao\.com|tmall\.com|tmall\.hk)$/i);

    if (
        shopIdParam ||
        shopHostMatch ||
        worldDianpuMatch ||
        path.includes('/shop/view_shop.htm') ||
        (subdomainMatch && !NON_SHOP_TAOBAO_SUBDOMAINS.has(subdomainMatch[1].toLowerCase()))
    ) {
        const resolvedShopId =
            shopIdParam ||
            (shopHostMatch ? shopHostMatch[1] : undefined) ||
            (worldDianpuMatch ? worldDianpuMatch[1] : undefined) ||
            resolveKnownShopIdFromDomain(host) ||
            undefined;
        return {
            type: 'shop',
            url: parsed.toString(),
            shopId: resolvedShopId,
            shopDomain: host,
            platform,
            page: 1,
        };
    }

    // If URL still has an itemId anywhere in query, treat as product
    if (itemId) {
        return {
            type: 'product',
            url: parsed.toString(),
            itemId,
            platform,
        };
    }

    throw new Error(
        `Rejected URL "${rawUrl}": URL is not a valid product, short link, search, category, or shop URL on Taobao/Tmall.`,
    );
}

/**
 * Extracts an embedded redirect target or shortened URL from a share text snippet
 * (e.g. "【淘宝】https://m.tb.cn/h.5xyz123 CZ0001 「商品名称」")
 */
export function extractUrlFromShareText(inputStr: string): string {
    const match = inputStr.match(/https?:\/\/[^\s"'<>「」【】]+/i);
    return match ? match[0] : inputStr.trim();
}

/**
 * Builds the complete initial list of RoutedTasks from mixed ActorInput
 * (startUrls, itemIds, and keywords). Invalid URLs or itemIds produce `type: 'invalid'` tasks
 * and log a warning so the run continues rather than crashing.
 */
export function buildInitialTasks(input: ActorInput): RoutedTask[] {
    const tasks: RoutedTask[] = [];
    const seenKeys = new Set<string>();

    // 1. Route startUrls
    if (Array.isArray(input.startUrls)) {
        for (const entry of input.startUrls) {
            const rawUrl = typeof entry === 'string' ? entry : entry?.url;
            if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
                const reason = 'Empty or non-string URL entry in startUrls';
                log.warning(reason);
                tasks.push({
                    type: 'invalid',
                    url: String(rawUrl ?? ''),
                    rawInput: String(rawUrl ?? ''),
                    errorReason: reason,
                });
                continue;
            }
            const extractedUrl = extractUrlFromShareText(rawUrl);
            try {
                const task = classifyUrl(extractedUrl, input.searchFilters);
                const dedupeKey =
                    task.type === 'product' && task.itemId ? `product:${task.itemId}` : `${task.type}:${task.url}`;
                if (!seenKeys.has(dedupeKey)) {
                    seenKeys.add(dedupeKey);
                    tasks.push(task);
                }
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                log.warning(`Skipping invalid startUrl "${rawUrl}": ${reason}`);
                tasks.push({
                    type: 'invalid',
                    url: extractedUrl,
                    rawInput: rawUrl,
                    errorReason: reason,
                });
            }
        }
    }

    // 2. Route itemIds
    if (Array.isArray(input.itemIds)) {
        for (const rawId of input.itemIds) {
            const itemId = String(rawId ?? '').trim();
            if (!itemId || !/^\d{5,20}$/.test(itemId)) {
                const reason = `Invalid numeric itemId "${itemId}". Expected a numeric Taobao/Tmall ID (5-20 digits).`;
                log.warning(reason);
                tasks.push({
                    type: 'invalid',
                    url: itemId,
                    itemId: itemId || 'invalid_id',
                    rawInput: itemId,
                    errorReason: reason,
                });
                continue;
            }
            const dedupeKey = `product:${itemId}`;
            if (!seenKeys.has(dedupeKey)) {
                seenKeys.add(dedupeKey);
                tasks.push({
                    type: 'product',
                    url: `https://item.taobao.com/item.htm?id=${itemId}`,
                    itemId,
                    platform: 'taobao',
                    fallbackFromId: true,
                });
            }
        }
    }

    // 3. Route keywords
    if (Array.isArray(input.keywords)) {
        for (const rawKw of input.keywords) {
            const keyword = String(rawKw).trim();
            if (!keyword) continue;
            const dedupeKey = `search:kw:${keyword}`;
            if (!seenKeys.has(dedupeKey)) {
                seenKeys.add(dedupeKey);
                const encoded = encodeURIComponent(keyword);
                tasks.push({
                    type: 'search',
                    url: `https://world.taobao.com/search/search.htm?q=${encoded}`,
                    keyword,
                    platform: input.searchFilters?.tmallOnly ? 'tmall' : 'taobao',
                    page: 1,
                    filters: input.searchFilters,
                });
            }
        }
    }

    return tasks;
}
