import * as cheerio from 'cheerio';
import type { TaobaoH5Client } from '../h5Client.js';
import { resolveKnownShopIdFromDomain } from '../itemSlugRegistry.js';
import { detectPlatformFromUrl, extractItemIdFromUrl } from '../router.js';
import type {
    DataSourceResult,
    PartialProductData,
    PlatformType,
    SellerScores,
    ShopCatalogueSource,
} from '../types.js';
import { normalizeUrl, parsePriceNumber, parseSalesCount, sanitizeNoPiiText } from '../utils.js';
import { extractIceAppContext, mapSearchJsonItem, parseWorldTaobaoSearchHtml } from './searchSource.js';

/**
 * Builds the paginated shop product list URL for a given page number.
 */
export function buildShopPaginationUrl(shopUrl: string, page: number): string {
    const parsed = new URL(shopUrl.startsWith('//') ? `https:${shopUrl}` : shopUrl);
    if (!parsed.pathname.includes('search.htm') && !parsed.pathname.includes('category.htm')) {
        parsed.pathname = '/search.htm';
    }
    parsed.searchParams.set('search', 'y');
    parsed.searchParams.set('pageNo', String(Math.max(1, page)));
    return parsed.toString();
}

/**
 * Parses a Taobao/Tmall shop HTML page (including `world.taobao.com/dianpu/<shopId>.htm` SSR `__ICE_APP_CONTEXT__`,
 * `__INITIAL_DATA__`, or `search.htm` DOM cards) into shop metadata and catalogue items.
 */
