import * as cheerio from 'cheerio';
import type { TaobaoH5Client } from '../h5Client.js';
import { registerItemSlug } from '../itemSlugRegistry.js';
import { extractItemIdFromUrl } from '../router.js';
import type {
    DataSourceResult,
    PartialProductData,
    PlatformType,
    SearchFilters,
    SearchListingSource,
    SortOption,
} from '../types.js';
import { normalizeUrl, parsePriceNumber, parseSalesCount, sanitizeNoPiiText } from '../utils.js';

const SORT_PARAM_MAP: Record<SortOption, string> = {
    default: 'default',
    sales: 'sale-desc',
    priceAsc: 'price-asc',
    priceDesc: 'price-desc',
};

const WORLD_SEO_SORT_MAP: Record<SortOption, string> = {
    default: '',
    sales: 'sales-des',
    priceAsc: 'price-asc',
    priceDesc: 'price-des',
};

/**
 * Builds the `world.taobao.com` search or category listing URL for a given page and filter set.
 */
export function buildWorldTaobaoSearchUrl(params: {
    keyword?: string;
    searchUrl?: string;
    categoryId?: string;
    page: number;
    filters?: SearchFilters;
}): string {
    const page = Math.max(1, params.page);
    const offset = (page - 1) * 44;
    const filters = params.filters ?? {};

    let urlObj: URL;
    if (params.searchUrl && params.searchUrl.includes('world.taobao.com')) {
        urlObj = new URL(params.searchUrl);
    } else if (params.categoryId && !params.keyword) {
        urlObj = new URL(`https://world.taobao.com/cat/${encodeURIComponent(params.categoryId)}.htm`);
    } else {
        urlObj = new URL('https://world.taobao.com/search/search.htm');
    }

    if (params.keyword) {
        urlObj.searchParams.set('q', params.keyword);
    }
    if (params.categoryId) {
        urlObj.searchParams.set('cat', params.categoryId);
    }

    if (filters.sort && filters.sort !== 'default') {
        urlObj.searchParams.set('sort', SORT_PARAM_MAP[filters.sort]);
    }
    if (filters.minPrice !== undefined) {
        urlObj.searchParams.set('start_price', String(filters.minPrice));
    }
    if (filters.maxPrice !== undefined) {
        urlObj.searchParams.set('end_price', String(filters.maxPrice));
    }
    if (filters.tmallOnly) {
        urlObj.searchParams.set('tab', 'mall');
    }
    if (filters.location) {
        urlObj.searchParams.set('loc', filters.location);
    }

    urlObj.searchParams.set('page', String(page));
    if (offset > 0) {
        urlObj.searchParams.set('s', String(offset));
    }

    return urlObj.toString();
}

/**
 * Builds the SSR `world.taobao.com/product/<keyword>.htm` or `/category/<id>.htm` URL
 * (`@ali/pegasus-project-tmw-seo` `taglist-pc` route).
 */
export function buildWorldTaobaoSeoTagUrl(
    params: {
        keyword?: string;
        searchUrl?: string;
        categoryId?: string;
        page: number;
        filters?: SearchFilters;
    },
    brandIdsForPagination?: string[],
): string | null {
    const page = Math.max(1, params.page);
    const filters = params.filters ?? {};

    let baseUrl: string | null = null;
    if (params.keyword && params.keyword.trim()) {
        baseUrl = `https://world.taobao.com/product/${encodeURIComponent(params.keyword.trim())}.htm`;
    } else if (params.categoryId && params.categoryId.trim()) {
        baseUrl = `https://world.taobao.com/category/${encodeURIComponent(params.categoryId.trim())}.htm`;
    } else if (
        params.searchUrl &&
        /world\.taobao\.com\/(?:lang\/[a-z-]+\/)?(?:product|category)\//i.test(params.searchUrl)
    ) {
        baseUrl = params.searchUrl.split('?')[0]!;
    }

    if (!baseUrl) return null;

    const urlObj = new URL(baseUrl);
    if (filters.sort && filters.sort !== 'default') {
        const seoSort = WORLD_SEO_SORT_MAP[filters.sort];
        if (seoSort) urlObj.searchParams.set('sort', seoSort);
    } else if (page === 2) {
        urlObj.searchParams.set('sort', 'price-asc');
    } else if (page === 3) {
        urlObj.searchParams.set('sort', 'price-des');
    } else if (page > 3 && brandIdsForPagination && brandIdsForPagination.length >= page - 3) {
        const brandId = brandIdsForPagination[page - 4];
        if (brandId) {
            urlObj.searchParams.set('pvids', `20000-${brandId}`);
        }
    }

    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
        const min = filters.minPrice ?? 0;
        const max = filters.maxPrice ?? 999999;
        urlObj.searchParams.set('priceRange', `${min}_${max}`);
    }

    if (page > 1) {
        urlObj.searchParams.set('page', String(page));
    }

    return urlObj.toString();
}

