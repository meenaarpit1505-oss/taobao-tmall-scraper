import * as cheerio from 'cheerio';
import type { TaobaoH5Client } from '../h5Client.js';
import { getShopIdForItemId, getSlugForItemId, registerItemSlug } from '../itemSlugRegistry.js';
import { buildItemCandidateUrls, extractWorldTaobaoSlugFromUrl } from '../router.js';
import type {
    DataSourceResult,
    PartialProductData,
    PlatformType,
    ProductDetailSource,
    RawPromotionCandidate,
    SellerScores,
} from '../types.js';
import { normalizeUrl, parsePriceNumber, parseSalesCount, sanitizeNoPiiText } from '../utils.js';
import { extractIceAppContext, parseWorldTaobaoSearchHtml } from './searchSource.js';
import { parseShopHtml } from './shopSource.js';

/**
 * Unwraps nested `apiStack[0].value` JSON payloads returned by `mtop.taobao.detail.getdetail`
 * and `mtop.taobao.pcdetail.data.get` into a unified object graph.
 */
export function unwrapMtopDetailPayload(rawData: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...rawData };

    const mergeRecordInto = (target: Record<string, unknown>, source: Record<string, unknown>): void => {
        for (const [key, val] of Object.entries(source)) {
            const existing = target[key];
            if (
                existing &&
                typeof existing === 'object' &&
                !Array.isArray(existing) &&
                val &&
                typeof val === 'object' &&
                !Array.isArray(val)
            ) {
                target[key] = { ...(existing as Record<string, unknown>), ...(val as Record<string, unknown>) };
            } else {
                target[key] = val;
            }
        }
    };

    const apiStack = rawData.apiStack;
    if (Array.isArray(apiStack)) {
        for (const entry of apiStack) {
            if (entry && typeof entry === 'object') {
                const rawVal = (entry as Record<string, unknown>).value ?? (entry as Record<string, unknown>).data;
                if (typeof rawVal === 'string') {
                    try {
                        const parsed = JSON.parse(rawVal) as Record<string, unknown>;
                        mergeRecordInto(merged, parsed);
                    } catch {
                        // Ignore malformed stack entry
                    }
                } else if (rawVal && typeof rawVal === 'object') {
                    mergeRecordInto(merged, rawVal as Record<string, unknown>);
                }
            }
        }
    }

    return merged;
}

function parsePriceRangeMax(raw: string): number | null {
    const parts = raw
        .replace(/[¥￥,\s]/g, '')
        .split('-')
        .map((p) => parseFloat(p))
        .filter((n) => Number.isFinite(n) && n >= 0);
    return parts.length > 0 ? Math.round(Math.max(...parts) * 100) / 100 : null;
}

/**
 * Parses the overseas SEO PDP API (`mtop.ovs.traffic.landing.seopdp.querySeoPdpPage`) payload.
 * Its `data.result` is a JSON string with the same module layout as the world.taobao.com SSR page
 * (`normalItemResponse`, `breadcrumbModuleResponse`, ...), sometimes with `apiStack` / `skuBase` detail modules.
 */
export function parseSeoPdpApiData(
    itemId: string,
    data: Record<string, unknown>,
    preferredPlatform: PlatformType = 'taobao',
): PartialProductData | null {
    let inner: Record<string, unknown> | null = null;
    if (typeof data.result === 'string') {
        try {
            inner = JSON.parse(data.result) as Record<string, unknown>;
        } catch {
            inner = null;
        }
    } else if (data.result && typeof data.result === 'object') {
        inner = data.result as Record<string, unknown>;
    } else if (data.normalItemResponse) {
        inner = data;
    }
    if (!inner) return null;
    const pageUrl =
        preferredPlatform === 'tmall'
            ? `https://detail.tmall.com/item.htm?id=${itemId}`
            : `https://item.taobao.com/item.htm?id=${itemId}`;
    const fakeIceHtml = `<script>var b = ${JSON.stringify({
        loaderData: { 'pdp-api': { data: { httpData: inner } } },
    })};for (var k in a) {b[k] = a[k]}</script>`;
    const fromWorld = parseWorldTaobaoPdpHtml(itemId, fakeIceHtml, pageUrl, preferredPlatform);
    const hasDetailModules = Boolean(inner.apiStack || inner.skuBase || inner.item);
    const fromMtop = hasDetailModules ? parseMtopDetailData(itemId, inner, preferredPlatform) : null;
    if (fromWorld && fromWorld.title) {
        if (fromMtop && fromMtop.skus && fromMtop.skus.length > 0) {
            return {
                ...fromWorld,
                skus: fromMtop.skus,
                images: (fromMtop.images?.length ?? 0) > (fromWorld.images?.length ?? 0) ? fromMtop.images : fromWorld.images,
                attributes: { ...(fromWorld.attributes ?? {}), ...(fromMtop.attributes ?? {}) },
                brand: fromMtop.brand ?? fromWorld.brand ?? null,
                stock: fromMtop.stock ?? fromWorld.stock ?? null,
                salesText: fromMtop.salesText ?? fromWorld.salesText ?? null,
                salesCount: fromMtop.salesCount ?? fromWorld.salesCount ?? null,
                detailSource: 'seo_pdp_api',
            };
        }
        return { ...fromWorld, detailSource: 'seo_pdp_api' };
    }
    if (fromMtop && fromMtop.title) return { ...fromMtop, detailSource: 'seo_pdp_api' };
    return null;
}

/**
 * Extracts structured promotion candidates (coupons, shop discounts, 满X减Y threshold deals)
 * from MTOP detail promotion sections.
 */
