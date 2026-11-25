import { Actor, log } from 'apify';
import type { ProductOutput } from './types.js';

export type BillingEventName = 'actor-start' | 'listing' | 'product-detail' | 'final-price';

export const EVENT_UNIT_PRICES_USD: Record<BillingEventName, number> = {
    // Upper-bound (FREE tier) prices used only for the local max-charge budget. Paid Apify plans get lower
    // tiered prices (GOLD: listing $1.10, detail $2.50, final-price $3.60 per 1,000), so this never under-estimates.
    'actor-start': 0.001, // apify-actor-start, charged automatically by the platform (per GB of memory)
    listing: 0.0015, // $1.50 / 1,000 listings (FREE tier)
    'product-detail': 0.0035, // $3.50 / 1,000 product details (FREE tier)
    'final-price': 0.005, // $5.00 / 1,000 real final-price breakdown add-ons (FREE tier)
};

export interface BillingSummary {
    eventsCharged: Record<BillingEventName, number>;
    estimatedCostUsd: number;
    maxChargeLimitUsd: number | null;
    limitReached: boolean;
}

/**
 * Manages Pay-Per-Event billing via `Actor.charge()`.
 * - Charges ONLY for rows with status `ok` or `partial` (NEVER `failed`).
 * - Respects user's max-charge limit (`APIFY_MAX_TOTAL_CHARGE_USD` or `maxChargeUsd` input or `Actor.charge()` return state)
 *   and signals clean termination when reached.
 */
export class BillingManager {
    private readonly eventsCharged: Record<BillingEventName, number> = {
        'actor-start': 0,
        listing: 0,
        'product-detail': 0,
        'final-price': 0,
    };
    private estimatedCostUsd = 0;
    private readonly maxChargeLimitUsd: number | null;
    private limitReached = false;

    constructor(options?: { maxChargeUsd?: number }) {
        const rawEnvLimit = process.env.ACTOR_MAX_TOTAL_CHARGE_USD ?? process.env.APIFY_MAX_TOTAL_CHARGE_USD;
        const envLimit = rawEnvLimit !== undefined && rawEnvLimit.trim() !== '' ? parseFloat(rawEnvLimit) : undefined;
        const limit = options?.maxChargeUsd ?? envLimit;
        this.maxChargeLimitUsd = limit !== undefined && Number.isFinite(limit) && limit > 0 ? limit : null;
    }

    public isLimitReached(): boolean {
        return this.limitReached;
    }

    public canAffordCost(additionalCostUsd: number): boolean {
        if (this.limitReached) return false;
        if (this.maxChargeLimitUsd === null) return true;
        return this.estimatedCostUsd + additionalCostUsd <= this.maxChargeLimitUsd + 1e-9;
    }

    public canAffordEvent(eventName: BillingEventName, count = 1): boolean {
        return this.canAffordCost(EVENT_UNIT_PRICES_USD[eventName] * count);
    }

    /**
     * The start fee is the synthetic `apify-actor-start` event that the Apify platform charges by itself
     * (one event per GB of memory). Calling Actor.charge('actor-start') is wrong: that event is not in the
     * pricing, so it only produced warnings. We just account for it in the local budget here.
     */
    public recordPlatformStartFee(): void {
        const memoryMb = Number(process.env.ACTOR_MEMORY_MBYTES ?? process.env.APIFY_MEMORY_MBYTES ?? 1024);
        const startEvents = Math.max(1, Math.ceil((Number.isFinite(memoryMb) ? memoryMb : 1024) / 1024));
        this.eventsCharged['actor-start'] += startEvents;
        this.estimatedCostUsd =
            Math.round((this.estimatedCostUsd + EVENT_UNIT_PRICES_USD['actor-start'] * startEvents) * 100000) / 100000;
    }

