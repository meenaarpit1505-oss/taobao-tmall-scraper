import { Actor, log, type ProxyConfiguration } from 'apify';
import { BillingManager } from './billing.js';
import { CurrencyService } from './currency.js';
import { DebugProbeCollector, type DebugProbeReport } from './debugProbe.js';
import { TaobaoH5Client } from './h5Client.js';
import { MonitoringService } from './monitoring.js';
import { assembleProductOutput, buildShopSummaryRow, mergePartialProductData } from './pipeline.js';
import { PlaywrightFallbackService } from './playwrightFallback.js';
import { buildInitialTasks, classifyUrl, validateAndNormalizeInput } from './router.js';
import { LayeredProductDetailSource } from './sources/productDetailSource.js';
import { LayeredSearchListingSource } from './sources/searchSource.js';
import { LayeredShopCatalogueSource } from './sources/shopSource.js';
import { TranslatorService } from './translator.js';
import type {
    ActorInput,
    PartialProductData,
    ProductDetailSource,
    ProductOutput,
    RoutedTask,
    SearchListingSource,
    ShopCatalogueSource,
} from './types.js';

export interface ScraperEngineDependencies {
    proxyConfiguration?: { newUrl: (sessionId?: string) => string | undefined | Promise<string | undefined> };
    h5Client?: TaobaoH5Client;
    detailSource?: ProductDetailSource;
    searchSource?: SearchListingSource;
    shopSource?: ShopCatalogueSource;
    translator?: TranslatorService;
    currencyService?: CurrencyService;
    monitoringService?: MonitoringService;
    billingManager?: BillingManager;
    datasetBatchSize?: number;
    onRecordEmitted?: (record: ProductOutput) => Promise<void>;
    /** Hard timeout per product item (default 150s on the platform, 60s with an injected h5Client). */
    perItemTimeoutMs?: number;
}

export interface RunSummary {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    totalTasksRouted: number;
    uniqueProductsProcessed: number;
    recordsEmitted: number;
    shopRecordsEmitted: number;
    countsByStatus: {
        ok: number;
        partial: number;
        failed: number;
    };
    monitoringCounts: {
        new: number;
        changed: number;
        unchanged: number;
        skippedUnchanged: number;
    };
    successRatePercent: number;
    blockRatePercent: number;
    circuitBreakerTripped: boolean;
    /** Most used proxy country for actual requests (e.g. TW for world.taobao.com even when CN was requested). */
    proxyCountry?: string;
    proxyCountryRequested?: string;
    proxyCountriesUsed?: Record<string, number>;
    /** True when this summary was written early because the run was aborting, migrating, or near its timeout. */
    partialSummary?: boolean;
    stoppedEarlyReason?: string | null;
    translation?: {
        enabled: boolean;
        provider: string;
        countsByStatus: Record<string, number>;
        lastFailureReason: string | null;
    };
    blockWarnings?: string[];
    strategiesEnabled?: {
        sessionWarmup: boolean;
        playwrightFallback: boolean;
        customCookiesProvided: boolean;
    };
    blockedRunNote?: string | null;
    troubleshootingAdvice?: string[];
    billing: ReturnType<BillingManager['getSummary']>;
}

/**
 * Builds clear, actionable user guidance when a run is blocked by Taobao/Tmall anti-bot protection (RGV587 / x5sec).
 */
export function buildBlockedRunGuidance(params: {
    proxyCountry: string;
    hasCustomCookies: boolean;
    blockRatePercent: number;
    lastErrorReason?: string;
}): { statusMessage: string; note: string; troubleshootingSteps: string[] } {
    // Only used when the run returned zero products, so "no product events were charged" is always true here.
    const { proxyCountry, hasCustomCookies, blockRatePercent, lastErrorReason } = params;
    const suggestedCountries = ['HK', 'TW', 'SG', 'CN', 'US'].filter((c) => c !== proxyCountry.toUpperCase());
    const troubleshootingSteps = [
        `Switch "proxyCountry" to another region such as "${suggestedCountries[0]}" or "${suggestedCountries[1]}" (available options: CN, HK, TW, SG, US, JP).`,
        hasCustomCookies
            ? 'Refresh your "taobaoCookies" secret input with a newly logged-in browser session cookie string (_m_h5_tk, cookie2, cna, t, isg).'
            : 'Paste your logged-in Taobao/Tmall browser cookies into the secret "taobaoCookies" input as a last-resort bypass for login walls.',
        'Keep "enableSessionWarmup": true, "enablePlaywrightFallback": true, and lower "maxConcurrency" to 1-2 for slower human-like pacing.',
    ];

    const reasonSnippet = lastErrorReason ? ` (${lastErrorReason})` : '';
    const note =
        `Taobao/Tmall anti-bot protection blocked the requests${reasonSnippet} [blockRate=${blockRatePercent}%, proxyCountry=${proxyCountry}]. ` +
        `No product events were charged. Next steps to try: (1) ${troubleshootingSteps[0]} (2) ${troubleshootingSteps[1]}`;

    return {
        statusMessage: note,
        note,
        troubleshootingSteps,
    };
}

const isMainModule =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith('main.js') || process.argv[1].endsWith('main.ts'));

/**
 * Runs the complete Taobao & Tmall scraping workflow with auto-routing, deduplication by itemId,
 * concurrency management, monitoring diffing, PPE billing, batched dataset pushes, DEBUG_PROBE telemetry,
 * and structured summary reporting.
 */
