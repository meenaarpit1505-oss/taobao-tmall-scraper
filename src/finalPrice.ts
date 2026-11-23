import type {
    DiscountBreakdownItem,
    PartialProductData,
    PriceType,
    RawPromotionCandidate,
    SkuItem,
} from './types.js';
import { extractRawPromotionsFromDetail } from './sources/productDetailSource.js';

export interface FinalPriceComputationResult {
    finalPrice: number | null;
    finalPriceDiscounts: DiscountBreakdownItem[];
    unappliedDiscounts: string[];
    priceType: PriceType;
}

/**
 * Translates common Chinese coupon/threshold labels into concise English (`"满300减40"` -> `"Spend ¥300 Save ¥40"`).
 */
export function translatePromoLabelToEn(label: string): string {
    const thresholdMatch = label.match(/满\s*(\d+(?:\.\d+)?)\s*元?\s*(?:减|立减|省)\s*(\d+(?:\.\d+)?)/);
    if (thresholdMatch) {
        return `Spend ¥${thresholdMatch[1]} Save ¥${thresholdMatch[2]}`;
    }
    const directMatch =
        label.match(/(?:立减|直降|无门槛(?:立减|优惠)?|领券减|店铺券减)\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*元?/) ||
        label.match(/(\d+(?:\.\d+)?)\s*元\s*无门槛/);
    if (directMatch) {
        return `Instant Off ¥${directMatch[1]}`;
    }
    const zheMatch = label.match(/(\d(?:\.\d)?)\s*折/);
    if (zheMatch) {
        const pctOff = Math.round((10 - parseFloat(zheMatch[1])) * 10);
        return `${pctOff}% Off (${zheMatch[1]}折)`;
    }
    return label;
}

/**
 * Parses an array of raw strings or RawPromotionCandidate objects into normalized RawPromotionCandidate items.
 */
export function normalizePromotionCandidates(
    inputs?: Array<RawPromotionCandidate | string>,
): RawPromotionCandidate[] {
    if (!inputs || inputs.length === 0) return [];
    const rawList: RawPromotionCandidate[] = [];
    const stringsToParse: string[] = [];

    for (const item of inputs) {
        if (typeof item === 'string') {
            stringsToParse.push(item);
        } else if (item && typeof item === 'object') {
            const isZhijiang = item.label.includes('直降') && !/满\s*\d+/.test(item.label);
            rawList.push(isZhijiang ? { ...item, alreadyInPromoPrice: true } : item);
        }
    }

    if (stringsToParse.length > 0) {
        const parsedFromStrings = extractRawPromotionsFromDetail({ rawPromotions: stringsToParse });
        rawList.push(...parsedFromStrings);
    }

    // Dedupe confident candidates by (type-normalized threshold, amount, discountRate, fixedPrice)
    const out: RawPromotionCandidate[] = [];
    const seenDealKeys = new Set<string>();
    const seenUnparsedLabels = new Set<string>();

    for (const c of rawList) {
        if (!c.confident) {
            if (!seenUnparsedLabels.has(c.label)) {
                seenUnparsedLabels.add(c.label);
                out.push(c);
            }
            continue;
        }
        if (c.alreadyInPromoPrice) {
            out.push(c);
            continue;
        }
        const key = `${c.threshold ?? 0}|${c.amountOff ?? 0}|${c.discountRate ?? 0}|${c.fixedPrice ?? 0}`;
        if (seenDealKeys.has(key)) continue;
        seenDealKeys.add(key);
        out.push(c);
    }

    return out;
}

function evaluateCandidateOff(
    candidate: RawPromotionCandidate,
    workingPrice: number,
    startingPrice: number,
): number {
    const minThreshold = candidate.threshold ?? 0;
    if (startingPrice < minThreshold) return 0;
    let off = 0;
    if (candidate.amountOff !== undefined && candidate.amountOff > 0) {
        off = candidate.amountOff;
    } else if (candidate.discountRate !== undefined && candidate.discountRate > 0 && candidate.discountRate < 1) {
        off = Math.round(workingPrice * (1 - candidate.discountRate) * 100) / 100;
    } else if (candidate.fixedPrice !== undefined && candidate.fixedPrice > 0 && candidate.fixedPrice < workingPrice) {
        off = Math.round((workingPrice - candidate.fixedPrice) * 100) / 100;
    }
    return off > 0 && off < workingPrice ? off : 0;
}