export function extractRawPromotionsFromDetail(merged: Record<string, unknown>): RawPromotionCandidate[] {
    const promotions: RawPromotionCandidate[] = [];
    const seenLabels = new Set<string>();
    const seenDealKeys = new Set<string>();

    const pushUniqueCandidate = (candidate: RawPromotionCandidate) => {
        if (candidate.confident && !candidate.alreadyInPromoPrice) {
            const normThreshold = candidate.threshold ?? 0;
            const normAmount = candidate.amountOff ?? 0;
            const normRate = candidate.discountRate ?? 0;
            const normFixed = candidate.fixedPrice ?? 0;
            const dealKey = `${normThreshold}|${normAmount}|${normRate}|${normFixed}`;
            if (seenDealKeys.has(dealKey)) return;
            seenDealKeys.add(dealKey);
        }
        promotions.push(candidate);
    };

    const addPromoText = (
        rawText: string,
        defaultType: RawPromotionCandidate['type'] = 'promo',
        recordIfUnparsed = true,
    ) => {
        const text = sanitizeNoPiiText(rawText)?.trim();
        if (!text || seenLabels.has(text)) return;
        seenLabels.add(text);

        // Treat "直降" as possibly already reflected in promoPrice; do not subtract again
        const zhijiangMatch = text.match(/直降\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*元?/);
        if (zhijiangMatch && !/满\s*\d+/.test(text)) {
            const amountOff = parseFloat(zhijiangMatch[1]!);
            pushUniqueCandidate({
                type: 'promo',
                label: text,
                threshold: 0,
                amountOff: Number.isFinite(amountOff) ? amountOff : 0,
                confident: true,
                alreadyInPromoPrice: true,
            });
            return;
        }

        // 1. Match "满X减Y" or "满X元减Y元" or "每满X减Y" (only when not conditional on multi-item count like "满2件")
        const thresholdRegex = /满\s*(\d+(?:\.\d+)?)\s*元?\s*(?:减|立减|省)\s*(\d+(?:\.\d+)?)/g;
        let match: RegExpExecArray | null;
        let matchedAny = false;
        while ((match = thresholdRegex.exec(text)) !== null) {
            const threshold = parseFloat(match[1]!);
            const amountOff = parseFloat(match[2]!);
            if (Number.isFinite(threshold) && Number.isFinite(amountOff) && threshold > 0 && amountOff > 0 && amountOff < threshold) {
                pushUniqueCandidate({
                    type: defaultType === 'coupon' || text.includes('券') ? 'coupon' : 'threshold',
                    label: match[0],
                    threshold,
                    amountOff,
                    confident: true,
                });
                matchedAny = true;
            }
        }

        // 2. Match unconditional coupon/discount "领券立减X" / "立减X元" / "无门槛X元" / "优惠券 ¥X" (excluding 直降)
        const directOffMatch =
            text.match(/(?:立减|无门槛(?:立减|优惠)?|领券(?:立)?减|店铺券(?:立)?减|优惠券(?:立)?减)\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*元?/) ||
            text.match(/(\d+(?:\.\d+)?)\s*元\s*无门槛/);
        if (!matchedAny && directOffMatch) {
            const amountOff = parseFloat(directOffMatch[1]!);
            if (Number.isFinite(amountOff) && amountOff > 0) {
                pushUniqueCandidate({
                    type: text.includes('券') ? 'coupon' : 'shop_discount',
                    label: text,
                    threshold: 0,
                    amountOff,
                    confident: true,
                });
                matchedAny = true;
            }
        }

        // 3. Match Chinese discount fold "X折" (e.g. "限时8.5折", "9折") when unconditional or 1-piece ("1件8.5折")
        const zheMatch = text.match(/(?:^|1件|限时|店铺|活动)(\d(?:\.\d)?)\s*折/);
        if (!matchedAny && zheMatch && !/[2-9]件|两件|三件|第二件|第2件|满\d+件/.test(text)) {
            const zhe = parseFloat(zheMatch[1]!);
            if (Number.isFinite(zhe) && zhe > 0 && zhe < 10) {
                pushUniqueCandidate({
                    type: 'shop_discount',
                    label: text,
                    discountRate: zhe / 10,
                    confident: true,
                });
                matchedAny = true;
            }
        }

        // If promotion text could not be parsed as a confident 1-unit deal, record as non-confident
        if (!matchedAny && recordIfUnparsed) {
            pushUniqueCandidate({
                type: defaultType,
                label: text,
                confident: false,
            });
        }
    };

    // Inspect price.shopProm / price.transmitPrice / price.extraPrices
    const priceSection = (merged.price ?? (merged.componentsVO as Record<string, unknown>)?.priceVO) as
        | Record<string, unknown>
        | undefined;

    if (priceSection && typeof priceSection === 'object') {
        const shopProm = priceSection.shopProm;
        if (Array.isArray(shopProm)) {
            for (const prom of shopProm) {
                if (prom && typeof prom === 'object') {
                    const pObj = prom as Record<string, unknown>;
                    const hasContentArray = Array.isArray(pObj.content) && pObj.content.length > 0;
                    if (typeof pObj.title === 'string') {
                        addPromoText(pObj.title, 'shop_discount', !hasContentArray);
                    }
                    if (Array.isArray(pObj.content)) {
                        for (const c of pObj.content) {
                            if (typeof c === 'string') addPromoText(c, 'threshold', true);
                        }
                    }
                }
            }
        }
    }

    // Inspect resource.coupon / resource.entrances / resource.promsCalcInfo
    const resourceSection = merged.resource as Record<string, unknown> | undefined;
    if (resourceSection && typeof resourceSection === 'object') {
        const coupon = resourceSection.coupon as Record<string, unknown> | undefined;
        if (coupon && Array.isArray(coupon.couponList)) {
            for (const c of coupon.couponList) {
                if (c && typeof c === 'object') {
                    const cObj = c as Record<string, unknown>;
                    if (typeof cObj.title === 'string') addPromoText(cObj.title, 'coupon', true);
                    if (typeof cObj.subTitle === 'string') addPromoText(cObj.subTitle, 'coupon', true);
                }
            }
        }
        const entrances = resourceSection.entrances as Record<string, unknown> | undefined;
        if (entrances && typeof entrances === 'object') {
            for (const val of Object.values(entrances)) {
                if (val && typeof val === 'object') {
                    const vObj = val as Record<string, unknown>;
                    if (typeof vObj.text === 'string') addPromoText(vObj.text, 'coupon', true);
                    if (typeof vObj.subText === 'string') addPromoText(vObj.subText, 'coupon', true);
                }
            }
        }
    }

    // Inspect explicit rawPromotions array if present in normalized payloads
    if (Array.isArray(merged.rawPromotions)) {
        for (const p of merged.rawPromotions) {
            if (typeof p === 'string') {
                addPromoText(p, 'promo', true);
            } else if (p && typeof p === 'object') {
                pushUniqueCandidate(p as RawPromotionCandidate);
            }
        }
    }

    return promotions;
}

/**
 * Parses an MTOP detail response (`mtop.taobao.pcdetail.data.get` or `mtop.taobao.detail.getdetail`)
 * into a structured PartialProductData object.
 */
