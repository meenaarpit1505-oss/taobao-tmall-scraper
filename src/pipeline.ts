import { buildAgentLinks } from './agentLinks.js';
import type { CurrencyService } from './currency.js';
import { computeProductAndSkuFinalPrices } from './finalPrice.js';
import { containsChinese, type TranslatorService } from './translator.js';
import type {
    AgentName,
    ItemStatus,
    PartialProductData,
    PlatformType,
    ProductOutput,
} from './types.js';
import { computeDataCompleteness, computeShopCompleteness, normalizeUrl, sanitizeNoPiiText } from './utils.js';

export interface AssembleProductOptions {
    partial: PartialProductData;
    translator: TranslatorService;
    currencyService: CurrencyService;
    selectedAgents: AgentName[];
    includeShopInfo: boolean;
}

/**
 * Taobao/Tmall show "9999", "99999", "999999" etc. as a placeholder when the real price is hidden
 * (pre-sale, members-only, or a dummy listing variant). These must never be reported as real prices.
 */
export function isPlaceholderPrice(value: number | null | undefined): boolean {
    if (value === null || value === undefined || !Number.isFinite(value)) return false;
    if (value >= 9999 && /^9{4,}(?:\.0+)?$/.test(String(value))) return true;
    return value >= 99_999_000;
}

/**
 * Removes placeholder prices from a partial record (price, original, promo, SKU prices) and reports what was rejected.
 */
export function sanitizePlaceholderPrices(partial: PartialProductData): {
    partial: PartialProductData;
    priceWarning: string | null;
} {
    const rejected: number[] = [];
    const clean = (v: number | null | undefined): number | null => {
        if (v === null || v === undefined) return null;
        if (isPlaceholderPrice(v)) {
            rejected.push(v);
            return null;
        }
        return v;
    };
    const skus = Array.isArray(partial.skus)
        ? partial.skus.map((sku) => ({
              ...sku,
              price: clean(sku.price),
              originalPrice: clean(sku.originalPrice),
              promoPrice: clean(sku.promoPrice ?? null),
          }))
        : partial.skus;
    let price = clean(partial.price);
    const originalPrice = clean(partial.originalPrice);
    const promoPrice = clean(partial.promoPrice);
    const minPrice = clean(partial.minPrice);
    const maxPrice = clean(partial.maxPrice);
    if (price === null && rejected.length > 0) {
        // Fall back to a real price from the same record when one exists
        const skuPrices = (skus ?? []).map((s) => s.price).filter((v): v is number => v !== null && v > 0);
        price = promoPrice ?? (skuPrices.length > 0 ? Math.min(...skuPrices) : null) ?? minPrice ?? null;
    }
    const priceWarning =
        rejected.length > 0
            ? `Rejected placeholder price ${[...new Set(rejected)].join('/')} CNY (Taobao shows this when the real price is hidden).${price === null ? ' No real price was available.' : ''}`
            : null;
    return {
        partial: { ...partial, price, originalPrice, promoPrice, minPrice, maxPrice, skus },
        priceWarning,
    };
}

/**
 * Lowest and highest real price across price range, listing price, promo price and real SKU prices.
 */
export function computePriceRange(partial: PartialProductData): { minPrice: number | null; maxPrice: number | null } {
    const candidates: number[] = [];
    const push = (v: number | null | undefined) => {
        if (v !== null && v !== undefined && Number.isFinite(v) && v > 0) candidates.push(v);
    };
    push(partial.minPrice);
    push(partial.maxPrice);
    push(partial.price);
    push(partial.promoPrice);
    for (const sku of partial.skus ?? []) {
        push(sku.promoPrice ?? null);
        push(sku.price);
    }
    if (candidates.length === 0) return { minPrice: null, maxPrice: null };
    return {
        minPrice: Math.round(Math.min(...candidates) * 100) / 100,
        maxPrice: Math.round(Math.max(...candidates) * 100) / 100,
    };
}