/**
 * Computes the real final price for a single price point (item or SKU) given H5 promotion candidates.
 *
 * Rules:
 * - Only treats coupons, shop discounts, threshold deals ("满X减Y"), and confirmed promos as discounts.
 * - Never counts a plain crossed-out price (originalPrice > price) as a discount.
 * - Deduplicates deals by (type-normalized threshold, amount).
 * - Does not stack shop discount + threshold + coupon unless the data confirms they combine; otherwise applies the single best one.
 * - Treats "直降" as possibly already in promoPrice and never subtracts it again.
 * - If ANY deal cannot be parsed, sets priceType to "partial" and lists unparsed deals in unappliedDiscounts[].
 */
export function computeSingleFinalPrice(params: {
    price: number | null;
    originalPrice?: number | null;
    promoPrice?: number | null;
    promotions?: Array<RawPromotionCandidate | string>;
    isDetailFetched?: boolean;
    allowStacking?: boolean;
}): FinalPriceComputationResult {
    const { price, promoPrice = null, isDetailFetched = true, allowStacking = false } = params;
    const startingPrice = promoPrice !== null && promoPrice !== undefined && promoPrice > 0 ? promoPrice : price;

    if (startingPrice === null || startingPrice === undefined || !Number.isFinite(startingPrice) || startingPrice <= 0) {
        return {
            finalPrice: null,
            finalPriceDiscounts: [],
            unappliedDiscounts: [],
            priceType: 'unknown',
        };
    }

    // If full H5 detail was not fetched (e.g. search listing only with includeDetails=false), never guess finalPrice
    if (!isDetailFetched) {
        return {
            finalPrice: null,
            finalPriceDiscounts: [],
            unappliedDiscounts: [],
            priceType: promoPrice !== null ? 'promo_only' : 'base_price',
        };
    }

    const candidates = normalizePromotionCandidates(params.promotions);
    const unparsedCandidates = candidates.filter((c) => !c.confident);
    const confidentCandidates = candidates.filter(
        (c) => c.confident && !c.alreadyInPromoPrice && !(c.label.includes('直降') && !/满\s*\d+/.test(c.label)),
    );

    const unappliedDiscounts = unparsedCandidates.map((c) => c.label);

    let workingPrice = startingPrice;
    const breakdown: DiscountBreakdownItem[] = [];
    let appliedDealsCount = 0;
    const appliedCandidates = new Set<RawPromotionCandidate>();

    const canCombineAll =
        allowStacking ||
        (confidentCandidates.length > 1 && confidentCandidates.every((c) => c.canCombine === true));

    if (canCombineAll) {
        // 1. Best Shop Discount or Promo
        const shopDiscounts = confidentCandidates.filter((c) => c.type === 'shop_discount' || c.type === 'promo');
        let bestShopDiscount: { candidate: RawPromotionCandidate; amountOff: number } | null = null;
        for (const sd of shopDiscounts) {
            const off = evaluateCandidateOff(sd, workingPrice, startingPrice);
            if (off > 0 && (!bestShopDiscount || off > bestShopDiscount.amountOff)) {
                bestShopDiscount = { candidate: sd, amountOff: off };
            }
        }
        if (bestShopDiscount) {
            workingPrice = Math.round((workingPrice - bestShopDiscount.amountOff) * 100) / 100;
            breakdown.push({
                type: bestShopDiscount.candidate.type,
                label: bestShopDiscount.candidate.label,
                labelEn: translatePromoLabelToEn(bestShopDiscount.candidate.label),
                threshold: bestShopDiscount.candidate.threshold ?? 0,
                amountOff: bestShopDiscount.amountOff,
                applied: true,
            });
            appliedDealsCount += 1;
            appliedCandidates.add(bestShopDiscount.candidate);
        }

        // 2. Best Threshold Deal ("满X减Y")
        const thresholdDeals = confidentCandidates.filter((c) => c.type === 'threshold');
        let bestThreshold: { candidate: RawPromotionCandidate; amountOff: number } | null = null;
        for (const td of thresholdDeals) {
            const off = evaluateCandidateOff(td, workingPrice, startingPrice);
            if (off > 0 && (!bestThreshold || off > bestThreshold.amountOff)) {
                bestThreshold = { candidate: td, amountOff: off };
            }
        }
        if (bestThreshold) {
            workingPrice = Math.round((workingPrice - bestThreshold.amountOff) * 100) / 100;
            breakdown.push({
                type: 'threshold',
                label: bestThreshold.candidate.label,
                labelEn: translatePromoLabelToEn(bestThreshold.candidate.label),
                threshold: bestThreshold.candidate.threshold ?? null,
                amountOff: bestThreshold.amountOff,
                applied: true,
            });
            appliedDealsCount += 1;
            appliedCandidates.add(bestThreshold.candidate);
        }

        // 3. Best Public Coupon
        const coupons = confidentCandidates.filter((c) => c.type === 'coupon');
        let bestCoupon: { candidate: RawPromotionCandidate; amountOff: number } | null = null;
        for (const cp of coupons) {
            const off = evaluateCandidateOff(cp, workingPrice, startingPrice);
            if (off > 0 && (!bestCoupon || off > bestCoupon.amountOff)) {
                bestCoupon = { candidate: cp, amountOff: off };
            }
        }
        if (bestCoupon) {
            workingPrice = Math.round((workingPrice - bestCoupon.amountOff) * 100) / 100;
            breakdown.push({
                type: 'coupon',
                label: bestCoupon.candidate.label,
                labelEn: translatePromoLabelToEn(bestCoupon.candidate.label),
                threshold: bestCoupon.candidate.threshold ?? 0,
                amountOff: bestCoupon.amountOff,
                applied: true,
            });
            appliedDealsCount += 1;
            appliedCandidates.add(bestCoupon.candidate);
        }
    } else {
        // Default: do not stack shop discount + threshold + coupon unless confirmed; apply the single best deal
        let bestSingleDeal: { candidate: RawPromotionCandidate; amountOff: number } | null = null;
        for (const cand of confidentCandidates) {
            const off = evaluateCandidateOff(cand, workingPrice, startingPrice);
            if (off > 0 && (!bestSingleDeal || off > bestSingleDeal.amountOff)) {
                bestSingleDeal = { candidate: cand, amountOff: off };
            }
        }
        if (bestSingleDeal) {
            workingPrice = Math.round((workingPrice - bestSingleDeal.amountOff) * 100) / 100;
            breakdown.push({
                type: bestSingleDeal.candidate.type,
                label: bestSingleDeal.candidate.label,
                labelEn: translatePromoLabelToEn(bestSingleDeal.candidate.label),
                threshold: bestSingleDeal.candidate.threshold ?? 0,
                amountOff: bestSingleDeal.amountOff,
                applied: true,
            });
            appliedDealsCount += 1;
            appliedCandidates.add(bestSingleDeal.candidate);
        }
    }

    // When several deals exist and only the best one(s) were applied (no confirmed stacking across all deals),
    // list the remaining unapplied deals in unappliedDiscounts and breakdown
    if (confidentCandidates.length > 1 && appliedCandidates.size < confidentCandidates.length) {
        for (const cand of confidentCandidates) {
            if (!appliedCandidates.has(cand)) {
                unappliedDiscounts.push(cand.label);
                breakdown.push({
                    type: cand.type,
                    label: cand.label,
                    labelEn: translatePromoLabelToEn(cand.label),
                    threshold: cand.threshold ?? null,
                    amountOff: evaluateCandidateOff(cand, startingPrice, startingPrice),
                    applied: false,
                });
            }
        }
    }

    for (const unparsed of unparsedCandidates) {
        breakdown.push({
            type: unparsed.type,
            label: unparsed.label,
            labelEn: translatePromoLabelToEn(unparsed.label),
            threshold: unparsed.threshold ?? null,
            amountOff: 0,
            applied: false,
        });
    }

    if (unappliedDiscounts.length > 0) {
        return {
            finalPrice: appliedDealsCount > 0 ? Math.round(workingPrice * 100) / 100 : null,
            finalPriceDiscounts: breakdown,
            unappliedDiscounts,
            priceType: 'partial',
        };
    }

    const priceType: PriceType =
        appliedDealsCount > 0 ? 'exact_final' : promoPrice !== null ? 'promo_only' : 'base_price';

    return {
        finalPrice: Math.round(workingPrice * 100) / 100,
        finalPriceDiscounts: breakdown,
        unappliedDiscounts: [],
        priceType,
    };
}