    public async chargeEvent(eventName: BillingEventName, count = 1): Promise<boolean> {
        if (count <= 0) return true;
        if (!this.canAffordEvent(eventName, count)) {
            this.limitReached = true;
            log.warning(
                `Max charge limit ($${this.maxChargeLimitUsd?.toFixed(4)}) reached before charging "${eventName}". Stopping cleanly.`,
            );
            return false;
        }

        let platformLimitReached = false;
        let effectiveCount = count;

        try {
            const actorAny = Actor as unknown as {
                _isInitialized?: boolean;
                charge?: ((opts: { eventName: string; count?: number }) => Promise<{
                    eventChargeLimitReached?: boolean;
                    chargedCount?: number;
                }>) & { mock?: unknown };
            };

            const shouldCallPlatformCharge =
                typeof actorAny.charge === 'function' &&
                (actorAny._isInitialized || Actor.isAtHome() || Boolean(actorAny.charge.mock));

            if (shouldCallPlatformCharge) {
                const res = await actorAny.charge!({ eventName, count });
                if (typeof res?.chargedCount === 'number') {
                    effectiveCount = Math.max(0, res.chargedCount);
                }
                if (res?.eventChargeLimitReached) {
                    platformLimitReached = true;
                    if (res.chargedCount === undefined) {
                        effectiveCount = 0;
                    }
                }
            }
        } catch (err) {
            log.warning(
                `Actor.charge("${eventName}") threw an error; charge not counted as successful: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return false;
        }

        if (effectiveCount > 0) {
            this.eventsCharged[eventName] += effectiveCount;
            this.estimatedCostUsd =
                Math.round((this.estimatedCostUsd + EVENT_UNIT_PRICES_USD[eventName] * effectiveCount) * 100000) /
                100000;
        }

        if (platformLimitReached) {
            this.limitReached = true;
            log.warning(`Apify PPE charge limit reached on event "${eventName}". Stopping cleanly.`);
            return effectiveCount > 0;
        }

        if (this.maxChargeLimitUsd !== null && this.estimatedCostUsd >= this.maxChargeLimitUsd) {
            this.limitReached = true;
        }

        return true;
    }

    public static hasRealAppliedDeal(record: ProductOutput): boolean {
        if (record.priceType !== 'exact_final') return false;
        if (record.finalPrice === null) return false;
        if (Array.isArray(record.unappliedDiscounts) && record.unappliedDiscounts.length > 0) return false;
        return (
            Array.isArray(record.finalPriceDiscounts) &&
            record.finalPriceDiscounts.some(
                (d) =>
                    d.applied &&
                    d.amountOff > 0 &&
                    (d.type === 'coupon' ||
                        d.type === 'shop_discount' ||
                        d.type === 'threshold'),
            )
        );
    }

    private stripOptionalFinalPriceFromRecord(record: ProductOutput): void {
        record.finalPrice = null;
        record.finalPriceDiscounts = [];
        record.priceType = record.promoPrice !== null ? 'promo_only' : 'base_price';
        if (Array.isArray(record.skus)) {
            for (const s of record.skus) {
                s.finalPrice = null;
            }
        }
        if (record.exchangeRate !== null) {
            const baseCny = record.promoPrice ?? record.price;
            record.priceConverted = baseCny !== null ? Math.round(baseCny * record.exchangeRate * 100) / 100 : null;
        }
    }

    /**
     * Charges the appropriate PPE events for a completed product or shop record.
     * - NEVER charges if `record.status === 'failed'`.
     * - Computes total cost of all events for the row first; if `product-detail` + `final-price` would exceed
     *   remaining budget while `product-detail` fits, skips the optional `final-price` event and outputs the row without it.
     * - Once any event is charged, ALWAYS returns true so the row is pushed.
     */
    public async chargeForProductRecord(
        record: ProductOutput,
        options: { isDetailFetched: boolean },
    ): Promise<boolean> {
        if (record.status === 'failed') {
            return true;
        }

        const baseEvent: BillingEventName = options.isDetailFetched ? 'product-detail' : 'listing';
        const baseCost = EVENT_UNIT_PRICES_USD[baseEvent];

        if (!this.canAffordCost(baseCost)) {
            this.limitReached = true;
            log.warning(
                `Max charge limit ($${this.maxChargeLimitUsd?.toFixed(4)}) reached before charging "${baseEvent}". Stopping cleanly.`,
            );
            return false;
        }

        const wantsFinalPrice = options.isDetailFetched && BillingManager.hasRealAppliedDeal(record);
        const totalRowCost = wantsFinalPrice ? baseCost + EVENT_UNIT_PRICES_USD['final-price'] : baseCost;
        const canAffordFinalPrice = wantsFinalPrice && this.canAffordCost(totalRowCost);

        if (wantsFinalPrice && !canAffordFinalPrice) {
            log.info(
                `Skipping optional "final-price" add-on for item ${record.itemId} so row fits within remaining budget.`,
            );
            this.stripOptionalFinalPriceFromRecord(record);
        }

        const okBase = await this.chargeEvent(baseEvent, 1);
        if (!okBase) {
            return false;
        }

        // Base event has been charged: from here on we MUST return true so the row is pushed!
        if (canAffordFinalPrice) {
            const okFinal = await this.chargeEvent('final-price', 1);
            if (!okFinal) {
                this.stripOptionalFinalPriceFromRecord(record);
            }
        }

        return true;
    }

    public getSummary(): BillingSummary {
        return {
            eventsCharged: { ...this.eventsCharged },
            estimatedCostUsd: Math.round(this.estimatedCostUsd * 10000) / 10000,
            maxChargeLimitUsd: this.maxChargeLimitUsd,
            limitReached: this.limitReached,
        };
    }
}
