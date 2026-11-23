import type { ProxyConfigurationOptions } from 'apify';

export type PlatformType = 'taobao' | 'tmall';

export type SortOption = 'default' | 'sales' | 'priceAsc' | 'priceDesc';

export type AgentName = 'superbuy' | 'cssbuy' | 'sugargoo' | 'cnfans' | 'hoobuy';

export interface SearchFilters {
    minPrice?: number;
    maxPrice?: number;
    tmallOnly?: boolean;
    location?: string;
    sort?: SortOption;
}

export interface ActorInput {
    startUrls?: Array<string | { url: string; method?: string; userData?: Record<string, unknown> }>;
    itemIds?: Array<string | number>;
    keywords?: string[];
    // Search filter fields (top-level in input_schema.json; searchFilters kept for backward compatibility)
    minPrice?: number;
    maxPrice?: number;
    tmallOnly?: boolean;
    location?: string;
    sort?: SortOption;
    searchFilters?: SearchFilters;
    maxItemsPerQuery?: number;
    includeDetails?: boolean;
    includeShopInfo?: boolean;
    translateToEnglish?: boolean;
    translationProvider?: 'gtx' | 'deepl' | 'google';
    translationApiKey?: string;
    deeplApiKey?: string;
    googleTranslateApiKey?: string;
    currency?: string;
    monitoringMode?: boolean;
    monitoringKey?: string;
    agentLinks?: AgentName[];
    proxyConfiguration?: ProxyConfigurationOptions & {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
        apifyProxyCountry?: string;
    };
    maxConcurrency?: number;
    requestDelayMs?: number;
    cookie?: string;
    taobaoCookies?: string;
    enableSessionWarmup?: boolean;
    enablePlaywrightFallback?: boolean;
    proxyCountry?: string;
    maxChargeUsd?: number;
}

export type RouteTargetType = 'product' | 'short_link' | 'shop' | 'search' | 'category' | 'invalid';

export interface RoutedTask {
    type: RouteTargetType;
    url: string;
    itemId?: string;
    itemIdStr?: string;
    platform?: PlatformType;
    keyword?: string;
    shopId?: string;
    shopDomain?: string;
    categoryId?: string;
    page?: number;
    filters?: SearchFilters;
    fallbackFromId?: boolean;
    errorReason?: string;
    rawInput?: string;
}

export interface DiscountBreakdownItem {
    type: 'coupon' | 'shop_discount' | 'threshold' | 'promo';
    label: string;
    labelEn?: string;
    threshold?: number | null;
    amountOff: number;
    applied: boolean;
}

export type PriceType = 'exact_final' | 'partial' | 'promo_only' | 'base_price' | 'range_min' | 'unknown';

export type ExchangeRateSource = 'live' | 'fallback';
export type TranslationStatus = 'ok' | 'partial' | 'failed' | 'disabled';

export interface SkuItem {
    skuId: string;
    props: string;
    propsEn: string | null;
    price: number | null;
    originalPrice: number | null;
    originalPriceFallback?: boolean;
    finalPrice: number | null;
    stock: number | null;
    image: string | null;
}

export interface SellerScores {
    description: number | null;
    service: number | null;
    logistics: number | null;
}

export type AgentLinksMap = Partial<Record<AgentName, string>>;

export type ItemStatus = 'ok' | 'partial' | 'failed';
export type ChangeType = 'new' | 'changed' | 'unchanged' | null;