/**
 * Enriches a PartialProductData record and all of its SKUs with computed `finalPrice`,
 * `finalPriceDiscounts`, `unappliedDiscounts`, and `priceType`.
 */
export function computeProductAndSkuFinalPrices(product: PartialProductData): {
    finalPrice: number | null;
    finalPriceDiscounts: DiscountBreakdownItem[];
    unappliedDiscounts: string[];
    priceType: PriceType;
    skus: SkuItem[];
} {
    const isDetailFetched = Boolean(product.isDetailFetched);
    const rawPromos = product.rawPromotions ?? [];

    const enrichedSkus: SkuItem[] = [];
    let bestSkuResult: FinalPriceComputationResult | null = null;

    if (Array.isArray(product.skus) && product.skus.length > 0) {
        for (const rawSku of product.skus) {
            const hasOwnOrig = rawSku.originalPrice !== null && rawSku.originalPrice !== undefined;
            const skuOriginalPrice = hasOwnOrig ? rawSku.originalPrice : (rawSku.price ?? product.price ?? null);
            const originalPriceFallback =
                Boolean(rawSku.originalPriceFallback) || (!hasOwnOrig && skuOriginalPrice !== null);

            const skuCalc = computeSingleFinalPrice({
                price: rawSku.price ?? product.price ?? null,
                originalPrice: skuOriginalPrice,
                promoPrice: rawSku.promoPrice ?? null,
                promotions: rawPromos,
                isDetailFetched,
            });

            enrichedSkus.push({
                skuId: rawSku.skuId,
                props: rawSku.props,
                propsEn: null, // Populated by TranslatorService
                price: rawSku.price ?? product.price ?? null,
                originalPrice: skuOriginalPrice,
                originalPriceFallback,
                finalPrice: skuCalc.finalPrice,
                stock: rawSku.stock,
                image: rawSku.image ?? product.mainImage ?? null,
            });

            if (
                skuCalc.finalPrice !== null &&
                (!bestSkuResult ||
                    bestSkuResult.finalPrice === null ||
                    skuCalc.finalPrice < bestSkuResult.finalPrice)
            ) {
                bestSkuResult = skuCalc;
            }
        }
    }

    const itemLevelCalc = computeSingleFinalPrice({
        price: product.price ?? null,
        originalPrice: product.originalPrice ?? null,
        promoPrice: product.promoPrice ?? null,
        promotions: rawPromos,
        isDetailFetched,
    });

    const chosen =
        itemLevelCalc.finalPrice !== null
            ? itemLevelCalc
            : bestSkuResult ?? itemLevelCalc;

    return {
        finalPrice: chosen.finalPrice,
        finalPriceDiscounts: chosen.finalPriceDiscounts,
        unappliedDiscounts: chosen.unappliedDiscounts,
        priceType: chosen.priceType,
        skus: enrichedSkus,
    };
}