/**
 * Merges base listing data with deeper detail data (when `includeDetails: true`).
 */
export function mergePartialProductData(
    base: PartialProductData,
    detail: PartialProductData,
): PartialProductData {
    return {
        ...base,
        ...detail,
        itemId: detail.itemId || base.itemId,
        url: detail.url || base.url,
        platform: detail.platform || base.platform,
        title: detail.title || base.title,
        mainImage: detail.mainImage || base.mainImage,
        images: detail.images && detail.images.length > 0 ? detail.images : base.images ?? [],
        price: detail.price ?? base.price ?? null,
        originalPrice: detail.originalPrice ?? base.originalPrice ?? null,
        promoPrice: detail.promoPrice ?? base.promoPrice ?? null,
        salesText: detail.salesText ?? base.salesText ?? null,
        salesCount: detail.salesCount ?? base.salesCount ?? null,
        shipFrom: detail.shipFrom ?? base.shipFrom ?? null,
        shippingFee: detail.shippingFee ?? base.shippingFee ?? null,
        shippingNote: detail.shippingNote ?? base.shippingNote ?? null,
        shopId: detail.shopId ?? base.shopId ?? null,
        shopName: detail.shopName ?? base.shopName ?? null,
        shopType: detail.shopType ?? base.shopType ?? null,
        shopUrl: detail.shopUrl ?? base.shopUrl ?? null,
        minPrice: detail.minPrice ?? base.minPrice ?? null,
        maxPrice: detail.maxPrice ?? base.maxPrice ?? null,
        detailSource: detail.detailSource ?? base.detailSource ?? null,
        isDetailFetched: Boolean(detail.isDetailFetched || base.isDetailFetched),
    };
}

/**
 * Builds a complete, flat, CSV-friendly ProductOutput row with identical field names across all modes.
 */