export interface ProductOutput {
    recordType?: 'product' | 'shop';
    itemId: string | null;
    query?: string | null;
    url: string;
    platform: PlatformType;
    title: string;
    titleEn: string | null;
    brand: string | null;
    categoryPath: string | null;
    mainImage: string | null;
    images: string[];
    descriptionImages: string[];
    videoUrl: string | null;
    attributes: Record<string, string>;
    attributesEn: Record<string, string>;
    price: number | null;
    originalPrice: number | null;
    promoPrice: number | null;
    finalPrice: number | null;
    finalPriceDiscounts: DiscountBreakdownItem[];
    unappliedDiscounts: string[];
    priceType: PriceType;
    /** Currency of price/originalPrice/promoPrice/finalPrice/minPrice/maxPrice and SKU prices. Always "CNY". */
    currency: string;
    minPrice: number | null;
    maxPrice: number | null;
    /** Set when the source price looked like a placeholder (e.g. 9999 / 99999) and was rejected. */
    priceWarning: string | null;
    /** Currency of priceConverted / finalPriceConverted (the `currency` input, e.g. USD). */
    convertedCurrency: string;
    priceConverted: number | null;
    finalPriceConverted: number | null;
    detailSource: string | null;
    exchangeRate: number | null;
    exchangeRateDate: string | null;
    exchangeRateSource: ExchangeRateSource;
    translationStatus: TranslationStatus;
    salesText: string | null;
    salesCount: number | null;
    stock: number | null;
    skus: SkuItem[];
    shipFrom: string | null;
    shippingFee: number | null;
    shippingNote?: string | null;
    shopId: string | null;
    shopName: string | null;
    shopType: string | null;
    shopUrl: string | null;
    sellerScores: SellerScores | null;
    creditLevel: string | null;
    shopAgeYears: number | null;
    shopProductCount: number | null;
    agentLinks: AgentLinksMap;
    dataCompleteness: number;
    missingFields: string[];
    status: ItemStatus;
    errorReason: string | null;
    scrapedAt: string;
    changeType: ChangeType;
    previousValues: Record<string, unknown>;
    /** Only populated on shop summary rows in Shop Mode */
    shopCatalogueItemIds?: string[];
}

export interface RawPromotionCandidate {
    type: 'coupon' | 'shop_discount' | 'threshold' | 'promo';
    label: string;
    threshold?: number;
    amountOff?: number;
    discountRate?: number;
    fixedPrice?: number;
    confident: boolean;
    canCombine?: boolean;
    alreadyInPromoPrice?: boolean;
}

export interface PartialProductData {
    itemId: string;
    itemIdStr?: string | null;
    query?: string | null;
    url?: string;
    platform?: PlatformType;
    title?: string;
    brand?: string | null;
    categoryPath?: string | null;
    mainImage?: string | null;
    images?: string[];
    descriptionImages?: string[];
    videoUrl?: string | null;
    attributes?: Record<string, string>;
    price?: number | null;
    originalPrice?: number | null;
    promoPrice?: number | null;
    /** Lowest / highest price seen across listing price, price range and real SKU prices (CNY). */
    minPrice?: number | null;
    maxPrice?: number | null;
    /** Where the detail data came from (e.g. world_ssr, seo_pdp_api, mtop_detail, playwright). */
    detailSource?: string | null;
    rawPromotions?: RawPromotionCandidate[];
    salesText?: string | null;
    salesCount?: number | null;
    stock?: number | null;
    skus?: Array<{
        skuId: string;
        props: string;
        price: number | null;
        originalPrice: number | null;
        originalPriceFallback?: boolean;
        promoPrice?: number | null;
        stock: number | null;
        image: string | null;
    }>;
    shipFrom?: string | null;
    shippingFee?: number | null;
    shippingNote?: string | null;
    shopId?: string | null;
    shopName?: string | null;
    shopType?: string | null;
    shopUrl?: string | null;
    sellerScores?: SellerScores | null;
    creditLevel?: string | null;
    shopAgeYears?: number | null;
    shopProductCount?: number | null;
    errorReason?: string | null;
    isDetailFetched?: boolean;
}

export interface DataSourceResult<T> {
    ok: boolean;
    blocked?: boolean;
    notFound?: boolean;
    data?: T;
    errorReason?: string;
}

export interface ProductDetailSource {
    readonly name: string;
    fetchProductDetail(itemId: string, preferredPlatform?: PlatformType): Promise<DataSourceResult<PartialProductData>>;
}

export interface SearchListingSource {
    readonly name: string;
    searchProducts(params: {
        keyword?: string;
        searchUrl?: string;
        categoryId?: string;
        page: number;
        filters?: SearchFilters;
    }): Promise<DataSourceResult<{ items: PartialProductData[]; rawItemCount?: number; hasNextPage: boolean }>>;
}

export interface ShopCatalogueSource {
    readonly name: string;
    fetchShopCatalogue(params: {
        shopUrl: string;
        shopId?: string;
        page: number;
        maxItems: number;
    }): Promise<DataSourceResult<{
        shopInfo: Partial<PartialProductData>;
        items: PartialProductData[];
        hasNextPage: boolean;
    }>>;
}