export async function runTaobaoScraper(
    rawInput: ActorInput,
    deps: ScraperEngineDependencies = {},
): Promise<{ summary: RunSummary; debugProbe?: DebugProbeReport }> {
    const startedAt = new Date().toISOString();
    const startTimeMs = Date.now();

    const input = validateAndNormalizeInput(rawInput);

    // Initialize BillingManager (charge actor-start only after proxy setup succeeds)
    const billing = deps.billingManager ?? new BillingManager({ maxChargeUsd: input.maxChargeUsd });

    const proxyGroupLabel =
        Array.isArray(input.proxyConfiguration?.proxyUrls) && input.proxyConfiguration.proxyUrls.length > 0
            ? 'CUSTOM'
            : input.proxyConfiguration?.useApifyProxy === false
              ? 'NONE'
              : (input.proxyConfiguration?.apifyProxyGroups?.[0] ?? 'RESIDENTIAL');
    const initialProxyCountry = input.proxyCountry ?? input.proxyConfiguration?.apifyProxyCountry ?? 'CN';

    const debugProbe = new DebugProbeCollector({
        proxyGroup: proxyGroupLabel,
        proxyCountry: proxyGroupLabel === 'NONE' ? null : initialProxyCountry,
    });

    // Initialize ProxyConfiguration when proxyConfiguration input is provided (supports useApifyProxy and proxyUrls)
    let proxyConfiguration:
        | { newUrl: (sessionId?: string) => string | undefined | Promise<string | undefined> }
        | undefined = deps.proxyConfiguration;
    const countryProxyCache = new Map<
        string,
        { newUrl: (sessionId?: string) => string | undefined | Promise<string | undefined> }
    >();

    if (!proxyConfiguration && input.proxyConfiguration && (!deps.h5Client || Actor.isAtHome())) {
        let proxyInitError: unknown;
        try {
            const hasCustomProxyUrls =
                Array.isArray(input.proxyConfiguration.proxyUrls) && input.proxyConfiguration.proxyUrls.length > 0;
            const hasCustomNewUrlFn = typeof input.proxyConfiguration.newUrlFunction === 'function';
            if (input.proxyConfiguration.useApifyProxy === false && !hasCustomProxyUrls && !hasCustomNewUrlFn) {
                proxyConfiguration = undefined;
            } else {
                const candidateCountries = rawInput.proxyCountry
                    ? [input.proxyCountry, 'HK', 'TW', 'SG', 'US'].filter((v, i, a) => Boolean(v) && a.indexOf(v) === i)
                    : [input.proxyConfiguration.apifyProxyCountry ?? 'US'];

                for (let cIdx = 0; cIdx < candidateCountries.length; cIdx++) {
                    const tryCountry = candidateCountries[cIdx]!;
                    try {
                        const cfgToCreate = hasCustomProxyUrls || hasCustomNewUrlFn
                            ? input.proxyConfiguration
                            : {
                                  ...input.proxyConfiguration,
                                  apifyProxyCountry: tryCountry,
                              };
                        const created = await Actor.createProxyConfiguration(cfgToCreate);
                        if (created) {
                            proxyConfiguration = created;
                            countryProxyCache.set(tryCountry.toUpperCase(), created);
                            debugProbe.setProxyMetadata(proxyGroupLabel, tryCountry.toUpperCase());
                            proxyInitError = undefined;
                            break;
                        }
                    } catch (innerErr) {
                        proxyInitError = innerErr;
                        if (!rawInput.proxyCountry) break;
                    }
                }
            }
        } catch (err) {
            proxyInitError = err;
        }

        if (proxyInitError || !proxyConfiguration) {
            const reason = proxyInitError
                ? proxyInitError instanceof Error
                    ? proxyInitError.message
                    : String(proxyInitError)
                : 'Actor.createProxyConfiguration returned undefined (proxy disabled or inaccessible).';
            if (Actor.isAtHome()) {
                const failMsg = 'A proxy is required: enable Apify Proxy (RESIDENTIAL) or provide proxyUrls.';
                log.error(failMsg, { reason });
                try {
                    await Actor.setValue('DEBUG_PROBE', debugProbe.getReport());
                } catch {
                    // Ignore KV errors
                }
                await Actor.fail(failMsg, { exit: Boolean(isMainModule || Actor.isAtHome()) });
                return {
                    summary: {
                        startedAt,
                        finishedAt: new Date().toISOString(),
                        durationMs: Date.now() - startTimeMs,
                        totalTasksRouted: 0,
                        uniqueProductsProcessed: 0,
                        recordsEmitted: 0,
                        shopRecordsEmitted: 0,
                        countsByStatus: { ok: 0, partial: 0, failed: 0 },
                        monitoringCounts: { new: 0, changed: 0, unchanged: 0, skippedUnchanged: 0 },
                        successRatePercent: 0,
                        blockRatePercent: 0,
                        circuitBreakerTripped: false,
                        billing: billing.getSummary(),
                    },
                    debugProbe: debugProbe.getReport(),
                };
            }
            log.warning(`Proceeding without Apify Proxy (local/unauthenticated environment): ${reason}`);
        }
    }

    await billing.chargeEvent('actor-start', 1);

    const getProxyUrlForSession = async (sessionId: string, countryCode?: string): Promise<string | undefined> => {
        if (!proxyConfiguration) return undefined;
        const normalizedCountry = countryCode?.toUpperCase().trim();
        if (
            normalizedCountry &&
            Actor.isAtHome() &&
            !deps.proxyConfiguration &&
            input.proxyConfiguration?.useApifyProxy !== false &&
            !input.proxyConfiguration?.proxyUrls?.length
        ) {
            let countryProxy = countryProxyCache.get(normalizedCountry);
            if (!countryProxy) {
                try {
                    const created = await Actor.createProxyConfiguration({
                        groups: input.proxyConfiguration?.apifyProxyGroups ?? ['RESIDENTIAL'],
                        countryCode: normalizedCountry,
                    });
                    if (created) {
                        countryProxy = created;
                        countryProxyCache.set(normalizedCountry, created);
                    }
                } catch {
                    // Fall back to primary proxyConfiguration if this country is unavailable on the account
                }
            }
            if (countryProxy) {
                return countryProxy.newUrl(sessionId);
            }
        }
        return proxyConfiguration.newUrl(sessionId);
    };

    const fallbackCountries = [input.proxyCountry, 'CN', 'HK', 'TW', 'SG', 'US'].filter(
        (v, i, a): v is string => Boolean(v) && a.indexOf(v) === i,
    );

    const h5Client =
        deps.h5Client ??
        new TaobaoH5Client({
            userCookie: input.taobaoCookies ?? input.cookie,
            getProxyUrl: getProxyUrlForSession,
            debugProbe,
            proxyGroup: proxyGroupLabel,
            proxyCountry: initialProxyCountry,
            proxyFallbackCountries: fallbackCountries,
            enableSessionWarmup: input.enableSessionWarmup,
            requestDelayMs: input.requestDelayMs ?? (Actor.isAtHome() ? 1000 : 250),
        });

    const playwrightFallback = new PlaywrightFallbackService({
        enabled: Boolean(input.enablePlaywrightFallback && !deps.h5Client),
        proxyConfiguration: proxyConfiguration as ProxyConfiguration | undefined,
        getProxyUrl: proxyConfiguration ? (sid, country) => h5Client.getProxyUrlFor(sid, country) : undefined,
        userCookie: input.taobaoCookies ?? input.cookie,
        debugProbe: h5Client.debugProbe,
        proxyGroup: proxyGroupLabel,
        proxyCountry: initialProxyCountry,
        browserProxyCountry: initialProxyCountry === 'CN' ? 'TW' : initialProxyCountry,
    });

    const detailSource =
        deps.detailSource ??
        new LayeredProductDetailSource(h5Client, {
            playwrightFallbackFn: playwrightFallback.isEnabled()
                ? (itemId, platform, slug) => playwrightFallback.fetchProductDetail(itemId, platform, slug)
                : undefined,
        });
    const searchSource = deps.searchSource ?? new LayeredSearchListingSource(h5Client);
    const shopSource = deps.shopSource ?? new LayeredShopCatalogueSource(h5Client);

    const translator =
        deps.translator ??
        new TranslatorService({
            enabled: input.translateToEnglish,
            provider: input.translationProvider,
            apiKey: input.translationApiKey,
            deeplApiKey: input.deeplApiKey,
            googleTranslateApiKey: input.googleTranslateApiKey,
            // Google's free endpoints rate-limit Apify datacenter IPs; retry through the run's proxy (US exit, tiny traffic)
            proxyUrlProvider: proxyConfiguration
                ? () => getProxyUrlForSession(`tr_${Math.random().toString(36).slice(2, 10)}`, 'US')
                : undefined,
        });
    await translator.initFromKvStore();

    const currencyService = deps.currencyService ?? new CurrencyService(input.currency);
    await currencyService.init();

    const monitoring =
        deps.monitoringService ??
        new MonitoringService(input.monitoringMode, undefined, {
            monitoringKey: input.monitoringKey,
        });
    await monitoring.init();

    const initialTasks = buildInitialTasks(input);
    log.info('Routed initial input tasks', {
        totalTasks: initialTasks.length,
        maxItemsPerQuery: input.maxItemsPerQuery,
        includeDetails: input.includeDetails,
        translateToEnglish: input.translateToEnglish,
        currency: input.currency,
        monitoringMode: input.monitoringMode,
        maxConcurrency: input.maxConcurrency,
        proxyCountry: input.proxyCountry,
        enableSessionWarmup: input.enableSessionWarmup,
        enablePlaywrightFallback: input.enablePlaywrightFallback,
        customCookiesProvided: Boolean(input.taobaoCookies || input.cookie),
    });

    // Overall run deadline (Apify sets ACTOR_TIMEOUT_AT). Stop starting new work ~45s before it so RUN_SUMMARY,
    // DEBUG_PROBE and failed rows are always written instead of the platform killing the run mid-request.
    const timeoutAtRaw = process.env.ACTOR_TIMEOUT_AT ?? process.env.APIFY_TIMEOUT_AT;
    const timeoutAtMs = timeoutAtRaw ? Date.parse(timeoutAtRaw) : NaN;
    const runDeadlineMs = Number.isFinite(timeoutAtMs) ? timeoutAtMs - 45_000 : Number.POSITIVE_INFINITY;
    const perItemTimeoutMs = deps.perItemTimeoutMs ?? (deps.h5Client ? 60_000 : 150_000);
    let stoppedEarlyReason: string | null = null;
    const isNearDeadline = (marginMs = 0): boolean => Date.now() + marginMs >= runDeadlineMs;
    const abandonedItemIds = new Set<string>();
    const translationCounts: Record<string, number> = {};

    const seenItemIds = new Set<string>();
    const itemStatusById = new Map<string, ProductOutput['status']>();
    let recordsEmittedCount = 0;
    let shopRecordsEmitted = 0;
    let lastObservedBlockError: string | undefined;

    const countsByStatus = { ok: 0, partial: 0, failed: 0 };
    const monitoringCounts = { new: 0, changed: 0, unchanged: 0, skippedUnchanged: 0 };

    const batchSize = Math.max(1, deps.datasetBatchSize ?? 25);
    const datasetBatchBuffer: ProductOutput[] = [];

    const flushDatasetBatch = async (): Promise<void> => {
        if (datasetBatchBuffer.length === 0) return;
        const batch = datasetBatchBuffer.splice(0, datasetBatchBuffer.length);
        await Actor.pushData(batch);
        for (const rec of batch) {
            monitoring.commitEmittedRecord(rec);
        }
    };

    const pushAndCommitRecord = async (record: ProductOutput): Promise<void> => {
        recordsEmittedCount += 1;
        if (record.status !== 'failed' && record.recordType !== 'shop') {
            const key = record.translationStatus ?? 'unknown';
            translationCounts[key] = (translationCounts[key] ?? 0) + 1;
        }
        if (deps.onRecordEmitted) {
            await deps.onRecordEmitted(record);
            monitoring.commitEmittedRecord(record);
        } else {
            datasetBatchBuffer.push(record);
            if (datasetBatchBuffer.length >= batchSize) {
                await flushDatasetBatch();
            }
        }
    };

    const emitRecord = async (record: ProductOutput, isDetailFetched: boolean): Promise<boolean> => {
        if (billing.isLimitReached() && record.status !== 'failed') return false;

        if (record.recordType === 'shop') {
            const { product: evaluatedShop } = await monitoring.evaluateAsync(record);
            if (evaluatedShop.status === 'failed') {
                countsByStatus.failed += 1;
            } else {
                shopRecordsEmitted += 1;
            }
            await pushAndCommitRecord(evaluatedShop);
            return true;
        }

        // Evaluate monitoring diff BEFORE charging/pushing (does not mark as seen yet)
        const { product: evaluated, shouldEmit } = await monitoring.evaluateAsync(record);

        if (!shouldEmit && evaluated.status !== 'failed') {
            if (evaluated.changeType === 'unchanged') monitoringCounts.unchanged += 1;
            monitoringCounts.skippedUnchanged += 1;
            return true;
        }

        // Charge PPE only for ok/partial records that are emitted (never charges for failed/blocked items!)
        const withinBudget = await billing.chargeForProductRecord(evaluated, { isDetailFetched });
        if (!withinBudget && evaluated.status !== 'failed') {
            return false;
        }

        // Update counters only once the row is confirmed to be emitted
        countsByStatus[evaluated.status] += 1;
        if (evaluated.changeType === 'new') monitoringCounts.new += 1;
        else if (evaluated.changeType === 'changed') monitoringCounts.changed += 1;
        else if (evaluated.changeType === 'unchanged') monitoringCounts.unchanged += 1;

        await pushAndCommitRecord(evaluated);
        return true;
    };

    const emitFailedQueryRow = async (params: {
        itemId: string | null;
        query?: string | null;
        url: string;
        title?: string;
        platform?: 'taobao' | 'tmall';
        errorReason: string;
        recordType?: 'product' | 'shop';
    }): Promise<void> => {
        if (
            params.errorReason.includes('RGV587') ||
            params.errorReason.includes('block') ||
            params.errorReason.includes('Captcha') ||
            params.errorReason.includes('x5sec')
        ) {
            lastObservedBlockError ??= params.errorReason;
        }
        const enrichedErrorReason =
            params.errorReason.includes('RGV587') ||
            params.errorReason.includes('anti-bot') ||
            params.errorReason.includes('Captcha') ||
            params.errorReason.includes('x5sec')
                ? `${params.errorReason} | Try another proxyCountry (HK, TW, SG, CN) or provide logged-in cookies via taobaoCookies.`
                : params.errorReason;
        const failedRecord = await assembleProductOutput({
            partial: {
                itemId: params.itemId ?? '',
                query: params.query ?? null,
                url: params.url,
                platform: params.platform ?? 'taobao',
                title: params.title ?? '',
                price: null,
                errorReason: enrichedErrorReason,
            },
            translator,
            currencyService,
            selectedAgents: input.agentLinks,
            includeShopInfo: input.includeShopInfo,
        });
        failedRecord.itemId = params.itemId;
        if (params.query !== undefined) {
            failedRecord.query = params.query;
        }
        failedRecord.status = 'failed';
        failedRecord.dataCompleteness = 0;
        if (params.recordType === 'shop') {
            failedRecord.recordType = 'shop';
        }
        await emitRecord(failedRecord, false);
    };

    const processSingleProductItem = async (
        basePartial: PartialProductData,
        forceFetchDetail: boolean,
    ): Promise<boolean> => {
        if (billing.isLimitReached() || h5Client.circuitBreaker.isTripped()) {
            return false;
        }

        const itemId = String(basePartial.itemId ?? '').trim();
        if (!itemId || seenItemIds.has(itemId)) {
            return true;
        }
        seenItemIds.add(itemId);

        let workingPartial: PartialProductData = { ...basePartial, itemId };
        let detailFetched = Boolean(basePartial.isDetailFetched);

        if (forceFetchDetail && !detailFetched) {
            const detailRes = await (detailSource as LayeredProductDetailSource).fetchProductDetail(
                itemId,
                basePartial.platform ?? 'taobao',
                {
                    itemIdStr: basePartial.itemIdStr,
                    preferredUrl: basePartial.url,
                    shopId: basePartial.shopId,
                    hintTitle: basePartial.title,
                },
            );
            if (detailRes.ok && detailRes.data) {
                workingPartial = mergePartialProductData(workingPartial, detailRes.data);
                detailFetched = true;
            } else {
                if (detailRes.blocked && detailRes.errorReason) {
                    lastObservedBlockError ??= detailRes.errorReason;
                }
                const rawErr = detailRes.errorReason ?? 'Detail extraction failed';
                workingPartial.errorReason = detailRes.blocked
                    ? `${rawErr} | Try another proxyCountry (HK, TW, SG, CN) or provide logged-in cookies via taobaoCookies.`
                    : rawErr;
            }
        }

        const outputRecord = await assembleProductOutput({
            partial: workingPartial,
            translator,
            currencyService,
            selectedAgents: input.agentLinks,
            includeShopInfo: input.includeShopInfo,
        });

        if (abandonedItemIds.has(itemId)) {
            // A timeout row was already emitted for this item; never emit (or charge) a late duplicate
            return false;
        }
        itemStatusById.set(itemId, outputRecord.status);
        return emitRecord(outputRecord, detailFetched);
    };

    /**
     * Runs one product with a hard timeout. On timeout an uncharged failed row is emitted and any late result is dropped.
     * Near the run deadline, remaining items get an uncharged "not processed" row instead of being silently lost.
     */
    const processProductWithTimeout = async (queued: { partial: PartialProductData; fetchDetail: boolean }): Promise<void> => {
        const itemId = String(queued.partial.itemId ?? '').trim();
        if (!itemId || seenItemIds.has(itemId)) return;
        const remainingMs = runDeadlineMs - Date.now();
        if (remainingMs < 25_000) {
            stoppedEarlyReason ??= 'Run timeout was close, so remaining items were not started.';
            seenItemIds.add(itemId);
            itemStatusById.set(itemId, 'failed');
            await emitFailedQueryRow({
                itemId,
                url: queued.partial.url ?? `https://item.taobao.com/item.htm?id=${itemId}`,
                title: queued.partial.title,
                platform: queued.partial.platform ?? 'taobao',
                errorReason: 'Not processed: the run was about to hit its timeout. Increase the run timeout or lower maxItemsPerQuery.',
            });
            return;
        }
        const timeoutMs = Math.max(Math.min(10_000, perItemTimeoutMs), Math.min(perItemTimeoutMs, remainingMs - 20_000));
        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
            processSingleProductItem(queued.partial, queued.fetchDetail).then(
                () => 'done' as const,
                (err: unknown) => {
                    log.warning(`Item ${itemId} failed with an unexpected error: ${err instanceof Error ? err.message : String(err)}`);
                    return 'error' as const;
                },
            ),
            new Promise<'timeout'>((resolve) => {
                timer = setTimeout(() => resolve('timeout'), timeoutMs);
            }),
        ]);
        if (timer) clearTimeout(timer);
        if ((outcome === 'timeout' || outcome === 'error') && !itemStatusById.has(itemId)) {
            abandonedItemIds.add(itemId);
            seenItemIds.add(itemId);
            itemStatusById.set(itemId, 'failed');
            await emitFailedQueryRow({
                itemId,
                url: queued.partial.url ?? `https://item.taobao.com/item.htm?id=${itemId}`,
                title: queued.partial.title,
                platform: queued.partial.platform ?? 'taobao',
                errorReason:
                    outcome === 'timeout'
                        ? `Timed out after ${Math.round(timeoutMs / 1000)}s while fetching product detail (Taobao kept blocking or responding slowly). Not charged.`
                        : 'Unexpected error while processing this item. Not charged.',
            });
        }
    };

    // Bounded concurrency helper
    const runWithConcurrency = async <T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) => {
        let index = 0;
        const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (index < items.length) {
                if (billing.isLimitReached() || h5Client.circuitBreaker.isTripped()) break;
                const currentIdx = index++;
                await worker(items[currentIdx]!);
            }
        });
        await Promise.all(workers);
    };

    let runFinalized = false;

    /**
     * Builds RUN_SUMMARY from the live counters. Used at the end of the run and, as a partial summary,
     * on persistState / aborting / migrating so a summary always exists even if the run is killed.
     */
    const buildRunSummary = (partial: boolean): { summary: RunSummary; successfulProducts: number } => {
        const successfulProducts = countsByStatus.ok + countsByStatus.partial + monitoringCounts.skippedUnchanged;
        const totalProducts = successfulProducts + countsByStatus.failed;
        const successRatePercent =
            totalProducts > 0 ? Math.round((successfulProducts / totalProducts) * 10000) / 100 : 100;
        const cbStats = h5Client.circuitBreaker.getStats();
        const zeroProducts = successfulProducts === 0 && shopRecordsEmitted === 0;
        const anyFailures = countsByStatus.failed > 0 || cbStats.blockRate > 0 || Boolean(lastObservedBlockError);
        const proxyCountriesUsed = h5Client.getProxyCountriesUsed();
        const proxyCountryUsed = h5Client.getPrimaryProxyCountryUsed() ?? h5Client.getActiveProxyCountry();
        // The blocked-run note (which says nothing was charged) is ONLY written when zero products came back.
        const blockedGuidance =
            !partial && zeroProducts && anyFailures && totalProducts + initialTasks.length > 0
                ? buildBlockedRunGuidance({
                      proxyCountry: proxyCountryUsed,
                      hasCustomCookies: Boolean(input.taobaoCookies || input.cookie),
                      blockRatePercent: cbStats.blockRate,
                      lastErrorReason: lastObservedBlockError,
                  })
                : null;
        const blockWarnings: string[] = [];
        if (!zeroProducts && countsByStatus.failed > 0) {
            blockWarnings.push(
                `${countsByStatus.failed} item(s) failed${lastObservedBlockError ? ' (Taobao anti-bot blocks were seen)' : ''}. Failed rows are never charged; the ${successfulProducts} returned product(s) were charged normally.`,
            );
        }
        if (stoppedEarlyReason) blockWarnings.push(stoppedEarlyReason);
        const summary: RunSummary = {
            startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - startTimeMs,
            totalTasksRouted: initialTasks.length,
            uniqueProductsProcessed: totalProducts,
            recordsEmitted: recordsEmittedCount,
            shopRecordsEmitted,
            countsByStatus: { ...countsByStatus },
            monitoringCounts: { ...monitoringCounts },
            successRatePercent,
            blockRatePercent: cbStats.blockRate,
            circuitBreakerTripped: cbStats.tripped,
            proxyCountry: proxyCountryUsed,
            proxyCountryRequested: initialProxyCountry,
            proxyCountriesUsed,
            partialSummary: partial,
            stoppedEarlyReason,
            strategiesEnabled: {
                sessionWarmup: Boolean(input.enableSessionWarmup),
                playwrightFallback: Boolean(input.enablePlaywrightFallback),
                customCookiesProvided: Boolean(input.taobaoCookies || input.cookie),
            },
            translation: {
                enabled: translator.isEnabled(),
                provider: translator.getProviderName(),
                countsByStatus: { ...translationCounts },
                lastFailureReason: translator.getLastFailureReason(),
            },
            blockedRunNote: blockedGuidance?.note ?? null,
            troubleshootingAdvice: blockedGuidance?.troubleshootingSteps ?? [],
            blockWarnings,
            billing: billing.getSummary(),
        };
        return { summary, successfulProducts };
    };

    const persistPartialState = async (reason: string): Promise<void> => {
        if (runFinalized) return;
        try {
            stoppedEarlyReason ??= reason === 'persistState' ? null : `Run is ${reason}; summary written early.`;
            if (reason !== 'persistState') await flushDatasetBatch();
            const { summary } = buildRunSummary(true);
            await Actor.setValue('RUN_SUMMARY', summary);
            await Actor.setValue('DEBUG_PROBE', h5Client.debugProbe.getReport());
        } catch {
            // Best effort only
        }
    };
    const onPersistState = () => persistPartialState('persistState');
    const onAborting = () => persistPartialState('aborting');
    const onMigrating = () => persistPartialState('migrating');
    const detachLifecycleHandlers = () => {
        try {
            Actor.off('persistState', onPersistState);
            Actor.off('aborting', onAborting);
            Actor.off('migrating', onMigrating);
        } catch {
            // Ignore
        }
    };
    try {
        Actor.on('persistState', onPersistState);
        Actor.on('aborting', onAborting);
        Actor.on('migrating', onMigrating);
    } catch {
        // Event manager not available (unit tests)
    }

    // Process each routed task
    const productQueue: Array<{ partial: PartialProductData; fetchDetail: boolean }> = [];
    const taskOutcomes: Array<'ok' | 'failed' | 'pending'> = new Array(initialTasks.length).fill('pending');
    const taskItemIds: string[][] = Array.from({ length: initialTasks.length }, () => []);

    for (let taskIdx = 0; taskIdx < initialTasks.length; taskIdx++) {
        const task = initialTasks[taskIdx]!;
        if (billing.isLimitReached() || h5Client.circuitBreaker.isTripped()) break;

        let activeTask: RoutedTask = task;

        // 0. Invalid URL or itemId task -> emit a failed row without charging and continue
        if (activeTask.type === 'invalid') {
            taskOutcomes[taskIdx] = 'failed';
            const rawQuery = activeTask.rawInput ?? activeTask.url;
            await emitFailedQueryRow({
                itemId:
                    activeTask.itemId ||
                    `invalid_${Buffer.from(rawQuery || 'invalid').toString('hex').slice(0, 12)}`,
                url: activeTask.url || rawQuery,
                title: rawQuery,
                errorReason: activeTask.errorReason ?? `Invalid input entry: "${rawQuery}"`,
            });
            continue;
        }

        // 1. Resolve short links first (tb.cn, m.tb.cn, e.tb.cn)
        if (activeTask.type === 'short_link') {
            log.info(`Resolving short link: ${activeTask.url}`);
            const resolved = await h5Client.resolveShortLink(activeTask.url);
            if (!resolved.ok || !resolved.data) {
                taskOutcomes[taskIdx] = 'failed';
                await emitFailedQueryRow({
                    itemId: `shortlink_${Buffer.from(activeTask.url).toString('hex').slice(0, 12)}`,
                    url: activeTask.url,
                    platform: activeTask.platform ?? 'taobao',
                    errorReason: resolved.errorReason ?? `Failed to resolve short link ${activeTask.url}`,
                });
                continue;
            }
            try {
                activeTask = classifyUrl(resolved.data, input.searchFilters);
                log.info(`Short link resolved to ${activeTask.type}: ${activeTask.url}`);
            } catch (err) {
                taskOutcomes[taskIdx] = 'failed';
                const reason = err instanceof Error ? err.message : String(err);
                log.warning(`Short link ${activeTask.url} resolved to invalid URL "${resolved.data}": ${reason}`);
                await emitFailedQueryRow({
                    itemId: `shortlink_${Buffer.from(activeTask.url).toString('hex').slice(0, 12)}`,
                    url: activeTask.url,
                    platform: activeTask.platform ?? 'taobao',
                    errorReason: reason,
                });
                continue;
            }
        }

        // 2. Direct product task
        if (activeTask.type === 'product' && activeTask.itemId) {
            taskItemIds[taskIdx]!.push(activeTask.itemId);
            productQueue.push({
                partial: {
                    itemId: activeTask.itemId,
                    ...(activeTask.itemIdStr ? { itemIdStr: activeTask.itemIdStr } : {}),
                    url: activeTask.url,
                    platform: activeTask.platform ?? 'taobao',
                },
                fetchDetail: true, // Always fetch detail for direct product URLs/itemIds
            });
            continue;
        }

        // 3. Search or Category task with deep pagination up to maxItemsPerQuery
        if (activeTask.type === 'search' || activeTask.type === 'category') {
            let collectedForQuery = 0;
            let page = activeTask.page ?? 1;
            const maxPages = Math.ceil(input.maxItemsPerQuery / 20) + 2;
            let anyRawResultsSeen = false;
            let lastSearchError: string | undefined;

            while (collectedForQuery < input.maxItemsPerQuery && page <= maxPages) {
                if (billing.isLimitReached() || h5Client.circuitBreaker.isTripped()) break;
                if (isNearDeadline(60_000)) {
                    stoppedEarlyReason ??= 'Run timeout was close, so search pagination stopped early.';
                    break;
                }

                log.info(`Scraping ${activeTask.type} page ${page}`, {
                    keyword: activeTask.keyword,
                    categoryId: activeTask.categoryId,
                    collectedSoFar: collectedForQuery,
                    maxItemsPerQuery: input.maxItemsPerQuery,
                });

                const searchRes = await searchSource.searchProducts({
                    keyword: activeTask.keyword,
                    searchUrl: activeTask.url,
                    categoryId: activeTask.categoryId,
                    page,
                    filters: activeTask.filters ?? input.searchFilters,
                });

                if (!searchRes.ok || !searchRes.data) {
                    lastSearchError = searchRes.errorReason;
                    if (searchRes.blocked && searchRes.errorReason) {
                        lastObservedBlockError ??= searchRes.errorReason;
                    }
                    if (page === 1) {
                        log.warning(`Search query failed on page 1: ${searchRes.errorReason}`);
                    }
                    break;
                }

                // Continue pagination based on RAW page results, not post-filter counts
                const rawPageCount = searchRes.data.rawItemCount ?? searchRes.data.items.length;
                if (rawPageCount === 0) {
                    break;
                }
                anyRawResultsSeen = true;

                for (const item of searchRes.data.items) {
                    if (collectedForQuery >= input.maxItemsPerQuery) break;
                    taskItemIds[taskIdx]!.push(item.itemId);
                    if (!seenItemIds.has(item.itemId)) {
                        productQueue.push({
                            partial: item,
                            fetchDetail: input.includeDetails,
                        });
                        collectedForQuery += 1;
                    }
                }

                if (!searchRes.data.hasNextPage) break;
                page += 1;
            }

            if (!anyRawResultsSeen) {
                taskOutcomes[taskIdx] = 'failed';
                const queryLabel = activeTask.keyword ?? activeTask.categoryId ?? activeTask.url;
                await emitFailedQueryRow({
                    itemId: null,
                    query: activeTask.keyword ?? queryLabel,
                    url: activeTask.url,
                    title: queryLabel,
                    platform: activeTask.platform ?? 'taobao',
                    errorReason: lastSearchError ?? `No results or failed search for query "${queryLabel}"`,
                });
            } else if (taskItemIds[taskIdx]!.length === 0) {
                taskOutcomes[taskIdx] = 'ok';
            }
            continue;
        }

        // 4. Shop task with full paginated catalogue + shop summary row
        if (activeTask.type === 'shop') {
            let collectedForShop = 0;
            let page = activeTask.page ?? 1;
            const maxPages = Math.ceil(input.maxItemsPerQuery / 16) + 2;
            const shopCatalogueIds: string[] = [];
            const seenShopCatalogueIds = new Set<string>();
            let lastShopError: string | undefined;
            let aggregatedShopInfo: Partial<PartialProductData> = {
                shopId: activeTask.shopId,
                shopUrl: activeTask.url,
                platform: activeTask.platform ?? 'taobao',
            };

            while (collectedForShop < input.maxItemsPerQuery && page <= maxPages) {
                if (billing.isLimitReached() || h5Client.circuitBreaker.isTripped()) break;
                if (isNearDeadline(60_000)) {
                    stoppedEarlyReason ??= 'Run timeout was close, so shop pagination stopped early.';
                    break;
                }

                log.info(`Scraping shop catalogue page ${page}: ${activeTask.url}`, {
                    collectedSoFar: collectedForShop,
                    maxItemsPerQuery: input.maxItemsPerQuery,
                });

                const shopRes = await shopSource.fetchShopCatalogue({
                    shopUrl: activeTask.url,
                    shopId: activeTask.shopId,
                    page,
                    maxItems: input.maxItemsPerQuery,
                });

                if (!shopRes.ok || !shopRes.data) {
                    lastShopError = shopRes.errorReason;
                    if (shopRes.blocked && shopRes.errorReason) {
                        lastObservedBlockError ??= shopRes.errorReason;
                    }
                    if (page === 1) {
                        log.warning(`Shop catalogue extraction failed on page 1: ${shopRes.errorReason}`);
                    }
                    break;
                }

                aggregatedShopInfo = {
                    ...aggregatedShopInfo,
                    ...shopRes.data.shopInfo,
                };

                if (shopRes.data.items.length === 0) break;

                let newItemsOnPage = 0;
                for (const item of shopRes.data.items) {
                    if (collectedForShop >= input.maxItemsPerQuery) break;
                    if (!seenShopCatalogueIds.has(item.itemId)) {
                        seenShopCatalogueIds.add(item.itemId);
                        shopCatalogueIds.push(item.itemId);
                        newItemsOnPage += 1;
                    }
                    taskItemIds[taskIdx]!.push(item.itemId);
                    if (!seenItemIds.has(item.itemId)) {
                        productQueue.push({
                            partial: {
                                ...aggregatedShopInfo,
                                ...item,
                            },
                            fetchDetail: input.includeDetails,
                        });
                        collectedForShop += 1;
                    }
                }

                if (newItemsOnPage === 0 || !shopRes.data.hasNextPage) break;
                page += 1;
            }

            // Output the shop summary row with full paginated catalogue, or a failed row if shop extraction failed
            if (shopCatalogueIds.length > 0 || aggregatedShopInfo.shopName) {
                taskOutcomes[taskIdx] = 'ok';
                const shopRow = await buildShopSummaryRow({
                    shopInfo: aggregatedShopInfo,
                    shopUrl: activeTask.url,
                    catalogueItemIds: shopCatalogueIds,
                    translator,
                    currencyService,
                });
                await emitRecord(shopRow, false);
            } else {
                taskOutcomes[taskIdx] = 'failed';
                await emitFailedQueryRow({
                    itemId: `shop_${activeTask.shopId ?? activeTask.shopDomain ?? 'failed'}`,
                    url: activeTask.url,
                    title: activeTask.url,
                    platform: activeTask.platform ?? 'taobao',
                    errorReason: lastShopError ?? `Failed to extract shop catalogue from ${activeTask.url}`,
                    recordType: 'shop',
                });
            }
        }
    }

    // Execute queued product extractions with bounded concurrency (each item has a hard timeout)
    await runWithConcurrency(productQueue, input.maxConcurrency, async (queued) => {
        await processProductWithTimeout(queued);
    });

    // Items left in the queue because the circuit breaker tripped get an explicit uncharged row (never silently dropped)
    if (h5Client.circuitBreaker.isTripped()) {
        for (const queued of productQueue) {
            const itemId = String(queued.partial.itemId ?? '').trim();
            if (!itemId || seenItemIds.has(itemId)) continue;
            seenItemIds.add(itemId);
            itemStatusById.set(itemId, 'failed');
            await emitFailedQueryRow({
                itemId,
                url: queued.partial.url ?? `https://item.taobao.com/item.htm?id=${itemId}`,
                title: queued.partial.title,
                platform: queued.partial.platform ?? 'taobao',
                errorReason: 'Not processed: the run stopped after repeated Taobao anti-bot blocks (circuit breaker). Not charged.',
            });
        }
    }

    // Flush any remaining buffered dataset records before persisting state
    await flushDatasetBatch();

    // Persist translation cache and monitoring hashes
    await translator.flushToKvStore();
    await monitoring.flush();
    await playwrightFallback.close().catch(() => undefined);

    for (let taskIdx = 0; taskIdx < initialTasks.length; taskIdx++) {
        if (taskOutcomes[taskIdx] === 'pending') {
            const ids = taskItemIds[taskIdx]!;
            if (ids.length > 0 && ids.every((id) => itemStatusById.get(id) === 'failed')) {
                taskOutcomes[taskIdx] = 'failed';
            } else {
                taskOutcomes[taskIdx] = 'ok';
            }
        }
    }

    const failedTasks = taskOutcomes.filter((s) => s === 'failed').length;
    const { summary, successfulProducts } = buildRunSummary(false);

    const allTasksFailed =
        initialTasks.length > 0 &&
        failedTasks === initialTasks.length &&
        successfulProducts === 0 &&
        shopRecordsEmitted === 0;

    const probeReport = h5Client.debugProbe.getReport();
    runFinalized = true;
    detachLifecycleHandlers();

    try {
        await Actor.setValue('DEBUG_PROBE', probeReport);
        await Actor.setValue('RUN_SUMMARY', summary);
        if (summary.blockedRunNote) {
            await Actor.setValue('BLOCKED_RUN_NOTE', {
                message: summary.blockedRunNote,
                troubleshootingSteps: summary.troubleshootingAdvice ?? [],
                blockRatePercent: summary.blockRatePercent,
                proxyCountryTried: summary.proxyCountry,
                proxyCountriesUsed: summary.proxyCountriesUsed,
                chargedProductEvents: 0,
            });
        }
    } catch {
        // Ignore in unit-test environments without default KV store
    }

    log.info('Taobao & Tmall Scraper run completed', summary);

    if (!allTasksFailed && summary.blockWarnings && summary.blockWarnings.length > 0) {
        try {
            await Actor.setStatusMessage(
                `Done: ${successfulProducts} product(s) returned, ${summary.countsByStatus.failed} failed (not charged). See RUN_SUMMARY.`,
            );
        } catch {
            // Ignore if status message API is unavailable locally
        }
    }

    // Count unchanged/skipped rows as successes; only Actor.fail when every task failed (failedTasks === tasks.length)
    if (allTasksFailed) {
        const failMsg = summary.blockedRunNote
            ? `All ${failedTasks} input query/item task(s) failed to extract valid data. ${summary.blockedRunNote} Check dataset errorReason and KV store BLOCKED_RUN_NOTE / DEBUG_PROBE for details.`
            : `All ${failedTasks} input query/item task(s) failed to extract valid data. Check dataset errorReason fields for details.`;
        try {
            await Actor.setStatusMessage(failMsg);
        } catch {
            // Ignore if status message API is unavailable locally
        }
        log.error(failMsg);
        await Actor.fail(failMsg, { exit: Actor.isAtHome() });
    }

    return { summary, debugProbe: probeReport };
}

if (isMainModule) {
    await Actor.init();
    try {
        const rawInput = (await Actor.getInput<ActorInput>()) ?? {};
        await runTaobaoScraper(rawInput);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Actor failed with error: ${message}`);
        await Actor.fail(message);
    } finally {
        await Actor.exit();
    }
}