export function parseShopHtml(
    html: string,
    shopUrl: string,
    fallbackShopId?: string,
): {
    shopInfo: Partial<PartialProductData>;
    items: PartialProductData[];
    hasNextPage: boolean;
} {
    const cleanHtml = html.replace(/\\"/g, '"').replace(/\\\//g, '/');

    // 0. Check for world.taobao.com SSR `window.__ICE_APP_CONTEXT__` (`shop-pc` / `shop` route)
    const iceContext = extractIceAppContext(html) ?? extractIceAppContext(cleanHtml);
    if (iceContext && iceContext.loaderData && typeof iceContext.loaderData === 'object') {
        for (const loaderEntry of Object.values(iceContext.loaderData as Record<string, unknown>)) {
            if (!loaderEntry || typeof loaderEntry !== 'object') continue;
            const dataNode = (loaderEntry as Record<string, unknown>).data as Record<string, unknown> | undefined;
            const httpData = dataNode?.httpData as Record<string, unknown> | undefined;
            if (!httpData) continue;

            const shopListModule = httpData.shopListModuleResponse as Record<string, unknown> | undefined;
            const shopList = shopListModule?.shopList as Array<Record<string, unknown>> | undefined;
            const firstShop = Array.isArray(shopList) && shopList.length > 0 ? shopList[0] : undefined;

            const itemListModule = httpData.itemListModuleResponse as Record<string, unknown> | undefined;
            const rawItemList = itemListModule?.itemList as Array<Record<string, unknown>> | undefined;

            if (firstShop || (Array.isArray(rawItemList) && rawItemList.length > 0)) {
                const resolvedShopId =
                    (firstShop?.shopId !== undefined ? String(firstShop.shopId) : undefined) ??
                    (rawItemList?.[0]?.shopId !== undefined ? String(rawItemList[0].shopId) : undefined) ??
                    fallbackShopId ??
                    null;
                const rawName =
                    (typeof firstShop?.shopName === 'string' ? firstShop.shopName : undefined) ??
                    (typeof rawItemList?.[0]?.shopName === 'string' ? rawItemList[0].shopName : undefined) ??
                    null;
                const shopName = sanitizeNoPiiText(rawName);
                const isTmall =
                    shopUrl.includes('tmall.') ||
                    Boolean(shopName && /旗舰店|旗艦店|专卖店|專賣店|专营店|專營店|官方/.test(shopName));
                const platform: PlatformType = isTmall ? 'tmall' : detectPlatformFromUrl(shopUrl);

                const descScore = parsePriceNumber(firstShop?.descriptionMatchScore);
                const servScore = parsePriceNumber(firstShop?.serviceScore);
                const delivScore = parsePriceNumber(firstShop?.deliverScore);
                const hasIceScores = descScore !== null || servScore !== null || delivScore !== null;

                const canonicalShopUrl = resolvedShopId
                    ? `https://shop${resolvedShopId}.taobao.com`
                    : normalizeUrl(shopUrl);

                const shopInfo: Partial<PartialProductData> = {
                    platform,
                    shopId: resolvedShopId,
                    shopName,
                    shopType: platform,
                    shopUrl: canonicalShopUrl,
                    sellerScores: hasIceScores
                        ? {
                              description: descScore,
                              service: servScore,
                              logistics: delivScore,
                          }
                        : null,
                    creditLevel: null,
                    shopAgeYears: null,
                    shopProductCount: Array.isArray(rawItemList) ? rawItemList.length : null,
                };

                const items: PartialProductData[] = [];
                const seenIds = new Set<string>();
                if (Array.isArray(rawItemList)) {
                    for (const rawItem of rawItemList) {
                        if (!rawItem || typeof rawItem !== 'object') continue;
                        const mapped = mapSearchJsonItem(rawItem);
                        if (mapped && !seenIds.has(mapped.itemId)) {
                            seenIds.add(mapped.itemId);
                            items.push({
                                ...mapped,
                                ...shopInfo,
                                ...(mapped.sellerScores && !shopInfo.sellerScores
                                    ? { sellerScores: mapped.sellerScores }
                                    : {}),
                            });
                        }
                    }
                }

                return {
                    shopInfo,
                    items,
                    // world.taobao.com/dianpu/<shopId>.htm returns the full SSR batch (up to 60 items) on page 1
                    hasNextPage: false,
                };
            }
        }
    }

    const $ = cheerio.load(cleanHtml);
    const platform: PlatformType = detectPlatformFromUrl(shopUrl);

    // 1. Extract shop metadata
    const shopIdMatch =
        cleanHtml.match(/["']?shopId["']?\s*[:=]\s*["']?(\d{4,20})["']?/i) ||
        shopUrl.match(/shop(\d+)\./i) ||
        shopUrl.match(/\/dianpu\/(\d+)/i);
    const shopId = shopIdMatch?.[1] ?? fallbackShopId ?? null;

    const rawShopName =
        $('.slogo-shopname, .shop-name, .tb-shop-name a, [class*="ShopHeader--shopName"], title')
            .first()
            .text()
            .replace(/[-_]\s*(?:淘宝网|天猫|Taobao|Tmall).*$/i, '')
            .trim() || null;
    const shopName = sanitizeNoPiiText(rawShopName);

    const sellerScores: SellerScores = { description: null, service: null, logistics: null };
    $('.shopdsr-item, .dsr-item, .tb-shop-rate dl, [class*="dsr"]').each((_, el) => {
        const text = $(el).text().trim();
        const numMatch = text.match(/(\d\.\d{1,2})/);
        if (!numMatch) return;
        const val = parseFloat(numMatch[1]!);
        if (text.includes('描') || text.includes('宝贝')) sellerScores.description = val;
        else if (text.includes('服') || text.includes('态度')) sellerScores.service = val;
        else if (text.includes('物') || text.includes('发货')) sellerScores.logistics = val;
    });
    const hasScores =
        sellerScores.description !== null || sellerScores.service !== null || sellerScores.logistics !== null;

    const creditLevel =
        $('.shop-rank, .tb-shop-rank, [class*="creditLevel"]').first().attr('title') ||
        $('.shop-rank, .tb-shop-rank, [class*="creditLevel"]').first().text().trim() ||
        null;

    const ageText = $('.tm-shop-age-num, .shop-year, .tb-shop-age').first().text().trim();
    const ageMatch = ageText.match(/(\d+)/);
    const shopAgeYears = ageMatch ? Number(ageMatch[1]) : null;

    const totalCountText = $('.search-result span, .total-count, [class*="shopProductCount"]').first().text().trim();
    const countMatch = totalCountText.match(/(\d+)/);
    const shopProductCount = countMatch ? Number(countMatch[1]) : null;

    const shopInfo: Partial<PartialProductData> = {
        platform,
        shopId,
        shopName,
        shopType: platform === 'tmall' ? 'tmall' : 'taobao',
        shopUrl: normalizeUrl(shopUrl),
        sellerScores: hasScores ? sellerScores : null,
        creditLevel,
        shopAgeYears,
        shopProductCount,
    };

    // 2. Extract catalogue items
    const items: PartialProductData[] = [];
    const seenIds = new Set<string>();

    // Check embedded JSON first if present
    const embeddedJsonMatch = cleanHtml.match(/window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/i);
    if (embeddedJsonMatch?.[1]) {
        try {
            const parsed = JSON.parse(embeddedJsonMatch[1]) as Record<string, unknown>;
            const rawItems = (parsed.itemsArray ?? parsed.items ?? (parsed.data as Record<string, unknown>)?.items) as
                | unknown[]
                | undefined;
            if (Array.isArray(rawItems)) {
                for (const raw of rawItems) {
                    if (raw && typeof raw === 'object') {
                        const mapped = mapSearchJsonItem(raw as Record<string, unknown>);
                        if (mapped && !seenIds.has(mapped.itemId)) {
                            seenIds.add(mapped.itemId);
                            items.push({
                                ...mapped,
                                ...shopInfo,
                            });
                        }
                    }
                }
            }
        } catch {
            // Fall through to Cheerio cards
        }
    }

    $('dl.item, .J_TItems .item, [data-id], [data-itemid], .item-card, .product').each((_, el) => {
        const $el = $(el);
        const attrId = $el.attr('data-id') || $el.attr('data-itemid');
        const href =
            $el.find('a.item-name, a.J_TGoldData, a[href*="item.htm"], a[href*="detail.tmall"]').first().attr('href') ||
            $el.find('a').first().attr('href') ||
            '';
        const itemId =
            (attrId && /^\d{5,20}$/.test(attrId.trim()) ? attrId.trim() : null) ?? extractItemIdFromUrl(href);
        if (!itemId || seenIds.has(itemId)) return;
        seenIds.add(itemId);

        const title =
            sanitizeNoPiiText(
                $el.find('a.item-name, .title, .desc a, h3, img').first().text().trim() ||
                    $el.find('img').first().attr('alt')?.trim() ||
                    '',
            ) ?? '';

        const priceText = $el.find('.c-price, .s-price, .price strong, .price').first().text().trim();
        const price = parsePriceNumber(priceText);

        const salesText = $el.find('.sale-num, .sold-num, .deal-cnt').first().text().trim() || null;
        const salesCount = parseSalesCount(salesText);

        const imgSrc =
            $el.find('img').first().attr('data-ks-lazyload') ||
            $el.find('img').first().attr('data-src') ||
            $el.find('img').first().attr('src');
        const mainImage = normalizeUrl(imgSrc);

        const itemUrl =
            normalizeUrl(href) ??
            (platform === 'tmall'
                ? `https://detail.tmall.com/item.htm?id=${itemId}`
                : `https://item.taobao.com/item.htm?id=${itemId}`);

        items.push({
            itemId,
            url: itemUrl,
            platform,
            title,
            mainImage,
            images: mainImage ? [mainImage] : [],
            price,
            originalPrice: price,
            promoPrice: null,
            salesText,
            salesCount,
            ...shopInfo,
            isDetailFetched: false,
        });
    });

    const hasNextPage =
        items.length >= 16 ||
        $('a.next, .pagination a.next, .ui-page-next').length > 0;

    return {
        shopInfo,
        items,
        hasNextPage,
    };
}

/**
 * Layered Shop Catalogue Source:
 * 1. Primary: `world.taobao.com/dianpu/<shopId>.htm` (overseas SSR `shop-pc` route) + Shop storefront `/search.htm`
 * 2. Fallback: MTOP H5 shop search (`mtop.taobao.wsearch.appsearch`)
 */
export class LayeredShopCatalogueSource implements ShopCatalogueSource {
    public readonly name = 'LayeredShopCatalogueSource';
    private readonly h5Client: TaobaoH5Client;

    constructor(h5Client: TaobaoH5Client) {
        this.h5Client = h5Client;
    }

    private extractShopId(shopUrl: string, explicitShopId?: string): string | null {
        if (explicitShopId && /^\d+$/.test(explicitShopId.trim())) {
            return explicitShopId.trim();
        }
        const match =
            shopUrl.match(/shop(\d+)\./i) ||
            shopUrl.match(/\/dianpu(?:-amp)?\/(\d+)/i) ||
            shopUrl.match(/[?&]shop_?id=(\d+)/i);
        if (match?.[1]) return match[1];
        try {
            const parsed = new URL(shopUrl.startsWith('//') ? `https:${shopUrl}` : shopUrl);
            return resolveKnownShopIdFromDomain(parsed.hostname);
        } catch {
            return null;
        }
    }

    public async fetchShopCatalogue(params: {
        shopUrl: string;
        shopId?: string;
        page: number;
        maxItems: number;
    }): Promise<
        DataSourceResult<{
            shopInfo: Partial<PartialProductData>;
            items: PartialProductData[];
            hasNextPage: boolean;
        }>
    > {
        let resolvedShopId = this.extractShopId(params.shopUrl, params.shopId);
        const isHttps = params.shopUrl.startsWith('https://') || params.shopUrl.startsWith('//');

        // Layer 1a: If we have a numeric shopId and HTTPS, try world.taobao.com/dianpu/<shopId>.htm SSR endpoint
        let dianpuRes: DataSourceResult<{ body: string; finalUrl: string; statusCode: number }> | null = null;
        if (resolvedShopId && isHttps && params.page === 1) {
            const dianpuUrl = `https://world.taobao.com/dianpu/${resolvedShopId}.htm`;
            dianpuRes = await this.h5Client.fetchPage(dianpuUrl, {
                referer: 'https://world.taobao.com/',
                urlType: 'shop',
            });
            if (dianpuRes.ok && dianpuRes.data) {
                const parsed = parseShopHtml(dianpuRes.data.body, params.shopUrl, resolvedShopId);
                if (parsed.items.length > 0) {
                    return {
                        ok: true,
                        data: parsed,
                    };
                }
            }
        }

        // Layer 1b: Use shop search endpoint with pageNo for ALL pages (including page 1)
        const isAlreadyDianpuUrl = /world\.taobao\.com\/(?:lang\/[a-z-]+\/)?dianpu/i.test(params.shopUrl);
        let pageRes: DataSourceResult<{ body: string; finalUrl: string; statusCode: number }> | null = dianpuRes;
        if (!isAlreadyDianpuUrl) {
            const paginatedUrl = buildShopPaginationUrl(params.shopUrl, params.page);
            pageRes = await this.h5Client.fetchPage(paginatedUrl, {
                referer: params.shopUrl,
                urlType: 'shop',
            });

            if (pageRes.ok && pageRes.data) {
                const parsed = parseShopHtml(pageRes.data.body, params.shopUrl, resolvedShopId ?? params.shopId);
                if (parsed.items.length > 0 || parsed.shopInfo.shopName) {
                    return {
                        ok: true,
                        data: parsed,
                    };
                }
            }
        }

        // Layer 1c: If shopUrl is a custom Tmall brand subdomain (e.g. brand.tmall.com) and resolvedShopId wasn't known,
        // discover its shopId via world.taobao.com/product/<brand>.htm and then fetch world.taobao.com/dianpu/<shopId>.htm
        if (!resolvedShopId && isHttps && params.page === 1) {
            try {
                const host = new URL(params.shopUrl).hostname.toLowerCase();
                const subMatch = host.match(/^([a-z0-9-]+)\.(?:tmall|taobao)\./i);
                if (subMatch?.[1]) {
                    const brandQueryUrl = `https://world.taobao.com/product/${encodeURIComponent(subMatch[1])}.htm`;
                    const brandRes = await this.h5Client.fetchPage(brandQueryUrl, {
                        referer: 'https://world.taobao.com/',
                        urlType: 'shop',
                    });
                    if (brandRes.ok && brandRes.data) {
                        const searchParsed = parseWorldTaobaoSearchHtml(brandRes.data.body);
                        const candidateShopId = searchParsed.items.find((i) => i.shopId)?.shopId ?? null;
                        if (candidateShopId) {
                            resolvedShopId = candidateShopId;
                            const discoveredDianpuUrl = `https://world.taobao.com/dianpu/${resolvedShopId}.htm`;
                            const discoveredRes = await this.h5Client.fetchPage(discoveredDianpuUrl, {
                                referer: 'https://world.taobao.com/',
                                urlType: 'shop',
                            });
                            if (discoveredRes.ok && discoveredRes.data) {
                                const parsed = parseShopHtml(discoveredRes.data.body, params.shopUrl, resolvedShopId);
                                if (parsed.items.length > 0) {
                                    return {
                                        ok: true,
                                        data: parsed,
                                    };
                                }
                            }
                        }
                    }
                }
            } catch {
                // Continue to MTOP fallback
            }
        }

        // Layer 2 fallback: MTOP H5 shop items API
        const platform = detectPlatformFromUrl(params.shopUrl);
        const mtopRes = await this.h5Client.requestMtop<Record<string, unknown>>({
            api: 'mtop.taobao.wsearch.appsearch',
            version: '1.0',
            platform,
            data: {
                shopId: resolvedShopId ?? params.shopId ?? '',
                page: String(params.page),
                n: '24',
                sort: '_coefp',
            },
        });

        if (mtopRes.ok && mtopRes.data) {
            const rawItems = (mtopRes.data.itemsArray ?? mtopRes.data.listItem ?? []) as unknown[];
            const items: PartialProductData[] = [];
            const seenIds = new Set<string>();
            for (const raw of rawItems) {
                if (raw && typeof raw === 'object') {
                    const mapped = mapSearchJsonItem(raw as Record<string, unknown>);
                    if (mapped && !seenIds.has(mapped.itemId)) {
                        seenIds.add(mapped.itemId);
                        items.push(mapped);
                    }
                }
            }
            const shopInfo: Partial<PartialProductData> = {
                platform,
                shopId: resolvedShopId ?? params.shopId ?? (mtopRes.data.shopId ? String(mtopRes.data.shopId) : null),
                shopName: mtopRes.data.shopTitle ? String(mtopRes.data.shopTitle) : items[0]?.shopName ?? null,
                shopType: platform,
                shopUrl: normalizeUrl(params.shopUrl),
                shopProductCount: mtopRes.data.totalResults ? Number(mtopRes.data.totalResults) : items.length,
            };

            if (items.length > 0 || shopInfo.shopName) {
                return {
                    ok: true,
                    data: {
                        shopInfo,
                        items,
                        hasNextPage: items.length >= 20,
                    },
                };
            }
        }

        return {
            ok: false,
            blocked: Boolean(pageRes?.blocked || dianpuRes?.blocked || mtopRes.blocked),
            errorReason:
                pageRes?.errorReason ||
                dianpuRes?.errorReason ||
                mtopRes.errorReason ||
                `Failed to extract shop catalogue from ${params.shopUrl} (page ${params.page})`,
        };
    }
}