export async function assembleProductOutput(options: AssembleProductOptions): Promise<ProductOutput> {
    const { translator, currencyService, selectedAgents, includeShopInfo } = options;
    const { partial, priceWarning } = sanitizePlaceholderPrices(options.partial);

    const rawItemId = String(partial.itemId ?? '').trim();
    const itemId: string | null = rawItemId ? rawItemId : null;
    const platform: PlatformType = partial.platform ?? 'taobao';
    const canonicalUrl =
        normalizeUrl(partial.url) ??
        (platform === 'tmall'
            ? `https://detail.tmall.com/item.htm?id=${rawItemId}`
            : `https://item.taobao.com/item.htm?id=${rawItemId}`);

    const title = sanitizeNoPiiText(partial.title ?? '') ?? '';
    const attributes = partial.attributes ?? {};

    // Real final price calculation across product and SKUs
    const priceCalc = computeProductAndSkuFinalPrices(partial);

    // Batch translate title, attributes (keys & values), and SKU property labels in a single batch call
    const attrEntries = Object.entries(attributes);
    const batchInputs: Array<string | null> = [title || null];
    for (const [k, v] of attrEntries) {
        batchInputs.push(k, v);
    }
    for (const sku of priceCalc.skus) {
        batchInputs.push(sku.props);
    }

    const { results: translatedBatch, status: batchTranslationStatus } =
        await translator.translateBatchWithStatus(batchInputs);

    const titleEn = title ? (translatedBatch[0] ?? null) : null;
    const translationStatus =
        translator.isEnabled() && title && containsChinese(title) && titleEn === null
            ? 'failed'
            : batchTranslationStatus;
    const attributesEn: Record<string, string> = {};
    let cursor = 1;
    if (translator.isEnabled()) {
        for (const [rawKey, rawVal] of attrEntries) {
            const kEn = translatedBatch[cursor] ?? rawKey;
            const vEn = translatedBatch[cursor + 1] ?? rawVal;
            attributesEn[kEn] = vEn;
            cursor += 2;
        }
    } else {
        cursor += attrEntries.length * 2;
    }

    for (const sku of priceCalc.skus) {
        sku.propsEn = translatedBatch[cursor] ?? null;
        cursor += 1;
    }

    const effectivePriceCny = priceCalc.finalPrice ?? partial.promoPrice ?? partial.price ?? null;
    const conv = currencyService.convert(effectivePriceCny);
    const finalConv = currencyService.convert(priceCalc.finalPrice);
    const priceRange = computePriceRange({ ...partial, skus: priceCalc.skus.map((s) => ({ ...s, promoPrice: null })) });

    const agentLinks = itemId
        ? buildAgentLinks({
              itemId,
              url: canonicalUrl,
              platform,
              selectedAgents,
          })
        : {};

    const shopId = includeShopInfo ? (partial.shopId ?? null) : null;
    const shopName = includeShopInfo ? (partial.shopName ?? null) : null;
    const shopType = includeShopInfo ? (partial.shopType ?? platform) : null;
    const shopUrl = includeShopInfo ? (partial.shopUrl ?? null) : null;
    const sellerScores = includeShopInfo ? (partial.sellerScores ?? null) : null;
    const creditLevel = includeShopInfo ? (partial.creditLevel ?? null) : null;
    const shopAgeYears = includeShopInfo ? (partial.shopAgeYears ?? null) : null;
    const shopProductCount = includeShopInfo ? (partial.shopProductCount ?? null) : null;

    const images = Array.isArray(partial.images) ? partial.images : partial.mainImage ? [partial.mainImage] : [];
    const mainImage = partial.mainImage ?? images[0] ?? null;

    const { dataCompleteness, missingFields } = computeDataCompleteness({
        itemId,
        title,
        price: partial.price ?? null,
        mainImage,
        images,
        skus: priceCalc.skus,
        attributes,
        shopName,
        salesText: partial.salesText ?? null,
        stock: partial.stock ?? null,
        brand: partial.brand ?? null,
        categoryPath: partial.categoryPath ?? null,
        shipFrom: partial.shipFrom ?? null,
    });

    let status: ItemStatus = 'ok';
    if (!title && (partial.price === null || partial.price === undefined)) {
        status = 'failed';
    } else if (partial.errorReason || !title || partial.price === null || partial.price === undefined) {
        status = 'partial';
    }


    return {
        recordType: 'product',
        itemId,
        ...(partial.query !== undefined ? { query: partial.query } : {}),
        url: canonicalUrl,
        platform,
        title,
        titleEn,
        brand: partial.brand ?? null,
        categoryPath: partial.categoryPath ?? null,
        mainImage,
        images,
        descriptionImages: partial.descriptionImages ?? [],
        videoUrl: partial.videoUrl ?? null,
        attributes,
        attributesEn,
        price: partial.price ?? null,
        originalPrice: partial.originalPrice ?? partial.price ?? null,
        promoPrice: partial.promoPrice ?? null,
        finalPrice: priceCalc.finalPrice,
        finalPriceDiscounts: priceCalc.finalPriceDiscounts,
        unappliedDiscounts: priceCalc.unappliedDiscounts,
        priceType: priceCalc.priceType,
        currency: 'CNY',
        minPrice: priceRange.minPrice,
        maxPrice: priceRange.maxPrice,
        priceWarning,
        convertedCurrency: conv.currency,
        priceConverted: conv.priceConverted,
        finalPriceConverted: finalConv.priceConverted,
        detailSource: partial.detailSource ?? null,
        exchangeRate: conv.exchangeRate,
        exchangeRateDate: conv.exchangeRateDate,
        exchangeRateSource: conv.exchangeRateSource,
        translationStatus,
        salesText: partial.salesText ?? null,
        salesCount: partial.salesCount ?? null,
        stock: partial.stock ?? null,
        skus: priceCalc.skus,
        shipFrom: partial.shipFrom ?? null,
        shippingFee: partial.shippingFee ?? null,
        shippingNote: partial.shippingNote ?? null,
        shopId,
        shopName,
        shopType,
        shopUrl,
        sellerScores,
        creditLevel,
        shopAgeYears,
        shopProductCount,
        agentLinks,
        dataCompleteness: status === 'failed' ? 0 : dataCompleteness,
        missingFields,
        status,
        errorReason: partial.errorReason ?? null,
        scrapedAt: new Date().toISOString(),
        changeType: null,
        previousValues: {},
    };
}

