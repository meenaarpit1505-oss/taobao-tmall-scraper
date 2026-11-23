import { Actor, log } from 'apify';
import type { ExchangeRateSource } from './types.js';

export interface ExchangeRateSnapshot {
    base: 'CNY';
    date: string | null;
    rates: Record<string, number>;
    source: string;
    exchangeRateSource?: ExchangeRateSource;
    cachedAt?: number;
}

export const CURRENCY_STORE_NAME = 'taobao-tmall-currency-rates';
export const CURRENCY_KV_KEY = 'EXCHANGE_RATES_CNY_LIVE';
export const CURRENCY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const FALLBACK_RATES_DATE = '2025-01-15';

/**
 * Fallback CNY exchange rates used only when external exchange-rate APIs are unreachable.
 */
const FALLBACK_CNY_RATES: Record<string, number> = {
    CNY: 1,
    USD: 0.1385,
    EUR: 0.1282,
    GBP: 0.1092,
    INR: 11.65,
    CAD: 0.193,
    AUD: 0.212,
    JPY: 21.45,
    KRW: 193.5,
    SGD: 0.186,
    MYR: 0.618,
    HKD: 1.078,
};

/**
 * CurrencyService fetches the daily CNY exchange rate from an open exchange-rate API,
 * caches the live rate in a named Key-Value Store (`taobao-tmall-currency-rates`) with a 24h TTL,
 * and converts CNY prices while tracking `exchangeRateSource: "live" | "fallback"`.
 */
export class CurrencyService {
    private readonly targetCurrency: string;
    private snapshot: ExchangeRateSnapshot | null = null;
    private readonly customFetcher?: () => Promise<ExchangeRateSnapshot>;
    private readonly persistToStore: boolean;

    constructor(
        targetCurrency = 'USD',
        options?: { customFetcher?: () => Promise<ExchangeRateSnapshot>; persistToStore?: boolean },
    ) {
        this.targetCurrency = targetCurrency.toUpperCase().trim();
        this.customFetcher = options?.customFetcher;
        this.persistToStore = options?.persistToStore ?? true;
    }

    public async init(): Promise<ExchangeRateSnapshot> {
        if (this.snapshot) return this.snapshot;

        if (this.customFetcher) {
            const fetched = await this.customFetcher();
            const isFallback = fetched.exchangeRateSource === 'fallback' || fetched.source === 'fallback-static';
            this.snapshot = {
                ...fetched,
                exchangeRateSource: isFallback ? 'fallback' : 'live',
                date: isFallback && !fetched.date ? FALLBACK_RATES_DATE : fetched.date,
            };
            return this.snapshot;
        }

        let namedStore: Awaited<ReturnType<typeof Actor.openKeyValueStore>> | null = null;
        if (this.persistToStore) {
            try {
                namedStore = await Actor.openKeyValueStore(CURRENCY_STORE_NAME);
                const cached = await namedStore.getValue<ExchangeRateSnapshot>(CURRENCY_KV_KEY);
                if (
                    cached &&
                    cached.rates &&
                    typeof cached.rates[this.targetCurrency] === 'number' &&
                    cached.exchangeRateSource === 'live' &&
                    typeof cached.cachedAt === 'number' &&
                    Date.now() - cached.cachedAt < CURRENCY_CACHE_TTL_MS
                ) {
                    this.snapshot = cached;
                    log.info(
                        `Loaded cached live CNY->${this.targetCurrency} exchange rate (${cached.rates[this.targetCurrency]}) for ${cached.date} from named KV store "${CURRENCY_STORE_NAME}".`,
                    );
                    return cached;
                }
            } catch {
                // Proceed to live fetch
            }
        }

        const todayIso = new Date().toISOString().slice(0, 10);
        const endpoints = [
            'https://open.er-api.com/v6/latest/CNY',
            'https://api.exchangerate-api.com/v4/latest/CNY',
        ];

        for (const url of endpoints) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 5000);
                const res = await fetch(url, { signal: controller.signal });
                clearTimeout(timer);

                if (res.ok) {
                    const body = (await res.json()) as {
                        rates?: Record<string, number>;
                        date?: string;
                        time_last_update_utc?: string;
                    };
                    if (body && body.rates && typeof body.rates === 'object') {
                        const dateStr =
                            body.date ||
                            (body.time_last_update_utc
                                ? new Date(body.time_last_update_utc).toISOString().slice(0, 10)
                                : todayIso);
                        this.snapshot = {
                            base: 'CNY',
                            date: dateStr,
                            rates: { ...FALLBACK_CNY_RATES, ...body.rates, CNY: 1 },
                            source: url,
                            exchangeRateSource: 'live',
                            cachedAt: Date.now(),
                        };
                        if (namedStore) {
                            try {
                                await namedStore.setValue(CURRENCY_KV_KEY, this.snapshot);
                            } catch {
                                // Ignore KV error in non-actor context
                            }
                        }
                        log.info(
                            `Fetched live CNY->${this.targetCurrency} exchange rate: ${this.snapshot.rates[this.targetCurrency]} (date: ${this.snapshot.date})`,
                        );
                        return this.snapshot;
                    }
                }
            } catch {
                // Try next endpoint
            }
        }

        // Resilient fallback if offline — never stamp fallback with today's date
        this.snapshot = {
            base: 'CNY',
            date: FALLBACK_RATES_DATE,
            rates: { ...FALLBACK_CNY_RATES },
            source: 'fallback-static',
            exchangeRateSource: 'fallback',
        };
        log.warning(
            `Using fallback CNY->${this.targetCurrency} exchange rate (${this.snapshot.rates[this.targetCurrency] ?? 'N/A'}, table date: ${FALLBACK_RATES_DATE}) because live exchange-rate API was unreachable.`,
        );
        return this.snapshot;
    }

    public convert(amountCny: number | null | undefined): {
        currency: string;
        priceConverted: number | null;
        exchangeRate: number | null;
        exchangeRateDate: string | null;
        exchangeRateSource: ExchangeRateSource;
    } {
        const snap: ExchangeRateSnapshot = this.snapshot ?? {
            base: 'CNY',
            date: FALLBACK_RATES_DATE,
            rates: FALLBACK_CNY_RATES,
            source: 'fallback-static',
            exchangeRateSource: 'fallback',
        };

        const exchangeRateSource: ExchangeRateSource =
            snap.exchangeRateSource ?? (snap.source === 'fallback-static' ? 'fallback' : 'live');
        const rate = snap.rates[this.targetCurrency] ?? null;

        if (amountCny === null || amountCny === undefined || !Number.isFinite(amountCny) || rate === null) {
            return {
                currency: this.targetCurrency,
                priceConverted: null,
                exchangeRate: rate,
                exchangeRateDate: snap.date,
                exchangeRateSource,
            };
        }

        const converted = Math.round(amountCny * rate * 100) / 100;
        return {
            currency: this.targetCurrency,
            priceConverted: converted,
            exchangeRate: rate,
            exchangeRateDate: snap.date,
            exchangeRateSource,
        };
    }
}
