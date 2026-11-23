import { createHash } from 'node:crypto';
import { Actor, log } from 'apify';
import type { ChangeType, ProductOutput } from './types.js';

export interface MonitoredItemSnapshot {
    hash: string;
    title: string;
    price: number | null;
    originalPrice: number | null;
    promoPrice: number | null;
    finalPrice: number | null;
    stock: number | null;
    salesCount: number | null;
    skuDigest: string;
    updatedAt: string;
}

export const MONITORING_STORE_NAME = 'taobao-tmall-monitoring-state';
export const MONITORING_STATE_KEY = 'ITEMS_STATE_V1';
export const MONITORING_SHARD_COUNT = 64;

/**
 * Resolves the task/actor scoping key for monitoring state:
 * Priority: user-provided `monitoringKey` -> `ACTOR_TASK_ID` / `APIFY_ACTOR_TASK_ID` -> `ACTOR_ID` / `APIFY_ACTOR_ID` -> `'default'`.
 */
export function resolveMonitoringScopeKey(monitoringKey?: string): string {
    const raw =
        (monitoringKey && monitoringKey.trim()) ||
        process.env.ACTOR_TASK_ID ||
        process.env.APIFY_ACTOR_TASK_ID ||
        process.env.ACTOR_ID ||
        process.env.APIFY_ACTOR_ID ||
        'default';
    return raw.trim().replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
}

/**
 * Computes a deterministic hash bucket (00..63 across 64 buckets) of the itemId
 * used to shard monitoring records in the KV store uniformly so no single KV record ever hits the size limit.
 */
export function getItemShardBucket(itemId: string, numBuckets: number = MONITORING_SHARD_COUNT): string {
    const normalized = String(itemId ?? '').trim();
    const digest = createHash('sha256').update(normalized, 'utf8').digest();
    const bucketIdx = digest.readUInt32BE(0) % Math.max(1, numBuckets);
    return String(bucketIdx).padStart(2, '0');
}

export function getShardRecordKey(scopeKey: string, bucket: string): string {
    return `ITEMS_STATE_V2_${scopeKey}_${bucket}`;
}

export function getShardIndexKey(scopeKey: string): string {
    return `ITEMS_SHARDS_INDEX_${scopeKey}`;
}

/**
 * Computes a deterministic SHA-256 hash of a product's key monitored fields.
 */
export function buildMonitoredSnapshot(product: ProductOutput): MonitoredItemSnapshot {
    const skuDigest = Array.isArray(product.skus) && product.skus.length > 0
        ? product.skus
              .map((s) => `${s.skuId}:${s.price ?? ''}:${s.finalPrice ?? ''}:${s.stock ?? ''}`)
              .sort()
              .join('|')
        : Array.isArray(product.shopCatalogueItemIds)
          ? product.shopCatalogueItemIds.slice().sort().join('|')
          : '';

    const payload = JSON.stringify({
        title: product.title,
        price: product.price,
        originalPrice: product.originalPrice,
        promoPrice: product.promoPrice,
        finalPrice: product.finalPrice,
        stock: product.stock,
        salesCount: product.salesCount,
        skuDigest,
    });

    const hash = createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);

    return {
        hash,
        title: product.title,
        price: product.price,
        originalPrice: product.originalPrice,
        promoPrice: product.promoPrice,
        finalPrice: product.finalPrice,
        stock: product.stock,
        salesCount: product.salesCount,
        skuDigest,
        updatedAt: product.scrapedAt,
    };
}

/**
 * MonitoringService manages persistent item hashes and previous values in a named Key-Value Store
 * (`taobao-tmall-monitoring-state`), sharded by itemId prefix bucket and keyed per task/actor.
 * Only active and only persists state when `monitoringMode` is enabled and after a row is pushed.
 */
export class MonitoringService {
    private readonly enabled: boolean;
    private readonly persistToStore: boolean;
    private readonly scopeKey: string;
    private readonly stateMap = new Map<string, MonitoredItemSnapshot>();
    private readonly loadedBuckets = new Set<string>();
    private readonly knownBuckets = new Set<string>();
    private readonly dirtyBuckets = new Set<string>();
    private store: Awaited<ReturnType<typeof Actor.openKeyValueStore>> | null = null;