export function parseMtopDetailData(
    itemId: string,
    rawData: Record<string, unknown>,
    fallbackPlatform: PlatformType = 'taobao',
): PartialProductData {
    const merged = unwrapMtopDetailPayload(rawData);

    const itemNode = (merged.item ??
        (merged.componentsVO as Record<string, unknown>)?.titleVO ??
        {}) as Record<string, unknown>;
    const sellerNode = (merged.seller ??
        (merged.componentsVO as Record<string, unknown>)?.shopVO ??
        {}) as Record<string, unknown>;
    const priceNode = (merged.price ??
        (merged.componentsVO as Record<string, unknown>)?.priceVO ??
        {}) as Record<string, unknown>;
    const deliveryNode = (merged.delivery ??
        (merged.componentsVO as Record<string, unknown>)?.deliveryVO ??
        {}) as Record<string, unknown>;
    const skuBase = (merged.skuBase ?? {}) as Record<string, unknown>;
    const skuCore = (merged.skuCore ?? {}) as Record<string, unknown>;

    const shopTypeRaw = String(sellerNode.shopType ?? itemNode.shopType ?? '').toUpperCase();
    const isTmall =
        shopTypeRaw === 'B' ||
        shopTypeRaw.includes('TMALL') ||
        Boolean(sellerNode.tmall) ||
        String(itemNode.tmall) === 'true' ||
        fallbackPlatform === 'tmall';
    const platform: PlatformType = isTmall ? 'tmall' : 'taobao';

    const title = sanitizeNoPiiText(String(itemNode.title ?? itemNode.subTitle ?? '').trim()) ?? '';

    // Images
    const rawImages = Array.isArray(itemNode.images) ? itemNode.images : [];
    const images = rawImages
        .map((img) => (typeof img === 'string' ? normalizeUrl(img) : normalizeUrl((img as Record<string, string>)?.url)))
        .filter((u): u is string => Boolean(u));
    const mainImage = images[0] ?? normalizeUrl(itemNode.picUrl as string | undefined) ?? null;

    // Video URL
    let videoUrl: string | null = null;
    if (Array.isArray(itemNode.videos) && itemNode.videos.length > 0) {
        const firstVideo = itemNode.videos[0] as Record<string, unknown>;
        videoUrl = normalizeUrl(String(firstVideo?.url ?? ''));
    } else if (typeof itemNode.videoUrl === 'string') {
        videoUrl = normalizeUrl(itemNode.videoUrl);
    }

    // Description images
    const descriptionImages: string[] = [];
    const descNode = (merged.desc ?? merged.detailDesc ?? {}) as Record<string, unknown>;
    if (Array.isArray(descNode.images)) {
        for (const dImg of descNode.images) {
            const norm = normalizeUrl(typeof dImg === 'string' ? dImg : (dImg as Record<string, string>)?.url);
            if (norm) descriptionImages.push(norm);
        }
    } else if (typeof descNode.richtext === 'string' || typeof itemNode.desc === 'string') {
        const htmlStr = String(descNode.richtext ?? itemNode.desc);
        const imgMatches = htmlStr.matchAll(/(?:src|data-ks-lazyload)=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/gi);
        for (const m of imgMatches) {
            const norm = normalizeUrl(m[1]);
            if (norm && !descriptionImages.includes(norm)) descriptionImages.push(norm);
        }
    }

    // Attributes & Brand
    const attributes: Record<string, string> = {};
    let brand: string | null = (itemNode.brand as string) ?? null;
    const categoryPath: string | null = (itemNode.categoryPath as string) ?? (itemNode.categoryName as string) ?? null;

    const propsNode = (merged.props ?? {}) as Record<string, unknown>;
    if (Array.isArray(propsNode.groupProps)) {
        for (const group of propsNode.groupProps) {
            if (group && typeof group === 'object') {
                for (const val of Object.values(group as Record<string, unknown>)) {
                    if (Array.isArray(val)) {
                        for (const kvObj of val) {
                            if (kvObj && typeof kvObj === 'object') {
                                for (const [k, v] of Object.entries(kvObj as Record<string, unknown>)) {
                                    const cleanK = k.trim();
                                    const cleanV = sanitizeNoPiiText(String(v ?? '').trim()) ?? '';
                                    if (cleanK && cleanV) {
                                        attributes[cleanK] = cleanV;
                                        if (!brand && (cleanK.includes('品牌') || cleanK.toLowerCase() === 'brand')) {
                                            brand = cleanV;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if (Array.isArray(propsNode.propsList)) {
        for (const p of propsNode.propsList) {
            if (p && typeof p === 'object') {
                const name = String((p as Record<string, unknown>).name ?? '').trim();
                const value = sanitizeNoPiiText(String((p as Record<string, unknown>).value ?? '').trim()) ?? '';
                if (name && value) {
                    attributes[name] = value;
                    if (!brand && (name.includes('品牌') || name.toLowerCase() === 'brand')) {
                        brand = value;
                    }
                }
            }
        }
    }

    // Prices
    const priceObj = (priceNode.price ?? {}) as Record<string, unknown>;
    const subPriceObj = (priceNode.subPrice ?? {}) as Record<string, unknown>;
    const extraPrices = Array.isArray(priceNode.extraPrices) ? priceNode.extraPrices : [];

    const activePrice = parsePriceNumber(priceObj.priceText ?? priceNode.priceText ?? priceNode.price);
    const subPromoPrice = parsePriceNumber(subPriceObj.priceText ?? priceNode.promoPrice);
    let originalPrice = parsePriceNumber(
        (extraPrices[0] as Record<string, unknown>)?.priceText ?? priceNode.originalPrice,
    );

    const price = activePrice ?? subPromoPrice ?? null;
    const promoPrice = subPromoPrice ?? null;
    if (!originalPrice && price !== null) {
        originalPrice = price;
    }

    // Sales & Stock
    const salesTextRaw =
        (itemNode.vagueSellCount as string) ??
        (itemNode.sellCount as string) ??
        (merged.sellCount as string) ??
        (priceNode.salesText as string) ??
        null;
    const salesText = salesTextRaw !== null && salesTextRaw !== undefined ? String(salesTextRaw) : null;
    const salesCount = parseSalesCount(salesText);

    // SKUs mapping
    const propValueMap = new Map<string, { propName: string; valueName: string; image: string | null }>();
    const rawSkuProps = Array.isArray(skuBase.props) ? skuBase.props : [];
    for (const prop of rawSkuProps) {
        if (!prop || typeof prop !== 'object') continue;
        const pObj = prop as Record<string, unknown>;
        const pid = String(pObj.pid ?? '').trim();
        const propName = String(pObj.name ?? '').trim();
        const values = Array.isArray(pObj.values) ? pObj.values : [];
        for (const v of values) {
            if (!v || typeof v !== 'object') continue;
            const vObj = v as Record<string, unknown>;
            const vid = String(vObj.vid ?? '').trim();
            const valueName = String(vObj.name ?? '').trim();
            const image = normalizeUrl(vObj.image as string | undefined);
            if (pid && vid) {
                propValueMap.set(`${pid}:${vid}`, { propName, valueName, image });
            }
        }
    }

    const sku2info = (skuCore.sku2info ?? {}) as Record<string, Record<string, unknown>>;
    const rawSkus = Array.isArray(skuBase.skus) ? skuBase.skus : [];
    const skus: NonNullable<PartialProductData['skus']> = [];
    let totalStock = 0;
    let hasSkuStock = false;

    for (const rawSku of rawSkus) {
        if (!rawSku || typeof rawSku !== 'object') continue;
        const sObj = rawSku as Record<string, unknown>;
        const skuId = String(sObj.skuId ?? '').trim();
        if (!skuId || skuId === '0') continue;

        const propPath = String(sObj.propPath ?? '').trim();
        const propPairs = propPath.split(';').filter(Boolean);
        const propLabels: string[] = [];
        let skuImage: string | null = null;

        for (const pair of propPairs) {
            const mapped = propValueMap.get(pair);
            if (mapped) {
                propLabels.push(`${mapped.propName}: ${mapped.valueName}`);
                if (!skuImage && mapped.image) {
                    skuImage = mapped.image;
                }
            } else {
                propLabels.push(pair);
            }
        }

        const info = sku2info[skuId] ?? {};
        const skuPriceNode = (info.price ?? {}) as Record<string, unknown>;
        const skuSubPriceNode = (info.subPrice ?? {}) as Record<string, unknown>;
        const skuExtraPrices = Array.isArray(info.extraPrices) ? info.extraPrices : [];
        const ownSkuPrice = parsePriceNumber(skuPriceNode.priceText ?? info.priceText ?? sObj.price);
        const explicitSkuOriginalPrice = parsePriceNumber(
            (skuExtraPrices[0] as Record<string, unknown>)?.priceText ??
                info.originalPrice ??
                info.oriPrice ??
                sObj.originalPrice,
        );
        const skuPrice = ownSkuPrice ?? price;
        const skuOriginalPrice = explicitSkuOriginalPrice ?? skuPrice;
        const originalPriceFallback = explicitSkuOriginalPrice === null && skuOriginalPrice !== null;
        const skuSubPrice = parsePriceNumber(skuSubPriceNode.priceText ?? info.promoPrice);
        const skuStockRaw = info.quantity ?? sObj.quantity ?? sObj.stock;
        const skuStock =
            skuStockRaw !== undefined && skuStockRaw !== null && !Number.isNaN(Number(skuStockRaw))
                ? Number(skuStockRaw)
                : null;

        if (skuStock !== null) {
            totalStock += skuStock;
            hasSkuStock = true;
        }

        skus.push({
            skuId,
            props: propLabels.join('; ') || String(sObj.props ?? '默认规格'),
            price: skuPrice,
            originalPrice: skuOriginalPrice,
            originalPriceFallback,
            promoPrice: skuSubPrice ?? null,
            stock: skuStock,
            image: skuImage ?? mainImage,
        });
    }

    const rootInfo = sku2info['0'] ?? {};
    const rootStockRaw = rootInfo.quantity ?? itemNode.quantity ?? merged.quantity;
    const stock =
        rootStockRaw !== undefined && rootStockRaw !== null && !Number.isNaN(Number(rootStockRaw))
            ? Number(rootStockRaw)
            : hasSkuStock
              ? totalStock
              : null;

    // Shipping & Delivery
    const shipFrom = deliveryNode.from ? String(deliveryNode.from).trim() : null;
    const postageStr = deliveryNode.postage ? String(deliveryNode.postage).trim() : '';
    let shippingFee: number | null = null;
    let shippingNote: string | null = null;
    const isConditionalFreeShipping =
        /满.*(?:包邮|免运费|免邮)/.test(postageStr) ||
        (/(?:包邮|免运费|免邮)/.test(postageStr) && /(?:满|件|元以上|起)/.test(postageStr));
    if (isConditionalFreeShipping) {
        shippingNote = postageStr;
        const withoutCondition = postageStr
            .replace(/满\s*\d+(?:\.\d+)?\s*(?:元|件)?(?:以上|起)?\s*(?:包邮|免运费|免邮)/g, ' ')
            .replace(/\d+(?:\.\d+)?\s*(?:元|件)(?:以上|起)?\s*(?:包邮|免运费|免邮)/g, ' ')
            .trim();
        const conditionalFeeMatch =
            withoutCondition.match(/(?:快递|运费|邮费|平邮|EMS)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d+)?)/i) ??
            withoutCondition.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
        if (conditionalFeeMatch) {
            const parsedFee = parseFloat(conditionalFeeMatch[1]!);
            shippingFee = Number.isFinite(parsedFee) && parsedFee >= 0 ? Math.round(parsedFee * 100) / 100 : null;
        } else {
            shippingFee = null;
        }
    } else if (postageStr.includes('免运费') || postageStr.includes('包邮') || postageStr.includes('免邮')) {
        shippingFee = 0;
    } else if (postageStr) {
        const feeMatch =
            postageStr.match(/(?:快递|运费|邮费|平邮|EMS)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d+)?)/i) ??
            postageStr.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
        if (feeMatch) {
            const parsedFee = parseFloat(feeMatch[1]!);
            shippingFee = Number.isFinite(parsedFee) && parsedFee >= 0 ? Math.round(parsedFee * 100) / 100 : null;
        }
    }

    // Seller & Shop Info
    const explicitShopId = sellerNode.shopId ? String(sellerNode.shopId).trim() : null;
    const shopId = explicitShopId;
    const shopName = sellerNode.shopName ? String(sellerNode.shopName).trim() : sellerNode.nick ? String(sellerNode.nick).trim() : null;
    const shopType = isTmall
        ? (String(sellerNode.shopTypeOriginal ?? 'tmall'))
        : (String(sellerNode.shopTypeOriginal ?? 'taobao'));
    const shopUrl = normalizeUrl(
        (sellerNode.taoShopUrl as string | undefined) ??
            (sellerNode.shopUrl as string | undefined) ??
            (explicitShopId ? `https://shop${explicitShopId}.taobao.com` : undefined),
    );

    let sellerScores: SellerScores | null = null;
    if (Array.isArray(sellerNode.evaluates)) {
        const scores: SellerScores = { description: null, service: null, logistics: null };
        for (const ev of sellerNode.evaluates) {
            if (!ev || typeof ev !== 'object') continue;
            const eObj = ev as Record<string, unknown>;
            const titleStr = String(eObj.title ?? '');
            const scoreVal = parseFloat(String(eObj.score ?? ''));
            if (!Number.isFinite(scoreVal)) continue;
            if (titleStr.includes('描') || titleStr.includes('宝贝')) scores.description = scoreVal;
            else if (titleStr.includes('物') || titleStr.includes('发')) scores.logistics = scoreVal;
            else if (titleStr.includes('服') || titleStr.includes('卖家')) scores.service = scoreVal;
        }
        if (scores.description !== null || scores.service !== null || scores.logistics !== null) {
            sellerScores = scores;
        }
    }

    const creditLevel = sellerNode.creditLevel ? String(sellerNode.creditLevel) : null;
    const startsText = String(sellerNode.starts ?? sellerNode.shopAge ?? '').trim();
    let shopAgeYears: number | null = null;
    const yearMatch = startsText.match(/\b(199\d|20\d{2})\b/);
    if (yearMatch) {
        const openingYear = Number(yearMatch[1]);
        const currentYear = new Date().getFullYear();
        if (openingYear <= currentYear) {
            shopAgeYears = Math.max(0, currentYear - openingYear);
        }
    } else {
        const ageMatch = startsText.match(/(\d+)/);
        if (ageMatch) {
            const ageVal = Number(ageMatch[1]);
            if (ageVal >= 0 && ageVal < 100) {
                shopAgeYears = ageVal;
            }
        }
    }

    const allItemCountRaw = sellerNode.allItemCount;
    const shopProductCount =
        allItemCountRaw !== undefined &&
        allItemCountRaw !== null &&
        String(allItemCountRaw).trim() !== '' &&
        !Number.isNaN(Number(allItemCountRaw))
            ? Number(allItemCountRaw)
            : null;

    const rawPromotions = extractRawPromotionsFromDetail(merged);

    const canonicalUrl =
        platform === 'tmall'
            ? `https://detail.tmall.com/item.htm?id=${itemId}`
            : `https://item.taobao.com/item.htm?id=${itemId}`;

    return {
        itemId,
        url: canonicalUrl,
        platform,
        title,
        brand,
        categoryPath,
        mainImage,
        images,
        descriptionImages,
        videoUrl,
        attributes,
        price,
        originalPrice,
        promoPrice,
        rawPromotions,
        salesText,
        salesCount,
        stock,
        skus,
        shipFrom,
        shippingFee,
        shippingNote,
        shopId,
        shopName,
        shopType,
        shopUrl,
        sellerScores,
        creditLevel,
        shopAgeYears,
        shopProductCount,
        detailSource: 'mtop_detail',
        isDetailFetched: true,
    };
}

/**
 * Parses `world.taobao.com` SSR PDP HTML (`window.__ICE_APP_CONTEXT__` `pdp-pc` / `pdp-intl` / `pdp` route)
 * into a structured PartialProductData object.
 */
export function parseWorldTaobaoPdpHtml(
    itemId: string,
    html: string,
    pageUrl: string,
    preferredPlatform: PlatformType = 'taobao',
): PartialProductData | null {
    const iceContext = extractIceAppContext(html);
    if (!iceContext || !iceContext.loaderData || typeof iceContext.loaderData !== 'object') {
        return null;
    }

    for (const loaderEntry of Object.values(iceContext.loaderData as Record<string, unknown>)) {
        if (!loaderEntry || typeof loaderEntry !== 'object') continue;
        const dataNode = (loaderEntry as Record<string, unknown>).data as Record<string, unknown> | undefined;
        const httpData = dataNode?.httpData as Record<string, unknown> | undefined;
        const normalItem = httpData?.normalItemResponse as Record<string, unknown> | undefined;
        if (!normalItem || typeof normalItem !== 'object') continue;
        const normalRoot = (
            normalItem.data && typeof normalItem.data === 'object' && !Array.isArray(normalItem.data)
                ? normalItem.data
                : normalItem
        ) as Record<string, unknown>;

        const itemNode = (normalRoot.item ?? {}) as Record<string, unknown>;
        const priceNode = (normalRoot.itemPrice ?? {}) as Record<string, unknown>;
        const sellerNode = (normalRoot.seller ?? {}) as Record<string, unknown>;
        const rateNode = (normalRoot.rate ?? {}) as Record<string, unknown>;
        const couponOuter = (normalRoot.coupon ?? {}) as Record<string, unknown>;
        const couponNode = (couponOuter.coupon ?? {}) as Record<string, unknown>;

        const rawTitle = String(itemNode.title ?? '').trim();
        const title = sanitizeNoPiiText(rawTitle) ?? '';
        if (!title) continue;

        const trueItemId =
            itemNode.itemId && /^\d{5,20}$/.test(String(itemNode.itemId).trim())
                ? String(itemNode.itemId).trim()
                : itemId;
        const slugFromUrl = extractWorldTaobaoSlugFromUrl(pageUrl);
        const explicitShopId = sellerNode.shopId ? String(sellerNode.shopId).trim() : null;
        if (slugFromUrl && /^\d{5,20}$/.test(trueItemId)) {
            registerItemSlug(trueItemId, slugFromUrl, explicitShopId ?? undefined);
        }

        const seoItemType = String(itemNode.seoItemType ?? '').toLowerCase();
        const shopName = sellerNode.shopName ? sanitizeNoPiiText(String(sellerNode.shopName).trim()) : null;
        const isTmall =
            seoItemType === 'tmall' ||
            Boolean(shopName && /旗舰店|旗艦店|专卖店|專賣店|专营店|專營店|官方/.test(shopName)) ||
            preferredPlatform === 'tmall';
        const platform: PlatformType = isTmall ? 'tmall' : 'taobao';

        const rawImages = Array.isArray(itemNode.images) ? itemNode.images : [];
        const images = rawImages
            .map((img) => normalizeUrl(typeof img === 'string' ? img : undefined))
            .filter((u): u is string => Boolean(u));
        const mainImage = images[0] ?? null;

        const descriptionImages: string[] = [];
        if (typeof itemNode.itemDesc === 'string' && itemNode.itemDesc.trim()) {
            const imgMatches = itemNode.itemDesc.matchAll(
                /(?:src|data-ks-lazyload)=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/gi,
            );
            for (const m of imgMatches) {
                const norm = normalizeUrl(m[1]);
                if (norm && !descriptionImages.includes(norm)) {
                    descriptionImages.push(norm);
                }
            }
        }

        const origPriceVal = parsePriceNumber(priceNode.originalPrice);
        const promoPriceVal = parsePriceNumber(priceNode.promotionPrice);
        const price = promoPriceVal ?? origPriceVal ?? null;
        const rangeSource = String(priceNode.promotionPrice ?? priceNode.originalPrice ?? '');
        const rangeMax = rangeSource.includes('-') ? parsePriceRangeMax(rangeSource) : null;
        const originalPrice = origPriceVal ?? price;
        const promoPrice =
            promoPriceVal !== null && origPriceVal !== null && promoPriceVal < origPriceVal ? promoPriceVal : null;

        // Extract categoryPath from breadcrumbModuleResponse
        let categoryPath: string | null = null;
        const breadcrumbModule = httpData?.breadcrumbModuleResponse as Record<string, unknown> | undefined;
        const breadcrumbList = breadcrumbModule?.breadcrumbList;
        if (Array.isArray(breadcrumbList) && breadcrumbList.length > 0) {
            const crumbs = breadcrumbList
                .map((b) => String((b as Record<string, unknown>)?.name ?? '').trim())
                .filter((name) => name && !/^(?:home|首頁|首页|淘宝网|淘寶網)$/i.test(name));
            if (crumbs.length > 0) {
                categoryPath = crumbs.join(' > ');
            }
        }

        const attributes: Record<string, string> = {};
        let brand: string | null = null;
        const skus: NonNullable<PartialProductData['skus']> = [];
        const seenSkuProps = new Set<string>();

        // The world.taobao.com SSR page has no SKU table. Review rows only carry the variant label the buyer chose,
        // with no per-variant price or stock, so they are NOT emitted as SKUs (v1.2). They only seed `attributes`.
        if (Array.isArray(rateNode.rateList)) {
            for (const r of rateNode.rateList) {
                if (!r || typeof r !== 'object') continue;
                const skuInfo = String((r as Record<string, unknown>).skuInfo ?? '').trim();
                if (skuInfo && !seenSkuProps.has(skuInfo)) {
                    seenSkuProps.add(skuInfo);
                    const colonIdx = skuInfo.search(/[:：]/);
                    if (colonIdx > 0) {
                        const k = skuInfo.slice(0, colonIdx).trim();
                        const v = sanitizeNoPiiText(skuInfo.slice(colonIdx + 1).trim()) ?? '';
                        if (k && v && !attributes[k]) {
                            attributes[k] = v;
                        }
                    }
                }
            }
        }


        const rawPromotions: RawPromotionCandidate[] = [];
        const couponAmount = parsePriceNumber(couponNode.couponAmount);
        if (couponAmount !== null && couponAmount > 0) {
            rawPromotions.push({
                type: 'coupon',
                label: `领券立减${couponAmount}元`,
                threshold: 0,
                amountOff: couponAmount,
                confident: true,
            });
        }

        const shipFrom = itemNode.location ? String(itemNode.location).trim() : null;
        const salesTextRaw = itemNode.sellCount ? String(itemNode.sellCount).trim() : null;
        const salesCount = parseSalesCount(salesTextRaw);

        let sellerScores: SellerScores | null = null;
        if (Array.isArray(sellerNode.evaluates)) {
            const scores: SellerScores = { description: null, service: null, logistics: null };
            for (const ev of sellerNode.evaluates) {
                if (!ev || typeof ev !== 'object') continue;
                const eObj = ev as Record<string, unknown>;
                const titleStr = String(eObj.title ?? '');
                const typeStr = String(eObj.type ?? '').toLowerCase();
                const scoreVal = parseFloat(String(eObj.score ?? ''));
                if (!Number.isFinite(scoreVal)) continue;
                if (titleStr.includes('描') || titleStr.includes('寶貝') || titleStr.includes('宝贝') || typeStr === 'desc') {
                    scores.description = scoreVal;
                } else if (titleStr.includes('物') || titleStr.includes('發') || titleStr.includes('发') || typeStr === 'post') {
                    scores.logistics = scoreVal;
                } else if (titleStr.includes('服') || titleStr.includes('賣') || titleStr.includes('卖') || typeStr === 'serv') {
                    scores.service = scoreVal;
                }
            }
            if (scores.description !== null || scores.service !== null || scores.logistics !== null) {
                sellerScores = scores;
            }
        }

        const creditLevel = sellerNode.creditLevel ? String(sellerNode.creditLevel) : null;
        const startsText = String(sellerNode.starts ?? '').trim();
        let shopAgeYears: number | null = null;
        const yearMatch = startsText.match(/\b(199\d|20\d{2})\b/);
        if (yearMatch) {
            const openingYear = Number(yearMatch[1]);
            const currentYear = new Date().getFullYear();
            if (openingYear <= currentYear) {
                shopAgeYears = Math.max(0, currentYear - openingYear);
            }
        }

        const allItemCountRaw = sellerNode.allItemCount;
        const shopProductCount =
            allItemCountRaw !== undefined &&
            allItemCountRaw !== null &&
            String(allItemCountRaw).trim() !== '' &&
            !Number.isNaN(Number(allItemCountRaw))
                ? Number(allItemCountRaw)
                : null;

        const canonicalUrl =
            platform === 'tmall'
                ? `https://detail.tmall.com/item.htm?id=${trueItemId}`
                : `https://item.taobao.com/item.htm?id=${trueItemId}`;

        return {
            itemId: trueItemId,
            ...(slugFromUrl ? { itemIdStr: slugFromUrl } : {}),
            url: canonicalUrl,
            platform,
            title,
            brand,
            categoryPath,
            mainImage,
            images,
            descriptionImages,
            videoUrl: null,
            attributes,
            price,
            originalPrice,
            promoPrice,
            minPrice: price,
            maxPrice: rangeMax ?? (originalPrice !== null && price !== null ? Math.max(originalPrice, price) : price),
            detailSource: 'world_ssr',
            rawPromotions,
            salesText: salesTextRaw,
            salesCount,
            stock: null,
            skus,
            shipFrom,
            shippingFee: normalRoot.freeShipping === true ? 0 : null,
            shippingNote: normalRoot.freeShipping === true ? '包邮 (free shipping)' : null,
            shopId: explicitShopId,
            shopName,
            shopType: platform,
            shopUrl: explicitShopId ? `https://shop${explicitShopId}.taobao.com` : null,
            sellerScores,
            creditLevel,
            shopAgeYears,
            shopProductCount,
            isDetailFetched: true,
        };
    }

    return null;
}

/**
 * Parses a fallback HTML product detail page from `world.taobao.com/item/<id>.htm` or `m.intl.taobao.com`
 * when an MTOP API call 404s or requires fallback.
 */
export function parseHtmlDetailFallback(
    itemId: string,
    html: string,
    pageUrl: string,
    preferredPlatform: PlatformType = 'taobao',
): PartialProductData | null {
    // 0. Check world.taobao.com SSR `window.__ICE_APP_CONTEXT__` (`pdp-pc` / `pdp-intl` / `pdp`)
    const worldPdp = parseWorldTaobaoPdpHtml(itemId, html, pageUrl, preferredPlatform);
    if (worldPdp && worldPdp.title) {
        return worldPdp;
    }

    // 1. Check for embedded __INITIAL_DATA__ or _DATA_Detail JSON
    const jsonPatterns = [
        /window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/i,
        /var\s+_DATA_Detail\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/i,
    ];
    for (const pattern of jsonPatterns) {
        const m = html.match(pattern);
        if (m?.[1]) {
            try {
                const parsedJson = JSON.parse(m[1]) as Record<string, unknown>;
                const extracted = parseMtopDetailData(itemId, parsedJson, preferredPlatform);
                if (extracted.title) {
                    return extracted;
                }
            } catch {
                // Fall through to Cheerio DOM extraction
            }
        }
    }

    if (
        pageUrl.includes('404-301') ||
        pageUrl.includes('err.taobao.com') ||
        pageUrl.includes('login.taobao.com') ||
        pageUrl.includes('login.tmall.com') ||
        pageUrl.includes('havanaone/login') ||
        pageUrl.includes('_____tmd_____') ||
        /^https?:\/\/world\.taobao\.com\/?(?:\?.*)?$/i.test(pageUrl)
    ) {
        return null;
    }

    const $ = cheerio.load(html);
    const title = sanitizeNoPiiText(
        $('h1, .tb-main-title, .item-title, [class*="ItemTitle"], title')
            .first()
            .text()
            .replace(/[-_]\s*(?:淘宝网|天猫|Taobao|Tmall).*$/i, '')
            .trim(),
    );

    if (
        !title ||
        title.includes('404') ||
        title.includes('页面不存在') ||
        title.includes('宝贝不存在') ||
        title.includes('天貓淘寶海外') ||
        title.includes('天猫淘宝海外') ||
        /^(?:登录|登錄|请登录|請登錄|login|sign in|taobao|淘寶|淘宝|淘宝网|天猫|tmall)(?:\s*[|-]\s*(?:taobao|淘寶|淘宝|淘宝网|天猫|tmall))*$/i.test(title)
    ) {
        return null;
    }

    const priceText = $(
        '.tb-rmb-num, .tm-price, [class*="Price--priceText"], .price, [itemprop="price"]',
    )
        .first()
        .text()
        .trim();
    const price = parsePriceNumber(priceText);

    const images: string[] = [];
    $('#J_UlThumb img, .tb-thumb img, [class*="PicGallery"] img, .item-gallery img').each((_, el) => {
        const rawSrc = $(el).attr('data-src') || $(el).attr('src');
        const norm = normalizeUrl(rawSrc?.replace(/_\d+x\d+.*$/, ''));
        if (norm && !images.includes(norm)) {
            images.push(norm);
        }
    });
    const mainImage =
        images[0] ??
        normalizeUrl($('#J_ImgBooth').attr('src') || $('meta[property="og:image"]').attr('content')) ??
        null;

    const attributes: Record<string, string> = {};
    let brand: string | null = null;
    $('#J_AttrUL li, .attributes-list li, .tb-property li').each((_, el) => {
        const txt = $(el).text().trim();
        const colonIdx = txt.search(/[:：]/);
        if (colonIdx > 0) {
            const k = txt.slice(0, colonIdx).trim();
            const v = sanitizeNoPiiText(txt.slice(colonIdx + 1).trim()) ?? '';
            if (k && v) {
                attributes[k] = v;
                if (!brand && (k.includes('品牌') || k.toLowerCase() === 'brand')) {
                    brand = v;
                }
            }
        }
    });

    const shopName =
        $('.tb-shop-name a, .slogo-shopname, [class*="ShopHeader--shopName"]').first().text().trim() || null;
    const shopHref = $('.tb-shop-name a, .slogo-shopname').first().attr('href');
    const shopUrl = normalizeUrl(shopHref);
    const platform: PlatformType =
        pageUrl.includes('tmall.') || html.includes('tmall.com') ? 'tmall' : preferredPlatform;

    return {
        itemId,
        url: pageUrl,
        platform,
        title,
        brand,
        categoryPath: null,
        mainImage,
        images,
        descriptionImages: [],
        videoUrl: null,
        attributes,
        price,
        originalPrice: price,
        promoPrice: null,
        rawPromotions: [],
        salesText: null,
        salesCount: null,
        stock: null,
        skus: [],
        shipFrom: null,
        shippingFee: null,
        shippingNote: null,
        shopId: null,
        shopName,
        shopType: platform,
        shopUrl,
        sellerScores: null,
        creditLevel: null,
        shopAgeYears: null,
        shopProductCount: null,
        isDetailFetched: true,
    };
}

export interface ProductDetailFetchOptions {
    itemIdStr?: string | null;
    preferredUrl?: string | null;
    shopId?: string | null;
    hintTitle?: string | null;
}

/**
 * Production Layered Product Detail Source:
 * 1. If `world.taobao.com` `itemIdStr` slug is available, fetches `world.taobao.com/lang/en-us/item/<slug>.htm` SSR PDP
 * 2. Calls `mtop.taobao.pcdetail.data.get` (v1.0) with warmed-up session cookies
 * 3. Falls back to `mtop.taobao.detail.getdetail` (v6.0)
 * 4. Dynamically resolves `itemIdStr` via shop/search on `world.taobao.com` or tries `buildItemCandidateUrls`
 * 5. Falls back to `PlaywrightCrawler` when enabled.
 */
export class LayeredProductDetailSource implements ProductDetailSource {
    public readonly name = 'LayeredH5AndWorldDetailSource';
    private readonly h5Client: TaobaoH5Client;
    private playwrightFallbackFn?: (
        itemId: string,
        preferredPlatform: PlatformType,
        itemIdStr?: string | null,
    ) => Promise<DataSourceResult<PartialProductData>>;

    constructor(
        h5Client: TaobaoH5Client,
        options?: {
            playwrightFallbackFn?: (
                itemId: string,
                preferredPlatform: PlatformType,
                itemIdStr?: string | null,
            ) => Promise<DataSourceResult<PartialProductData>>;
        },
    ) {
        this.h5Client = h5Client;
        this.playwrightFallbackFn = options?.playwrightFallbackFn;
    }

    public setPlaywrightFallback(
        fn: (
            itemId: string,
            preferredPlatform: PlatformType,
            itemIdStr?: string | null,
        ) => Promise<DataSourceResult<PartialProductData>>,
    ): void {
        this.playwrightFallbackFn = fn;
    }

    private async fetchViaWorldItemSlug(
        cleanId: string,
        slug: string,
        preferredPlatform: PlatformType,
    ): Promise<PartialProductData | null> {
        const enUrl = `https://world.taobao.com/lang/en-us/item/${slug}.htm`;
        const enRes = await this.h5Client.fetchPage(enUrl, {
            referer: 'https://world.taobao.com/',
            urlType: 'product_detail',
        });
        if (enRes.ok && enRes.data) {
            const parsedEn = parseWorldTaobaoPdpHtml(cleanId, enRes.data.body, enRes.data.finalUrl || enUrl, preferredPlatform);
            if (parsedEn && parsedEn.title) {
                return parsedEn;
            }
        }

        const zhUrl = `https://world.taobao.com/item/${slug}.htm`;
        const zhRes = await this.h5Client.fetchPage(zhUrl, {
            referer: 'https://world.taobao.com/',
            urlType: 'product_detail',
        });
        if (zhRes.ok && zhRes.data) {
            const parsedZh = parseWorldTaobaoPdpHtml(cleanId, zhRes.data.body, zhRes.data.finalUrl || zhUrl, preferredPlatform);
            if (parsedZh && parsedZh.title) {
                return parsedZh;
            }
        }
        return null;
    }

    public async fetchProductDetail(
        itemId: string,
        preferredPlatform: PlatformType = 'taobao',
        options?: ProductDetailFetchOptions,
    ): Promise<DataSourceResult<PartialProductData>> {
        const cleanId = String(itemId).trim();
        const knownSlug =
            options?.itemIdStr ??
            (options?.preferredUrl ? extractWorldTaobaoSlugFromUrl(options.preferredUrl) : null) ??
            getSlugForItemId(cleanId);
        const attempts: string[] = [];
        let sawBlock = false;
        let sawNotFound = false;
        const note = (layer: string, res?: DataSourceResult<unknown>, fallback = 'no usable data') => {
            if (res?.blocked) sawBlock = true;
            if (res?.notFound) sawNotFound = true;
            attempts.push(`${layer}: ${res?.errorReason ?? fallback}`);
        };

        // Layer 0: world.taobao.com SSR PDP when the encrypted itemIdStr slug is known (fast, rarely blocked).
        if (knownSlug) {
            const worldData = await this.fetchViaWorldItemSlug(cleanId, knownSlug, preferredPlatform);
            if (worldData && worldData.title) {
                return { ok: true, data: worldData };
            }
            note('world_ssr');
        }

        // Layer 0.5: discover the slug from the shop's world.taobao.com catalogue (one request) when a shopId is known.
        if (!knownSlug) {
            const shopIdHint = options?.shopId ?? getShopIdForItemId(cleanId);
            if (shopIdHint) {
                const dianpuUrl = `https://world.taobao.com/dianpu/${shopIdHint}.htm`;
                const dianpuRes = await this.h5Client.fetchPage(dianpuUrl, {
                    referer: 'https://world.taobao.com/',
                    urlType: 'shop',
                });
                if (dianpuRes.ok && dianpuRes.data) {
                    parseShopHtml(dianpuRes.data.body, dianpuUrl, shopIdHint);
                }
                const discovered = getSlugForItemId(cleanId);
                if (discovered) {
                    const worldData = await this.fetchViaWorldItemSlug(cleanId, discovered, preferredPlatform);
                    if (worldData && worldData.title) {
                        return { ok: true, data: worldData };
                    }
                }
            }
        }

        // Layer 1: overseas SEO PDP API by numeric itemId (what m.intl.taobao.com uses), via a TW residential IP.
        // The API is registered on the intl gateway for overseas visitors; fall back to the main gateway when it is not.
        const seoHosts: Array<'h5api-intl.m.taobao.com' | 'h5api.m.taobao.com'> = ['h5api-intl.m.taobao.com', 'h5api.m.taobao.com'];
        for (const seoHost of seoHosts) {
            if (this.h5Client.isMtopFastFailExhausted()) break;
            const seoRes = await this.h5Client.requestMtop<Record<string, unknown>>({
                api: 'mtop.ovs.traffic.landing.seopdp.querySeoPdpPage',
                version: '1.0',
                platform: preferredPlatform,
                host: seoHost,
                referer: 'https://m.intl.taobao.com/',
                countryOverride: 'TW',
                maxAttempts: 1,
                skipBreaker: true,
                data: { itemId: cleanId, pageType: 'list-item-wap', lang: 'zh-TW' },
            });
            if (seoRes.ok && seoRes.data) {
                const parsed = parseSeoPdpApiData(cleanId, seoRes.data, preferredPlatform);
                if (parsed && parsed.title) {
                    return { ok: true, data: parsed };
                }
            }
            note(`seo_pdp_api(${seoHost.startsWith('h5api-intl') ? 'intl' : 'main'})`, seoRes);
            if (!String(seoRes.errorReason ?? '').includes('API_NOT_FOUND')) break;
        }

        // Layer 2: Playwright (real browser runs Taobao's own signed requests on m.intl.taobao.com). Early, not last.
        if (this.playwrightFallbackFn) {
            const pwRes = await this.playwrightFallbackFn(cleanId, preferredPlatform, knownSlug);
            if (pwRes.ok && pwRes.data && pwRes.data.title) {
                return { ok: true, data: { ...pwRes.data, detailSource: pwRes.data.detailSource ?? 'playwright' } };
            }
            note('playwright', pwRes);
        }

        // Layer 3: overseas detail API, then the classic H5 detail APIs. One attempt each; skipped once MTOP keeps blocking.
        const mtopLayers: Array<{ label: string; call: () => Promise<DataSourceResult<Record<string, unknown>>> }> = [
            {
                label: 'mtop.taobao.detail.data.get(oversea)',
                call: () =>
                    this.h5Client.requestMtop<Record<string, unknown>>({
                        api: 'mtop.taobao.detail.data.get',
                        version: '1.0',
                        platform: preferredPlatform,
                        host: 'h5api-intl.m.taobao.com',
                        referer: 'https://m.intl.taobao.com/',
                        countryOverride: 'TW',
                        maxAttempts: 1,
                        skipBreaker: true,
                        extraParams: { ttid: '201200@taobao_h5_10.2.10' },
                        data: {
                            exParams: JSON.stringify({ countryCode: 'TW', channel: 'oversea_seo', ultron2: 'true' }),
                            detail_v: '3.5.0',
                            channel: 'oversea_seo',
                            id: cleanId,
                        },
                    }),
            },
            {
                label: 'mtop.taobao.pcdetail.data.get',
                call: () =>
                    this.h5Client.requestMtop<Record<string, unknown>>({
                        api: 'mtop.taobao.pcdetail.data.get',
                        version: '1.0',
                        platform: preferredPlatform,
                        maxAttempts: 1,
                        skipBreaker: true,
                        data: {
                            id: cleanId,
                            detail_v: '3.3.2',
                            exParams: JSON.stringify({
                                id: cleanId,
                                queryParams: `id=${cleanId}`,
                                domain:
                                    preferredPlatform === 'tmall' ? 'https://detail.tmall.com' : 'https://item.taobao.com',
                            }),
                        },
                    }),
            },
            {
                label: 'mtop.taobao.detail.getdetail',
                call: () =>
                    this.h5Client.requestMtop<Record<string, unknown>>({
                        api: 'mtop.taobao.detail.getdetail',
                        version: '6.0',
                        platform: preferredPlatform,
                        maxAttempts: 1,
                        skipBreaker: true,
                        data: { itemNumId: cleanId, detail_v: '8.0.0', exParams: JSON.stringify({ itemNumId: cleanId }) },
                    }),
            },
        ];
        for (const layer of mtopLayers) {
            if (this.h5Client.isMtopFastFailExhausted()) {
                attempts.push(`${layer.label}: skipped (MTOP blocked ${this.h5Client.getMtopFastFailBlocks()}x this run)`);
                continue;
            }
            const res = await layer.call();
            if (res.ok && res.data) {
                const parsed = parseMtopDetailData(cleanId, res.data, preferredPlatform);
                if (parsed.title) {
                    return { ok: true, data: parsed };
                }
            }
            note(layer.label, res);
            if (res.notFound) break;
        }

        // Layer 4: legacy numeric world.taobao.com URL (normally 404s, detected in one request without retries)
        if (!this.h5Client.circuitBreaker.isTripped()) {
            const legacyUrl = `https://world.taobao.com/item/${cleanId}.htm`;
            const pageRes = await this.h5Client.fetchPage(legacyUrl, { urlType: 'product_detail' });
            if (pageRes.ok && pageRes.data) {
                const parsedHtml = parseHtmlDetailFallback(cleanId, pageRes.data.body, pageRes.data.finalUrl || legacyUrl, preferredPlatform);
                if (parsedHtml && parsedHtml.title) {
                    return { ok: true, data: { ...parsedHtml, detailSource: 'world_html' } };
                }
            }
        }

        const summary = attempts.join(' || ');
        const headline = sawNotFound
            ? `Item ${cleanId} not found or delisted`
            : sawBlock
              ? `Taobao anti-bot protection blocked every detail source for item ${cleanId}`
              : `Could not extract product detail for item ${cleanId}`;
        return {
            ok: false,
            blocked: sawBlock && !sawNotFound,
            notFound: sawNotFound,
            errorReason: `${headline}. Tried: ${summary || 'no sources available'}. Tip: world.taobao.com item URLs and keyword/shop modes are the most reliable inputs.`,
        };
    }
}