/**
 * Builds a shop summary row with identical flat fields plus `recordType: 'shop'` and `shopCatalogueItemIds`.
 */
export async function buildShopSummaryRow(params: {
    shopInfo: Partial<PartialProductData>;
    shopUrl: string;
    catalogueItemIds: string[];
    translator: TranslatorService;
    currencyService: CurrencyService;
}): Promise<ProductOutput> {
    const { shopInfo, shopUrl, catalogueItemIds, translator, currencyService } = params;
    const shopId = shopInfo.shopId ?? 'shop';
    const shopName = shopInfo.shopName ?? `Shop ${shopId}`;
    const platform: PlatformType = shopInfo.platform ?? 'taobao';
    const { results: shopTranslated, status: shopTranslationStatus } =
        await translator.translateBatchWithStatus([shopName]);
    const titleEn = shopTranslated[0] ?? null;
    const conv = currencyService.convert(null);
    const normalizedShopUrl = normalizeUrl(shopInfo.shopUrl ?? shopUrl);
    const shopProductCount = shopInfo.shopProductCount ?? (catalogueItemIds.length > 0 ? catalogueItemIds.length : null);

    const { dataCompleteness, missingFields } = computeShopCompleteness({
        shopId: shopInfo.shopId ?? null,
        shopName: shopInfo.shopName ?? null,
        shopUrl: normalizedShopUrl,
        sellerScores: shopInfo.sellerScores ?? null,
        creditLevel: shopInfo.creditLevel ?? null,
        shopAgeYears: shopInfo.shopAgeYears ?? null,
        shopProductCount,
        shipFrom: shopInfo.shipFrom ?? null,
        catalogueItemIds,
    });

    return {
        recordType: 'shop',
        itemId: `shop_${shopId}`,
        url: normalizedShopUrl ?? shopUrl,
        platform,
        title: shopName,
        titleEn,
        brand: shopInfo.brand ?? null,
        categoryPath: null,
        mainImage: null,
        images: [],
        descriptionImages: [],
        videoUrl: null,
        attributes: { catalogueCount: String(catalogueItemIds.length) },
        attributesEn: { catalogueCount: String(catalogueItemIds.length) },
        price: null,
        originalPrice: null,
        promoPrice: null,
        finalPrice: null,
        finalPriceDiscounts: [],
        unappliedDiscounts: [],
        priceType: 'unknown',
        currency: 'CNY',
        minPrice: null,
        maxPrice: null,
        priceWarning: null,
        convertedCurrency: conv.currency,
        priceConverted: null,
        finalPriceConverted: null,
        detailSource: null,
        exchangeRate: conv.exchangeRate,
        exchangeRateDate: conv.exchangeRateDate,
        exchangeRateSource: conv.exchangeRateSource,
        translationStatus: shopTranslationStatus,
        salesText: null,
        salesCount: null,
        stock: null,
        skus: [],
        shipFrom: shopInfo.shipFrom ?? null,
        shippingFee: null,
        shippingNote: null,
        shopId: shopInfo.shopId ?? null,
        shopName,
        shopType: shopInfo.shopType ?? platform,
        shopUrl: normalizedShopUrl,
        sellerScores: shopInfo.sellerScores ?? null,
        creditLevel: shopInfo.creditLevel ?? null,
        shopAgeYears: shopInfo.shopAgeYears ?? null,
        shopProductCount,
        agentLinks: {},
        dataCompleteness,
        missingFields,
        status: 'ok',
        errorReason: null,
        scrapedAt: new Date().toISOString(),
        changeType: null,
        previousValues: {},
        shopCatalogueItemIds: catalogueItemIds,
    };
}