    constructor(
        enabled = false,
        initialState?: Record<string, MonitoredItemSnapshot>,
        options?: { persistToStore?: boolean; monitoringKey?: string },
    ) {
        this.enabled = enabled;
        this.persistToStore = options?.persistToStore ?? true;
        this.scopeKey = resolveMonitoringScopeKey(options?.monitoringKey);
        if (initialState) {
            for (const [k, v] of Object.entries(initialState)) {
                this.stateMap.set(k, v);
                const bucket = getItemShardBucket(k);
                this.knownBuckets.add(bucket);
                this.loadedBuckets.add(bucket);
            }
        }
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    public getScopeKey(): string {
        return this.scopeKey;
    }

    public async init(): Promise<void> {
        if (!this.enabled || !this.persistToStore) return;
        try {
            this.store = await Actor.openKeyValueStore(MONITORING_STORE_NAME);
            log.info(
                `MonitoringService initialized (scope="${this.scopeKey}", lazy hash-sharding across ${MONITORING_SHARD_COUNT} buckets).`,
            );
        } catch (err) {
            log.warning(
                `Could not open named Key-Value Store "${MONITORING_STORE_NAME}", falling back to in-memory state: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    public getLoadedBucketCount(): number {
        return this.loadedBuckets.size;
    }

    private async loadShardBucket(bucket: string): Promise<void> {
        if (this.loadedBuckets.has(bucket)) return;
        this.loadedBuckets.add(bucket);
        if (!this.store) return;
        try {
            const shardKey = getShardRecordKey(this.scopeKey, bucket);
            const saved = await this.store.getValue<Record<string, MonitoredItemSnapshot>>(shardKey);
            if (saved && typeof saved === 'object') {
                this.knownBuckets.add(bucket);
                for (const [itemId, snap] of Object.entries(saved)) {
                    if (snap && typeof snap === 'object' && typeof snap.hash === 'string') {
                        if (!this.stateMap.has(itemId)) {
                            this.stateMap.set(itemId, snap);
                        }
                    }
                }
            }
        } catch {
            // Ignore shard read errors
        }
    }

    /**
     * Evaluates a scraped ProductOutput against stored state WITHOUT mutating state.
     * State is only updated later via `commitEmittedRecord()` after the record is charged and pushed.
     */
    public async evaluateAsync(product: ProductOutput): Promise<{
        product: ProductOutput;
        shouldEmit: boolean;
    }> {
        if (!this.enabled) {
            product.changeType = null;
            product.previousValues = {};
            return { product, shouldEmit: true };
        }

        if (product.status === 'failed' || !product.itemId) {
            product.changeType = null;
            product.previousValues = {};
            return { product, shouldEmit: false };
        }

        const bucket = getItemShardBucket(product.itemId);
        await this.loadShardBucket(bucket);

        return this.evaluate(product);
    }

    /**
     * Synchronous evaluation against already-loaded state WITHOUT mutating state.
     */
    public evaluate(product: ProductOutput): {
        product: ProductOutput;
        shouldEmit: boolean;
    } {
        if (!this.enabled) {
            product.changeType = null;
            product.previousValues = {};
            return { product, shouldEmit: true };
        }

        if (product.status === 'failed' || !product.itemId) {
            product.changeType = null;
            product.previousValues = {};
            return {
                product,
                shouldEmit: false,
            };
        }

        const currentSnap = buildMonitoredSnapshot(product);
        const prevSnap = this.stateMap.get(product.itemId);

        let changeType: ChangeType = 'new';
        const previousValues: Record<string, unknown> = {};

        if (!prevSnap) {
            changeType = 'new';
        } else if (prevSnap.hash === currentSnap.hash) {
            changeType = 'unchanged';
        } else {
            changeType = 'changed';
            const trackedFields: Array<keyof Omit<MonitoredItemSnapshot, 'hash' | 'updatedAt' | 'skuDigest'>> = [
                'title',
                'price',
                'originalPrice',
                'promoPrice',
                'finalPrice',
                'stock',
                'salesCount',
            ];
            for (const field of trackedFields) {
                if (prevSnap[field] !== currentSnap[field]) {
                    previousValues[field] = prevSnap[field];
                }
            }
            if (prevSnap.skuDigest !== currentSnap.skuDigest) {
                previousValues.skuDigestChanged = true;
            }
        }

        product.changeType = changeType;
        product.previousValues = previousValues;

        const shouldEmit = changeType === 'new' || changeType === 'changed';
        return { product, shouldEmit };
    }

    /**
     * Marks an item as seen/updated in the monitoring state ONLY after the row has been pushed,
     * and ONLY when `monitoringMode` is true.
     */
    public commitEmittedRecord(product: ProductOutput): void {
        if (!this.enabled) return;
        if (product.status === 'failed' || !product.itemId) return;

        const currentSnap = buildMonitoredSnapshot(product);
        this.stateMap.set(product.itemId, currentSnap);
        const bucket = getItemShardBucket(product.itemId);
        this.knownBuckets.add(bucket);
        this.dirtyBuckets.add(bucket);
    }

    /**
     * Backwards-compatible helper that evaluates and immediately records when enabled.
     */
    public evaluateAndRecord(product: ProductOutput): {
        product: ProductOutput;
        shouldEmit: boolean;
    } {
        const res = this.evaluate(product);
        if (res.shouldEmit) {
            this.commitEmittedRecord(product);
        }
        return res;
    }

    public async flush(): Promise<void> {
        if (!this.enabled || !this.store || this.dirtyBuckets.size === 0) return;
        try {
            // Ensure any dirty bucket that was modified synchronously is loaded before writing so existing items in that shard are preserved
            for (const bucket of this.dirtyBuckets) {
                await this.loadShardBucket(bucket);
            }

            const byBucket = new Map<string, Record<string, MonitoredItemSnapshot>>();
            for (const bucket of this.dirtyBuckets) {
                byBucket.set(bucket, {});
            }

            for (const [itemId, snap] of this.stateMap.entries()) {
                const bucket = getItemShardBucket(itemId);
                if (this.dirtyBuckets.has(bucket)) {
                    byBucket.get(bucket)![itemId] = snap;
                }
            }

            for (const [bucket, records] of byBucket.entries()) {
                const shardKey = getShardRecordKey(this.scopeKey, bucket);
                await this.store.setValue(shardKey, records);
            }

            const indexKey = getShardIndexKey(this.scopeKey);
            const existingIndex = await this.store.getValue<string[]>(indexKey);
            if (Array.isArray(existingIndex)) {
                for (const b of existingIndex) {
                    if (typeof b === 'string' && b) this.knownBuckets.add(b);
                }
            }
            await this.store.setValue(indexKey, Array.from(this.knownBuckets).sort());

            const flushedBucketsCount = this.dirtyBuckets.size;
            this.dirtyBuckets.clear();
            log.info(
                `Saved ${this.stateMap.size} item monitoring hashes across ${flushedBucketsCount} updated shard(s) to named KV store "${MONITORING_STORE_NAME}" (scope="${this.scopeKey}").`,
            );
        } catch (err) {
            log.warning(`Failed to save monitoring state: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