/**
 * Normalizes a raw item JSON object from `world.taobao.com` (`__ICE_APP_CONTEXT__` / `g_page_config` / `__INITIAL_DATA__` / `itemsArray`)
 * into PartialProductData.
 */
export function mapSearchJsonItem(raw: Record<string, unknown>): PartialProductData | null {
    const rawId =
        raw.nid ??
        raw.item_id ??
        raw.itemId ??
        raw.auctionId ??
        raw.id ??
        extractItemIdFromUrl(String(raw.detail_url ?? raw.auctionURL ?? raw.url ?? ''));

    if (!rawId) return null;
    const itemId = String(rawId).trim();
    if (!/^\d{5,20}$/.test(itemId)) return null;

    const itemIdStr =
        typeof raw.itemIdStr === 'string' && raw.itemIdStr.trim() ? raw.itemIdStr.trim() : null;
    const explicitShopId = raw.shopId ? String(raw.shopId).trim() : null;

    if (itemIdStr) {
        registerItemSlug(itemId, itemIdStr, explicitShopId ?? undefined);
    }

    const rawTitle = String(raw.raw_title ?? raw.title ?? raw.itemName ?? '')
        .replace(/<\/?span[^>]*>/gi, '')
        .trim();
    const title = sanitizeNoPiiText(rawTitle) ?? '';

    const detailUrlRaw = String(raw.detail_url ?? raw.auctionURL ?? raw.url ?? '');
    const shopNameRaw = raw.nick ? String(raw.nick).trim() : raw.shopName ? String(raw.shopName).trim() : null;
    const isTmall =
        Boolean((raw.shopcard as Record<string, unknown>)?.isTmall) ||
        Boolean(raw.isTmall) ||
        String(raw.userType) === '1' ||
        String(raw.seoItemType ?? '').toLowerCase() === 'tmall' ||
        detailUrlRaw.includes('tmall.com') ||
        Boolean(shopNameRaw && /旗舰店|旗艦店|专卖店|專賣店|专营店|專營店|官方/.test(shopNameRaw));
    const platform: PlatformType = isTmall ? 'tmall' : 'taobao';

    const url =
        normalizeUrl(detailUrlRaw) ??
        (platform === 'tmall'
            ? `https://detail.tmall.com/item.htm?id=${itemId}`
            : `https://item.taobao.com/item.htm?id=${itemId}`);

    const mainImage = normalizeUrl(
        (raw.pic_url as string | undefined) ??
            (raw.picUrlFull as string | undefined) ??
            (raw.picUrl as string | undefined) ??
            (raw.img as string | undefined) ??
            (raw.imageUrl as string | undefined),
    );

    const images: string[] = [];
    if (mainImage) images.push(mainImage);
    if (Array.isArray(raw.picUrlList)) {
        for (const pic of raw.picUrlList) {
            const norm = normalizeUrl(typeof pic === 'string' ? pic : undefined);
            if (norm && !images.includes(norm)) {
                images.push(norm);
            }
        }
    }

    const price = parsePriceNumber(
        raw.view_price ??
            raw.discntPriceYuan ??
            raw.priceZKYuanDouble ??
            raw.price ??
            raw.priceWithRate ??
            raw.salePrice ??
            raw.priceYuanDouble,
    );
    const originalPrice =
        parsePriceNumber(raw.reserve_price ?? raw.priceYuanDouble ?? raw.originalPrice ?? raw.oriPrice) ?? price;
    const promoPrice = parsePriceNumber(
        raw.promoPrice ??
            (raw.discntPriceYuan !== undefined &&
            raw.priceYuanDouble !== undefined &&
            Number(raw.discntPriceYuan) < Number(raw.priceYuanDouble)
                ? raw.discntPriceYuan
                : undefined),
    );

    const salesTextRaw = raw.view_sales ?? raw.realSales ?? raw.sold ?? raw.salesText ?? null;
    const salesText = salesTextRaw !== null && salesTextRaw !== undefined ? String(salesTextRaw).trim() : null;
    const salesCount = parseSalesCount(salesText);

    const shipFrom = raw.item_loc ? String(raw.item_loc).trim() : raw.procity ? String(raw.procity).trim() : null;
    const shippingFee = raw.freeShipping === true ? 0 : parsePriceNumber(raw.view_fee);

    const shopName = shopNameRaw;
    const shopId = explicitShopId;
    const shopUrl = normalizeUrl(
        (raw.shopLink as string | undefined) ??
            (raw.shopUrl as string | undefined) ??
            (explicitShopId ? `https://shop${explicitShopId}.taobao.com` : undefined),
    );

    const descScore = parsePriceNumber(raw.descriptionMatchScore);
    const sellerScores =
        descScore !== null && descScore > 0 && descScore <= 5
            ? { description: descScore, service: descScore, logistics: descScore }
            : undefined;

    return {
        itemId,
        ...(itemIdStr ? { itemIdStr } : {}),
        url,
        platform,
        title,
        mainImage,
        images,
        price,
        originalPrice,
        promoPrice,
        salesText,
        salesCount,
        shipFrom,
        shippingFee,
        shopId,
        shopName,
        shopType: platform,
        shopUrl,
        ...(sellerScores ? { sellerScores } : {}),
        isDetailFetched: false,
    };
}

/**
 * Extracts `window.__ICE_APP_CONTEXT__` JSON from `world.taobao.com` SSR HTML.
 */
export function extractIceAppContext(html: string): Record<string, unknown> | null {
    const match =
        html.match(/var\s+b\s*=\s*(\{[\s\S]*?\});\s*for\s*\(\s*var\s+k\s+in\s+a\s*\)/i) ||
        html.match(/window\.__ICE_APP_CONTEXT__\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/i);
    if (!match?.[1]) return null;
    try {
        return JSON.parse(match[1]) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/**
 * Parses `world.taobao.com` search/category HTML response (both embedded JSON states and DOM product cards).
 */
export function parseWorldTaobaoSearchHtml(html: string): {
    items: PartialProductData[];
    hasNextPage: boolean;
    brandIds?: string[];
} {
    const items: PartialProductData[] = [];
    const seenIds = new Set<string>();
    const brandIds: string[] = [];

    const pushUnique = (item: PartialProductData | null) => {
        if (!item || !item.itemId || seenIds.has(item.itemId)) return;
        seenIds.add(item.itemId);
        items.push(item);
    };

    // 0. Check world.taobao.com SSR `window.__ICE_APP_CONTEXT__` (`taglist-pc` / `taglist` / `shop-pc`)
    const iceContext = extractIceAppContext(html);
    if (iceContext && iceContext.loaderData && typeof iceContext.loaderData === 'object') {
        for (const loaderEntry of Object.values(iceContext.loaderData as Record<string, unknown>)) {
            if (!loaderEntry || typeof loaderEntry !== 'object') continue;
            const dataNode = (loaderEntry as Record<string, unknown>).data as Record<string, unknown> | undefined;
            const httpData = dataNode?.httpData as Record<string, unknown> | undefined;
            if (!httpData) continue;

            const navModule = httpData.navigatorModuleResponse as Record<string, unknown> | undefined;
            const brandList = navModule?.brandList;
            const pvidToBrandName = new Map<string, string>();
            if (Array.isArray(brandList)) {
                for (const b of brandList) {
                    const bObj = b as Record<string, unknown>;
                    const bId = bObj?.brandId;
                    if (bId !== undefined && bId !== null) {
                        brandIds.push(String(bId));
                    }
                    const bName = sanitizeNoPiiText(String(bObj?.brandName ?? bObj?.name ?? '').trim());
                    const bPvid = String(bObj?.pvid ?? (bId ? `20000-${bId}` : '')).trim();
                    if (bName && bPvid) {
                        pvidToBrandName.set(bPvid, bName);
                    }
                }
            }

            const itemListModule = httpData.itemListModuleResponse as Record<string, unknown> | undefined;
            const itemList = itemListModule?.itemList;
            if (Array.isArray(itemList)) {
                for (const rawItem of itemList) {
                    if (rawItem && typeof rawItem === 'object') {
                        const rawRec = rawItem as Record<string, unknown>;
                        const mapped = mapSearchJsonItem(rawRec);
                        if (mapped && !mapped.brand && Array.isArray(rawRec.pvidList)) {
                            for (const pvid of rawRec.pvidList) {
                                const matchedBrand = pvidToBrandName.get(String(pvid).trim());
                                if (matchedBrand) {
                                    mapped.brand = matchedBrand;
                                    break;
                                }
                            }
                        }
                        pushUnique(mapped);
                    }
                }
            }
        }
    }

    // 1. Check g_page_config or window.__INITIAL_DATA__
    const configMatchers = [
        /g_page_config\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:g_srp_loadCss|window\.|<\/script>)/i,
        /window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/i,
    ];

    for (const regex of configMatchers) {
        const match = html.match(regex);
        if (match?.[1]) {
            try {
                const parsed = JSON.parse(match[1]) as Record<string, unknown>;
                const mods = parsed.mods as Record<string, unknown> | undefined;
                const itemListNode = (mods?.itemlist as Record<string, unknown>)?.data as
                    | Record<string, unknown>
                    | undefined;
                const auctions =
                    itemListNode?.auctions ??
                    parsed.itemsArray ??
                    (parsed.data as Record<string, unknown>)?.itemsArray ??
                    (parsed.pageData as Record<string, unknown>)?.items;

                if (Array.isArray(auctions)) {
                    for (const rawItem of auctions) {
                        if (rawItem && typeof rawItem === 'object') {
                            pushUnique(mapSearchJsonItem(rawItem as Record<string, unknown>));
                        }
                    }
                }
            } catch {
                // Continue to DOM parsing
            }
        }
    }

    // 2. DOM card extraction via Cheerio for world.taobao.com
    const $ = cheerio.load(html);
    $(
        '[data-itemid], .item, .J_MouserOnverReq, [class*="Card--doubleCard"], .product-item, li.item-card',
    ).each((_, el) => {
        const $el = $(el);
        const attrId = $el.attr('data-itemid') || $el.attr('data-id');
        const linkHref =
            $el.find('a[href*="item"], a[href*="detail"]').first().attr('href') || $el.find('a').first().attr('href') || '';
        const itemId = (attrId && /^\d{5,20}$/.test(attrId.trim()) ? attrId.trim() : null) ?? extractItemIdFromUrl(linkHref);
        if (!itemId || seenIds.has(itemId)) return;

        const title = sanitizeNoPiiText(
            $el
                .find('.title, [class*="Title--title"], .item-title, h3, img')
                .first()
                .text()
                .trim() ||
                $el.find('img').first().attr('alt')?.trim() ||
                '',
        ) ?? '';

        const priceStr = $el
            .find('.price strong, .g_price strong, [class*="Price--priceInt"], .price-num, .c-price')
            .first()
            .text()
            .trim();
        const price = parsePriceNumber(priceStr);

        const salesText =
            $el.find('.deal-cnt, [class*="Price--realSales"], .sale-num, .sold').first().text().trim() || null;
        const salesCount = parseSalesCount(salesText);

        const imgSrc =
            $el.find('img').first().attr('data-src') ||
            $el.find('img').first().attr('data-ks-lazyload') ||
            $el.find('img').first().attr('src');
        const mainImage = normalizeUrl(imgSrc);

        const shopName =
            $el.find('.shopname, .shop a, [class*="ShopInfo--shopName"]').first().text().trim() || null;
        const shipFrom = $el.find('.location, [class*="Price--procity"]').first().text().trim() || null;
        const isTmall =
            linkHref.includes('tmall.com') || $el.find('.icon-service-tianmao, [class*="tmall"]').length > 0;
        const platform: PlatformType = isTmall ? 'tmall' : 'taobao';

        pushUnique({
            itemId,
            url:
                normalizeUrl(linkHref) ??
                (platform === 'tmall'
                    ? `https://detail.tmall.com/item.htm?id=${itemId}`
                    : `https://item.taobao.com/item.htm?id=${itemId}`),
            platform,
            title,
            mainImage,
            images: mainImage ? [mainImage] : [],
            price,
            originalPrice: price,
            promoPrice: null,
            salesText,
            salesCount,
            shipFrom,
            shopName,
            shopType: platform,
            isDetailFetched: false,
        });
    });

    const hasNextPage =
        items.length >= 20 ||
        $('a.next, .J_Ajax.next, [class*=" Pagination--next"], link[rel="next"]').length > 0;

    return { items, hasNextPage, brandIds };
}

/**
 * Applies client-side searchFilters verification (`minPrice`, `maxPrice`, `tmallOnly`, `location`, `sort`).
 */
export function applySearchFilters(items: PartialProductData[], filters?: SearchFilters): PartialProductData[] {
    if (!filters) return items;

    const filtered = items.filter((item) => {
        if (filters.tmallOnly && item.platform !== 'tmall') {
            return false;
        }
        if (filters.minPrice !== undefined && item.price !== null && item.price !== undefined) {
            if (item.price < filters.minPrice) return false;
        }
        if (filters.maxPrice !== undefined && item.price !== null && item.price !== undefined) {
            if (item.price > filters.maxPrice) return false;
        }
        if (filters.location && item.shipFrom) {
            if (!item.shipFrom.includes(filters.location)) return false;
        }
        return true;
    });

    if (filters.sort === 'priceAsc') {
        filtered.sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER));
    } else if (filters.sort === 'priceDesc') {
        filtered.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    } else if (filters.sort === 'sales') {
        filtered.sort((a, b) => (b.salesCount ?? 0) - (a.salesCount ?? 0));
    }

    return filtered;
}

/**
 * Layered Search & Category Listing Source:
 * 1. Primary: `world.taobao.com/product/<keyword>.htm` or `/category/<id>.htm` (overseas SSR taglist-pc)
 * 2. Secondary: `world.taobao.com/search/search.htm` (legacy overseas search HTML)
 * 3. Fallback: Mobile H5 search API (`mtop.relationrecommend.wirelessrecommend.recommend`)
 */
export class LayeredSearchListingSource implements SearchListingSource {
    public readonly name = 'WorldTaobaoAndH5SearchSource';
    private readonly h5Client: TaobaoH5Client;
    private readonly brandCache = new Map<string, string[]>();

    constructor(h5Client: TaobaoH5Client) {
        this.h5Client = h5Client;
    }

    public async searchProducts(params: {
        keyword?: string;
        searchUrl?: string;
        categoryId?: string;
        page: number;
        filters?: SearchFilters;
    }): Promise<DataSourceResult<{ items: PartialProductData[]; rawItemCount?: number; hasNextPage: boolean }>> {
        const cacheKey = `${params.keyword ?? ''}::${params.categoryId ?? ''}`;
        const cachedBrands = this.brandCache.get(cacheKey);
        const urlType = params.categoryId && !params.keyword ? 'category' : 'search';

        // Layer 1a: world.taobao.com SSR product/category taglist-pc endpoint
        const seoUrl = buildWorldTaobaoSeoTagUrl(params, cachedBrands);
        let seoPageRes: DataSourceResult<{ body: string; finalUrl: string; statusCode: number }> | null = null;
        if (seoUrl) {
            seoPageRes = await this.h5Client.fetchPage(seoUrl, {
                referer: 'https://world.taobao.com/',
                urlType,
            });
            if (seoPageRes.ok && seoPageRes.data) {
                const parsed = parseWorldTaobaoSearchHtml(seoPageRes.data.body);
                if (parsed.brandIds && parsed.brandIds.length > 0 && !this.brandCache.has(cacheKey)) {
                    this.brandCache.set(cacheKey, parsed.brandIds);
                }
                if (parsed.items.length > 0) {
                    const filteredItems = applySearchFilters(parsed.items, params.filters);
                    return {
                        ok: true,
                        data: {
                            items: filteredItems,
                            rawItemCount: parsed.items.length,
                            hasNextPage: parsed.hasNextPage,
                        },
                    };
                }
            }
        }

        // Layer 1b: legacy world.taobao.com/search/search.htm
        const targetUrl = buildWorldTaobaoSearchUrl(params);
        const pageRes =
            targetUrl !== seoUrl
                ? await this.h5Client.fetchPage(targetUrl, {
                      referer: 'https://world.taobao.com/',
                      urlType,
                  })
                : seoPageRes!;

        if (pageRes.ok && pageRes.data) {
            const parsed = parseWorldTaobaoSearchHtml(pageRes.data.body);
            if (parsed.items.length > 0) {
                const filteredItems = applySearchFilters(parsed.items, params.filters);
                return {
                    ok: true,
                    data: {
                        items: filteredItems,
                        rawItemCount: parsed.items.length,
                        hasNextPage: parsed.hasNextPage,
                    },
                };
            }
            if (params.page > 1) {
                return {
                    ok: true,
                    data: {
                        items: [],
                        rawItemCount: 0,
                        hasNextPage: false,
                    },
                };
            }
        }

        // Layer 2: H5 wireless search fallback
        const mtopSearchData: Record<string, unknown> = {
            appId: '34385',
            params: JSON.stringify({
                q: params.keyword ?? '',
                cat: params.categoryId ?? '',
                page: params.page,
                n: 44,
                sort: params.filters?.sort ? SORT_PARAM_MAP[params.filters.sort] : '_coefp',
                tab: params.filters?.tmallOnly ? 'mall' : 'all',
                start_price: params.filters?.minPrice ?? '',
                end_price: params.filters?.maxPrice ?? '',
                loc: params.filters?.location ?? '',
            }),
        };

        const mtopRes = await this.h5Client.requestMtop<Record<string, unknown>>({
            api: 'mtop.relationrecommend.wirelessrecommend.recommend',
            version: '2.0',
            platform: params.filters?.tmallOnly ? 'tmall' : 'taobao',
            data: mtopSearchData,
        });

        if (mtopRes.ok && mtopRes.data) {
            const rawList =
                (mtopRes.data.itemsArray as unknown[]) ??
                (mtopRes.data.result as unknown[]) ??
                (mtopRes.data.listItem as unknown[]) ??
                [];
            const items: PartialProductData[] = [];
            for (const entry of rawList) {
                if (entry && typeof entry === 'object') {
                    const mapped = mapSearchJsonItem(entry as Record<string, unknown>);
                    if (mapped) items.push(mapped);
                }
            }

            if (items.length > 0) {
                return {
                    ok: true,
                    data: {
                        items: applySearchFilters(items, params.filters),
                        rawItemCount: items.length,
                        hasNextPage: items.length >= 20,
                    },
                };
            }
            if (params.page > 1) {
                return {
                    ok: true,
                    data: {
                        items: [],
                        rawItemCount: 0,
                        hasNextPage: false,
                    },
                };
            }
        }

        return {
            ok: false,
            blocked: Boolean(seoPageRes?.blocked || pageRes?.blocked || mtopRes.blocked),
            errorReason:
                mtopRes.errorReason ||
                pageRes?.errorReason ||
                seoPageRes?.errorReason ||
                `No search results extracted for query "${params.keyword ?? params.categoryId ?? params.searchUrl}" (page ${params.page})`,
        };
    }
}
