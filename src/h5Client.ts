import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { Session, SessionPool } from '@crawlee/core';
import { log } from 'apify';
import { gotScraping } from 'got-scraping';
import { DebugProbeCollector, type DebugProbeUrlType, inferDebugProbeUrlType } from './debugProbe.js';
import type { DataSourceResult, PlatformType } from './types.js';

try {
    dns.setDefaultResultOrder('ipv4first');
} catch {
    // Ignore if unsupported in environment
}

function formatErrorMessage(err: unknown): string {
    if (err instanceof Error) {
        const code = (err as { code?: string }).code;
        if (err.message && err.message.trim()) {
            return code ? `${err.message} (${code})` : err.message;
        }
        return code || err.name || 'Network connection error';
    }
    return String(err) || 'Unknown network error';
}

export const H5_APP_KEY = '12574478';

export type H5Domain = 'h5api.m.taobao.com' | 'h5api.m.tmall.com' | 'h5api-intl.m.taobao.com';

export interface DomainTokenJar {
    domain: H5Domain;
    token: string;
    mH5TkCookie: string;
    mH5TkEncCookie: string;
    cnaCookie?: string;
    tCookie?: string;
    warmedUp?: boolean;
    extraCookies: Map<string, string>;
    updatedAt: number;
}

const POISON_COOKIE_NAMES = new Set(['x5secdata', 'x5sec', 'punish']);

/**
 * Parses a user-provided cookie string (either `k=v; k2=v2` header format or JSON array format
 * exported from browser extensions like EditThisCookie / Cookie-Editor) into a clean `k=v; k2=v2` string.
 */
export function normalizeUserCookieString(rawCookie?: string | null): string | undefined {
    if (!rawCookie || typeof rawCookie !== 'string') return undefined;
    const trimmed = rawCookie.trim();
    if (!trimmed) return undefined;

    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed) as Array<{ name?: string; value?: string }>;
            if (Array.isArray(parsed)) {
                const pairs: string[] = [];
                for (const item of parsed) {
                    const name = typeof item?.name === 'string' ? item.name.trim() : '';
                    const value = typeof item?.value === 'string' ? item.value.trim() : '';
                    if (name && value && !POISON_COOKIE_NAMES.has(name.toLowerCase())) {
                        pairs.push(`${name}=${value}`);
                    }
                }
                return pairs.length > 0 ? pairs.join('; ') : undefined;
            }
        } catch {
            // Fall through to standard header parsing
        }
    }

    const pairs: string[] = [];
    for (const part of trimmed.split(';')) {
        const clean = part.trim();
        const eqIdx = clean.indexOf('=');
        if (eqIdx > 0) {
            const name = clean.slice(0, eqIdx).trim();
            const val = clean.slice(eqIdx + 1).trim();
            if (name && val && !POISON_COOKIE_NAMES.has(name.toLowerCase())) {
                pairs.push(`${name}=${val}`);
            }
        }
    }
    return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/**
 * Computes the Taobao/Tmall MTOP H5 MD5 signature:
 * Sign = md5(token + "&" + t + "&" + "12574478" + "&" + data)
 */
export function computeMtopSign(
    token: string,
    timestamp: string | number,
    dataJson: string,
    appKey: string = H5_APP_KEY,
): string {
    const payload = `${token}&${timestamp}&${appKey}&${dataJson}`;
    return createHash('md5').update(payload, 'utf8').digest('hex');
}

/**
 * Serializes data object into compact JSON with key insertion order preserved.
 */
export function serializeCompactMtopData(data: Record<string, unknown> | string): string {
    if (typeof data === 'string') {
        return data.trim();
    }
    return JSON.stringify(data);
}

/**
 * Extracts the 32-char token prefix from the `_m_h5_tk` cookie value (`<token>_<timestamp>`).
 */
export function extractH5TokenFromCookie(cookieValue: string | undefined | null): string {
    if (!cookieValue) return '';
    const trimmed = cookieValue.trim();
    const underscoreIdx = trimmed.indexOf('_');
    return underscoreIdx > 0 ? trimmed.slice(0, underscoreIdx) : trimmed;
}

/**
 * Parses `Set-Cookie` header array and updates a DomainTokenJar.
 * Never saves poison challenge cookies (`x5secdata`, `x5sec`).
 */
export function updateTokenJarFromSetCookieHeaders(
    jar: DomainTokenJar,
    setCookieHeaders: string[] | string | undefined,
): boolean {
    if (!setCookieHeaders) return false;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    let updatedToken = false;

    for (const rawHeader of headers) {
        const firstPart = rawHeader.split(';')[0]?.trim();
        if (!firstPart) continue;
        const eqIdx = firstPart.indexOf('=');
        if (eqIdx <= 0) continue;

        const name = firstPart.slice(0, eqIdx).trim();
        const value = firstPart.slice(eqIdx + 1).trim();

        if (!name || !value || value === 'deleted') continue;
        if (POISON_COOKIE_NAMES.has(name.toLowerCase())) {
            continue;
        }

        if (name === '_m_h5_tk') {
            jar.mH5TkCookie = value;
            jar.token = extractH5TokenFromCookie(value);
            jar.updatedAt = Date.now();
            updatedToken = true;
        } else if (name === '_m_h5_tk_enc') {
            jar.mH5TkEncCookie = value;
            jar.updatedAt = Date.now();
        } else {
            if (name === 'cna') jar.cnaCookie = value;
            if (name === 't') jar.tCookie = value;
            jar.extraCookies.set(name, value);
        }
    }

    return updatedToken;
}

/**
 * Formats the Cookie header string for a given DomainTokenJar and optional user-supplied Cookie string.
 */
export function buildCookieHeader(jar: DomainTokenJar, userCookie?: string): string {
    const cookieMap = new Map<string, string>();

    const normalizedUser = normalizeUserCookieString(userCookie);
    if (normalizedUser) {
        for (const pair of normalizedUser.split(';')) {
            const trimmed = pair.trim();
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
                const k = trimmed.slice(0, eqIdx).trim();
                const v = trimmed.slice(eqIdx + 1).trim();
                if (!POISON_COOKIE_NAMES.has(k.toLowerCase())) {
                    cookieMap.set(k, v);
                }
            }
        }
    }

    for (const [k, v] of jar.extraCookies.entries()) {
        if (!POISON_COOKIE_NAMES.has(k.toLowerCase())) {
            cookieMap.set(k, v);
        }
    }

    if (jar.cnaCookie) {
        cookieMap.set('cna', jar.cnaCookie);
    }
    if (jar.tCookie) {
        cookieMap.set('t', jar.tCookie);
    }
    if (jar.mH5TkCookie) {
        cookieMap.set('_m_h5_tk', jar.mH5TkCookie);
    }
    if (jar.mH5TkEncCookie) {
        cookieMap.set('_m_h5_tk_enc', jar.mH5TkEncCookie);
    }

    return Array.from(cookieMap.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

/**
 * Detects whether an MTOP JSON payload or HTTP response indicates an anti-bot block / slider / captcha
 * (e.g. x5sec / Baxia / RGV587_ERROR / FAIL_SYS_USER_VALIDATE / rgv587_flag).
 */
export function isBlockOrCaptchaResponse(
    statusCode: number,
    bodyText: string,
    retArray?: string[],
): { blocked: boolean; tokenExpired: boolean; reason?: string } {
    if (statusCode === 429 || statusCode === 403) {
        return { blocked: true, tokenExpired: false, reason: `HTTP ${statusCode} rate-limit or block` };
    }

    if (Array.isArray(retArray) && retArray.length > 0) {
        const retJoined = retArray.join(' | ');
        if (
            retJoined.includes('FAIL_SYS_TOKEN_EMPTY') ||
            retJoined.includes('FAIL_SYS_TOKEN_EXOIRED') ||
            retJoined.includes('FAIL_SYS_TOKEN_EXPIRED') ||
            retJoined.includes('FAIL_SYS_ILLEGAL_ACCESS')
        ) {
            return { blocked: false, tokenExpired: true, reason: retJoined };
        }

        if (
            retJoined.includes('FAIL_SYS_USER_VALIDATE') ||
            retJoined.includes('RGV587_ERROR') ||
            retJoined.includes('FAIL_BIZ_BAXIA') ||
            retJoined.includes('FAIL_SYS_TRAFFIC_LIMIT') ||
            retJoined.includes('挤爆了') ||
            retJoined.includes('被挤爆啦')
        ) {
            return { blocked: true, tokenExpired: false, reason: `MTOP anti-bot block: ${retJoined}` };
        }
    }

    const lowerBody = bodyText.toLowerCase();
    if (
        lowerBody.includes('x5secdata') ||
        lowerBody.includes('baxia-dialog') ||
        lowerBody.includes('punish?x5secdata') ||
        lowerBody.includes('rgv587_error') ||
        lowerBody.includes('rgv587_flag') ||
        lowerBody.includes('_____tmd_____/page/') ||
        lowerBody.includes('fail_sys_user_validate') ||
        (lowerBody.includes('sec.taobao.com') && lowerBody.includes('punish'))
    ) {
        const isRgv587 = lowerBody.includes('rgv587_error') || lowerBody.includes('rgv587_flag');
        return {
            blocked: true,
            tokenExpired: false,
            reason: isRgv587
                ? 'MTOP anti-bot block: RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!'
                : 'Captcha / slider challenge (x5sec/Baxia) detected',
        };
    }

    return { blocked: false, tokenExpired: false };
}

/**
 * Shared module-level cooldown gate promise so all concurrent workers across the module
 * pause together when a CircuitBreaker enters its cooldown window.
 */
let sharedModulePauseGate: Promise<void> | null = null;

/**
 * Circuit Breaker:
 * If 5 consecutive requests are blocked:
 * - First cycle: pause 60s (configurable for testing) via a shared module-level gate so all workers pause together
 * - If 5 consecutive requests are blocked again after pausing: trip circuit breaker so the run stops gracefully.
 */
export class CircuitBreaker {
    private consecutiveBlocks = 0;
    private pausedCycles = 0;
    private tripped = false;
    private totalBlocks = 0;
    private totalRequests = 0;
    private instancePauseGate: Promise<void> | null = null;
    private readonly threshold: number;
    private readonly pauseDurationMs: number;
    private deadlineMs = Number.POSITIVE_INFINITY;

    constructor(options?: { threshold?: number; pauseDurationMs?: number }) {
        this.threshold = options?.threshold ?? 5;
        this.pauseDurationMs = options?.pauseDurationMs ?? 30_000;
    }

    /** Run deadline (epoch ms). Cooldown pauses are capped so they never push the run past it. */
    public setDeadline(deadlineMs: number): void {
        if (Number.isFinite(deadlineMs)) this.deadlineMs = deadlineMs;
    }

    /** Trip immediately (e.g. no time left for a cooldown); remaining items become uncharged failed rows. */
    public trip(reason: string): void {
        if (this.tripped) return;
        this.tripped = true;
        log.error(`Circuit breaker tripped: ${reason}. Stopping gracefully; failed rows are never charged.`);
    }

    public isTripped(): boolean {
        return this.tripped;
    }

    public isPaused(): boolean {
        return Boolean(this.instancePauseGate || sharedModulePauseGate);
    }

    public async waitForGate(): Promise<void> {
        while (this.instancePauseGate || sharedModulePauseGate) {
            await (this.instancePauseGate ?? sharedModulePauseGate);
        }
    }

    public getStats(): {
        consecutiveBlocks: number;
        pausedCycles: number;
        tripped: boolean;
        totalBlocks: number;
        totalRequests: number;
        blockRate: number;
    } {
        return {
            consecutiveBlocks: this.consecutiveBlocks,
            pausedCycles: this.pausedCycles,
            tripped: this.tripped,
            totalBlocks: this.totalBlocks,
            totalRequests: this.totalRequests,
            blockRate: this.totalRequests > 0 ? Math.round((this.totalBlocks / this.totalRequests) * 10000) / 100 : 0,
        };
    }

    public recordSuccess(): void {
        this.totalRequests += 1;
        this.consecutiveBlocks = 0;
    }

    public async recordBlock(reason: string): Promise<void> {
        this.totalRequests += 1;
        this.totalBlocks += 1;

        if (this.instancePauseGate || sharedModulePauseGate) {
            await this.waitForGate();
            return;
        }

        this.consecutiveBlocks += 1;

        log.warning('Request blocked by Taobao/Tmall anti-bot protection', {
            reason,
            consecutiveBlocks: this.consecutiveBlocks,
            threshold: this.threshold,
            pausedCycles: this.pausedCycles,
        });

        if (this.consecutiveBlocks >= this.threshold) {
            // Leave at least 30s after the pause to actually retry; otherwise pausing only burns compute.
            const availableMs = this.deadlineMs - Date.now() - 30_000;
            const pauseMs = Math.max(0, Math.min(this.pauseDurationMs, availableMs));
            if (this.pausedCycles === 0 && availableMs < Math.min(5_000, this.pauseDurationMs)) {
                this.trip(`${this.threshold} consecutive anti-bot blocks and not enough run time left for a cooldown`);
            } else if (this.pausedCycles === 0) {
                this.pausedCycles += 1;
                this.consecutiveBlocks = 0;
                log.warning(
                    `Circuit breaker triggered (${this.threshold} consecutive blocks). Pausing for ${Math.round(
                        pauseMs / 1000,
                    )}s before resuming with fresh proxy sessions...`,
                );
                const gate = new Promise<void>((resolve) => setTimeout(resolve, pauseMs)).finally(() => {
                    if (sharedModulePauseGate === gate) {
                        sharedModulePauseGate = null;
                    }
                    if (this.instancePauseGate === gate) {
                        this.instancePauseGate = null;
                    }
                });
                this.instancePauseGate = gate;
                sharedModulePauseGate = gate;
                await gate;
            } else {
                this.tripped = true;
                log.error(
                    `Circuit breaker tripped permanently after repeated ${this.threshold} consecutive blocks following cooldown pause. Stopping gracefully to protect run quality.`,
                );
            }
        }
    }
}

export interface H5ClientOptions {
    userCookie?: string;
    getProxyUrl?: (sessionId: string, countryCode?: string) => Promise<string | undefined>;
    circuitBreaker?: CircuitBreaker;
    debugProbe?: DebugProbeCollector;
    proxyGroup?: string;
    proxyCountry?: string;
    proxyFallbackCountries?: string[];
    enableSessionWarmup?: boolean;
    forceWarmupWithCustomFetch?: boolean;
    maxRetries?: number;
    baseBackoffMs?: number;
    requestDelayMs?: number;
    customFetch?: (url: string, options: {
        headers: Record<string, string>;
        proxyUrl?: string;
        followRedirect?: boolean;
    }) => Promise<{
        statusCode: number;
        body: string;
        headers: Record<string, string | string[] | undefined>;
        redirectUrls?: string[];
    }>;
}

const REAL_BROWSER_HEADERS: Record<string, string> = {
    'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
};

/**
 * Mobile H5 API & HTTP client with:
 * - Crawlee SessionPool integration (one cookie jar per proxy session, retired on RGV587)
 * - Session warm-up (visiting Taobao homepage + mmstat eg.js + MTOP timestamp bootstrap)
 * - Separate token jars per domain (`h5api.m.taobao.com` and `h5api.m.tmall.com`)
 * - Automatic `_m_h5_tk` token initialization and renewal
 * - Proxy session & country rotation (CN -> HK -> TW -> SG -> US) and exponential backoff
 * - DEBUG_PROBE request telemetry (never storing cookie values or tokens)
 */
export class TaobaoH5Client {
    private readonly tokenJars = new Map<string, DomainTokenJar>();
    private readonly crawleeSessions = new Map<string, Session>();
    private readonly retiredSessionIds = new Set<string>();
    private readonly sessionPool: SessionPool;
    private readonly userCookie?: string;
    private readonly getProxyUrl?: (sessionId: string, countryCode?: string) => Promise<string | undefined>;
    public readonly circuitBreaker: CircuitBreaker;
    public readonly debugProbe: DebugProbeCollector;
    private readonly proxyGroup: string;
    private readonly proxyFallbackCountries: string[];
    private currentCountryIndex = 0;
    private readonly enableSessionWarmup: boolean;
    private readonly forceWarmupWithCustomFetch: boolean;
    private readonly maxRetries: number;
    private readonly baseBackoffMs: number;
    private readonly requestDelayMs: number;
    private readonly customFetch?: H5ClientOptions['customFetch'];
    private sessionCounter = 1;
    private activeSessionId: string;
    /** Proxy countries actually used for outgoing requests (country -> request count). */
    private readonly proxyCountriesUsed = new Map<string, number>();
    /** Blocks seen on direct MTOP calls made with `skipBreaker` (they never pause/trip the HTML circuit breaker). */
    private mtopFastFailBlocks = 0;
    public static readonly MTOP_FAST_FAIL_LIMIT = 4;

    constructor(options: H5ClientOptions = {}) {
        this.userCookie = normalizeUserCookieString(options.userCookie);
        this.getProxyUrl = options.getProxyUrl;
        this.circuitBreaker = options.circuitBreaker ?? new CircuitBreaker();
        this.proxyGroup = options.proxyGroup ?? 'RESIDENTIAL';
        const initialCountry = (options.proxyCountry ?? 'CN').toUpperCase().trim();
        const defaultChain = ['CN', 'HK', 'TW', 'SG', 'US'];
        this.proxyFallbackCountries = options.proxyFallbackCountries?.length
            ? [...new Set(options.proxyFallbackCountries.map((c) => c.toUpperCase().trim()))]
            : [initialCountry, ...defaultChain.filter((c) => c !== initialCountry)];
        this.debugProbe =
            options.debugProbe ??
            new DebugProbeCollector({
                proxyGroup: this.proxyGroup,
                proxyCountry: this.proxyFallbackCountries[0] ?? 'CN',
            });
        this.enableSessionWarmup = options.enableSessionWarmup ?? true;
        this.forceWarmupWithCustomFetch = options.forceWarmupWithCustomFetch ?? false;
        this.maxRetries = options.maxRetries ?? 3;
        this.baseBackoffMs = options.baseBackoffMs ?? 1500;
        this.requestDelayMs = options.requestDelayMs ?? (options.customFetch ? 0 : 1000);
        this.customFetch = options.customFetch;

        this.sessionPool = new SessionPool({
            maxPoolSize: 50,
            sessionOptions: {
                maxUsageCount: 25,
                maxErrorScore: 1,
            },
        });
        this.activeSessionId = `tb_sess_${this.sessionCounter}`;
        this.ensureCrawleeSession(this.activeSessionId);
    }

    private ensureCrawleeSession(sessionId: string): Session {
        let session = this.crawleeSessions.get(sessionId);
        if (!session) {
            session = new Session({
                id: sessionId,
                sessionPool: this.sessionPool,
                maxUsageCount: 25,
                maxErrorScore: 1,
            });
            this.crawleeSessions.set(sessionId, session);
        }
        return session;
    }

    /** Returns proxy countries actually used for requests (most used first). */
    public getProxyCountriesUsed(): Record<string, number> {
        return Object.fromEntries([...this.proxyCountriesUsed.entries()].sort((a, b) => b[1] - a[1]));
    }

    /** Most used proxy country so far, or null when no proxied request was made. */
    public getPrimaryProxyCountryUsed(): string | null {
        const sorted = [...this.proxyCountriesUsed.entries()].sort((a, b) => b[1] - a[1]);
        return sorted[0]?.[0] ?? null;
    }

    public recordProxyCountryUsed(country: string | null | undefined): void {
        if (!country) return;
        const c = country.toUpperCase();
        this.proxyCountriesUsed.set(c, (this.proxyCountriesUsed.get(c) ?? 0) + 1);
    }

    /** True once direct MTOP detail calls have been blocked often enough that retrying them only wastes run time. */
    public isMtopFastFailExhausted(): boolean {
        return this.mtopFastFailBlocks >= TaobaoH5Client.MTOP_FAST_FAIL_LIMIT;
    }

    public getMtopFastFailBlocks(): number {
        return this.mtopFastFailBlocks;
    }

    /** Returns a proxy URL for an ad-hoc session/country (used by translation and the Playwright fallback). */
    public async getProxyUrlFor(sessionId: string, countryCode?: string): Promise<string | undefined> {
        if (!this.getProxyUrl) return undefined;
        const url = await this.getProxyUrl(sessionId, countryCode);
        if (url) this.recordProxyCountryUsed(countryCode ?? this.getActiveProxyCountry());
        return url;
    }

    public getActiveProxyCountry(): string {
        return this.proxyFallbackCountries[this.currentCountryIndex % this.proxyFallbackCountries.length] ?? 'CN';
    }

    public getRetiredSessionIds(): string[] {
        return [...this.retiredSessionIds];
    }

    /**
     * Retires a proxy session in Crawlee's SessionPool upon RGV587 or captcha block,
     * discards its poisoned cookie jar, and rotates to a new session & fallback country.
     */
    public retireSession(sessionId: string, reason = 'RGV587_ERROR'): string {
        const session = this.crawleeSessions.get(sessionId);
        if (session) {
            session.retire();
        }
        this.retiredSessionIds.add(sessionId);
        this.tokenJars.delete(`h5api.m.taobao.com::${sessionId}`);
        this.tokenJars.delete(`h5api.m.tmall.com::${sessionId}`);

        if (reason.includes('RGV587') || reason.includes('block') || reason.includes('Captcha')) {
            this.currentCountryIndex = (this.currentCountryIndex + 1) % this.proxyFallbackCountries.length;
        }

        return this.rotateSessionId();
    }

    /**
     * Gets or creates a dedicated token jar for a specific H5 domain (`h5api.m.taobao.com` or `h5api.m.tmall.com`)
     * and session bucket.
     */
    public getTokenJar(domain: H5Domain, sessionBucket = 'default'): DomainTokenJar {
        const key = `${domain}::${sessionBucket}`;
        let jar = this.tokenJars.get(key);
        if (!jar) {
            jar = {
                domain,
                token: '',
                mH5TkCookie: '',
                mH5TkEncCookie: '',
                warmedUp: false,
                extraCookies: new Map<string, string>(),
                updatedAt: 0,
            };
            if (this.userCookie) {
                updateTokenJarFromSetCookieHeaders(
                    jar,
                    this.userCookie.split(';').map((s) => s.trim()),
                );
            }
            this.tokenJars.set(key, jar);
        }
        return jar;
    }

    public getTokenJarSnapshot(domain: H5Domain, sessionBucket?: string): {
        domain: H5Domain;
        token: string;
        mH5TkCookie: string;
        mH5TkEncCookie: string;
        extraCookies: Record<string, string>;
    } {
        const jar = this.getTokenJar(domain, sessionBucket ?? this.activeSessionId);
        return {
            domain: jar.domain,
            token: jar.token,
            mH5TkCookie: jar.mH5TkCookie,
            mH5TkEncCookie: jar.mH5TkEncCookie,
            extraCookies: Object.fromEntries(jar.extraCookies.entries()),
        };
    }

    public async fetchHtmlPage(
        url: string,
        _maxAttempts = 2,
    ): Promise<DataSourceResult<{ body: string; finalUrl: string; statusCode: number }>> {
        return this.fetchPage(url);
    }

    public rotateSessionId(): string {
        this.sessionCounter += 1;
        this.activeSessionId = `tb_sess_${this.sessionCounter}_${Math.random().toString(36).slice(2, 8)}`;
        this.ensureCrawleeSession(this.activeSessionId);
        return this.activeSessionId;
    }

    public getCurrentSessionId(): string {
        return this.activeSessionId;
    }

    private async politeDelay(multiplier = 1): Promise<void> {
        if (this.requestDelayMs <= 0) return;
        // Random 1-4s human-like delay when using default production pacing, or scaled around requestDelayMs
        const jitter = this.requestDelayMs >= 1000
            ? Math.floor(Math.random() * 2500)
            : Math.floor(Math.random() * 150);
        await new Promise((resolve) => setTimeout(resolve, this.requestDelayMs * multiplier + jitter));
    }

    private async executeHttpGet(
        url: string,
        headers: Record<string, string>,
        sessionId: string,
        followRedirect = true,
        urlType?: DebugProbeUrlType,
        jarForProbe?: DomainTokenJar,
        countryOverride?: string,
    ): Promise<{
        statusCode: number;
        body: string;
        headers: Record<string, string | string[] | undefined>;
        redirectUrls?: string[];
    }> {
        const rawActiveCountry = this.getActiveProxyCountry();
        const activeCountry = countryOverride
            ? countryOverride.toUpperCase()
            : !this.customFetch && url.includes('world.taobao.com') && rawActiveCountry === 'CN'
              ? 'TW'
              : rawActiveCountry;
        const proxyUrl = this.getProxyUrl ? await this.getProxyUrl(sessionId, activeCountry) : undefined;
        if (proxyUrl) this.recordProxyCountryUsed(activeCountry);
        const crawleeSession = this.ensureCrawleeSession(sessionId);

        let res: {
            statusCode: number;
            body: string;
            headers: Record<string, string | string[] | undefined>;
            redirectUrls?: string[];
        };

        if (this.customFetch) {
            res = await this.customFetch(url, { headers, proxyUrl, followRedirect });
        } else {
            const response = await gotScraping({
                url,
                method: 'GET',
                headers,
                proxyUrl,
                followRedirect,
                throwHttpErrors: false,
                timeout: { request: 12_000 },
                retry: { limit: 0 },
            });

            res = {
                statusCode: response.statusCode,
                body: typeof response.body === 'string' ? response.body : String(response.body),
                headers: response.headers as Record<string, string | string[] | undefined>,
                redirectUrls: response.redirectUrls?.map((u) => u.toString()),
            };
        }

        crawleeSession.markGood();

        const extraCookieObj: Record<string, string> = {};
        if (jarForProbe) {
            for (const [k, v] of jarForProbe.extraCookies.entries()) {
                extraCookieObj[k] = v;
            }
            if (jarForProbe.mH5TkCookie) extraCookieObj._m_h5_tk = jarForProbe.mH5TkCookie;
            if (jarForProbe.mH5TkEncCookie) extraCookieObj._m_h5_tk_enc = jarForProbe.mH5TkEncCookie;
            if (jarForProbe.cnaCookie) extraCookieObj.cna = jarForProbe.cnaCookie;
            if (jarForProbe.tCookie) extraCookieObj.t = jarForProbe.tCookie;
        }

        this.debugProbe.record({
            url,
            urlType: inferDebugProbeUrlType(url, urlType),
            statusCode: res.statusCode,
            proxyGroup: proxyUrl ? this.proxyGroup : (this.getProxyUrl ? this.proxyGroup : 'NONE'),
            proxyCountry: proxyUrl || this.getProxyUrl ? activeCountry : null,
            cookieSources: [headers.Cookie, res.headers['set-cookie'], extraCookieObj],
            body: res.body,
        });

        return res;
    }

    /**
     * Strategy 2a: Warms up a proxy session by visiting Taobao homepage, Alibaba mmstat `eg.js` (for `cna`),
     * and bootstrapping a clean `_m_h5_tk` + `_m_h5_tk_enc` cookie pair before MTOP calls.
     */
    public async warmUpSession(
        domain: H5Domain = 'h5api.m.taobao.com',
        sessionId: string = this.activeSessionId,
    ): Promise<boolean> {
        const jar = this.getTokenJar(domain, sessionId);
        if (jar.warmedUp && jar.token) {
            return true;
        }

        const warmupHeaders: Record<string, string> = {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            ...REAL_BROWSER_HEADERS,
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        };

        try {
            // Step 1: Visit Taobao homepage to collect initial browser session cookies (`t`, `thw`, `cookie2`)
            const homeRes = await this.executeHttpGet(
                'https://world.taobao.com/',
                warmupHeaders,
                sessionId,
                true,
                'warmup',
                jar,
            );
            updateTokenJarFromSetCookieHeaders(jar, homeRes.headers['set-cookie']);

            // Step 2: Visit Alibaba mmstat eg.js to collect `cna` visitor fingerprint cookie
            const egHeaders: Record<string, string> = {
                Accept: '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
                Referer: 'https://world.taobao.com/',
                'User-Agent': warmupHeaders['User-Agent']!,
            };
            const cookieAfterHome = buildCookieHeader(jar, this.userCookie);
            if (cookieAfterHome) egHeaders.Cookie = cookieAfterHome;

            try {
                const egRes = await this.executeHttpGet(
                    'https://log.mmstat.com/eg.js',
                    egHeaders,
                    sessionId,
                    true,
                    'warmup',
                    jar,
                );
                updateTokenJarFromSetCookieHeaders(jar, egRes.headers['set-cookie']);
                if (!jar.cnaCookie) {
                    const cnaMatch = egRes.body.match(/goldlog\.Etag\s*=\s*["']([^"']+)["']/i);
                    if (cnaMatch?.[1]) {
                        jar.cnaCookie = cnaMatch[1];
                        jar.extraCookies.set('cna', cnaMatch[1]);
                    }
                }
            } catch {
                // Non-fatal if mmstat is unreachable
            }

            if (!jar.cnaCookie) {
                jar.cnaCookie = 'YgF1H8xK2mQCAX9vL3pRtW0z';
                jar.extraCookies.set('cna', jar.cnaCookie);
            }

            // Step 3: Bootstrap `_m_h5_tk` + `_m_h5_tk_enc` via lightweight MTOP timestamp endpoint
            if (!jar.token) {
                const t = String(Date.now());
                const emptyData = '{}';
                const sign = computeMtopSign('', t, emptyData, H5_APP_KEY);
                const bootstrapUrl = `https://${domain}/h5/mtop.common.gettimestamp/1.0/?jsv=2.7.2&appKey=${H5_APP_KEY}&t=${t}&sign=${sign}&api=mtop.common.gettimestamp&v=1.0&type=originaljson&dataType=json&data=%7B%7D`;
                const mtopHeaders: Record<string, string> = {
                    Accept: 'application/json, text/plain, */*',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
                    Referer: 'https://world.taobao.com/',
                    Origin: 'https://world.taobao.com',
                    'User-Agent': warmupHeaders['User-Agent']!,
                };
                const cookieBeforeMtop = buildCookieHeader(jar, this.userCookie);
                if (cookieBeforeMtop) mtopHeaders.Cookie = cookieBeforeMtop;

                const tokenRes = await this.executeHttpGet(
                    bootstrapUrl,
                    mtopHeaders,
                    sessionId,
                    true,
                    'warmup',
                    jar,
                );
                updateTokenJarFromSetCookieHeaders(jar, tokenRes.headers['set-cookie']);
            }

            jar.warmedUp = true;
            return Boolean(jar.token);
        } catch {
            jar.warmedUp = true;
            return Boolean(jar.token);
        }
    }

    /**
     * Calls an MTOP H5 endpoint (`mtop.taobao.pcdetail.data.get` or `mtop.taobao.detail.getdetail`, etc.)
     * with automatic session warm-up, token handshake, separate domain token jars, session retirement on RGV587,
     * and up to 3 block retries.
     */
    public async requestMtop<T = Record<string, unknown>>(params: {
        api: string;
        version?: string;
        platform?: PlatformType;
        data: Record<string, unknown> | string;
        extraParams?: Record<string, string>;
        /** Override API host (e.g. `h5api-intl.m.taobao.com` used by the overseas m.intl detail page). */
        host?: H5Domain;
        /** Override max attempts for this call (fast-fail product layers use 1). */
        maxAttempts?: number;
        referer?: string;
        /** Proxy country for this call (e.g. TW for the overseas host). */
        countryOverride?: string;
        /** Do not feed blocks into the shared circuit breaker (prevents MTOP blocks from pausing/tripping HTML pages). */
        skipBreaker?: boolean;
    }): Promise<DataSourceResult<T>> {
        if (!params.skipBreaker) {
            await this.circuitBreaker.waitForGate();
        }
        if (this.circuitBreaker.isTripped()) {
            return {
                ok: false,
                blocked: true,
                errorReason: 'Circuit breaker tripped due to repeated anti-bot blocks',
            };
        }

        const domain: H5Domain =
            params.host ?? (params.platform === 'tmall' ? 'h5api.m.tmall.com' : 'h5api.m.taobao.com');
        const version = params.version ?? '1.0';
        const compactData = serializeCompactMtopData(params.data);
        const maxAttempts = Math.max(1, params.maxAttempts ?? this.maxRetries);

        let sessionId = this.activeSessionId;
        let firstBlockReason: string | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (!params.skipBreaker) {
                await this.circuitBreaker.waitForGate();
            }
            if (this.circuitBreaker.isTripped()) {
                return {
                    ok: false,
                    blocked: true,
                    errorReason: 'Circuit breaker tripped due to repeated anti-bot blocks',
                };
            }

            await this.politeDelay();
            const jar = this.getTokenJar(domain, sessionId);

            if (this.enableSessionWarmup && !jar.warmedUp && (!this.customFetch || this.forceWarmupWithCustomFetch)) {
                await this.warmUpSession(domain, sessionId);
            }

            // Up to 2 token handshake passes per attempt (pass 1 seeds `_m_h5_tk` if missing/expired, pass 2 signs with the fresh token)
            for (let tokenPass = 0; tokenPass < 2; tokenPass++) {
                const t = String(Date.now());
                const sign = computeMtopSign(jar.token, t, compactData, H5_APP_KEY);

                const query = new URLSearchParams({
                    jsv: '2.7.2',
                    appKey: H5_APP_KEY,
                    t,
                    sign,
                    api: params.api,
                    v: version,
                    type: 'json',
                    dataType: 'json',
                    ...(params.extraParams ?? {}),
                    data: compactData,
                });

                const endpointUrl = `https://${domain}/h5/${params.api.toLowerCase()}/${version}/?${query.toString()}`;
                const referer =
                    params.referer ??
                    (params.platform === 'tmall' ? 'https://detail.m.tmall.com/' : 'https://h5.m.taobao.com/');

                const headers: Record<string, string> = {
                    Accept: 'application/json, text/plain, */*',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
                    Referer: referer,
                    Origin: referer.replace(/\/$/, ''),
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-site',
                    'User-Agent':
                        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
                };

                const cookieHeader = buildCookieHeader(jar, this.userCookie);
                if (cookieHeader) {
                    headers.Cookie = cookieHeader;
                }

                try {
                    const res = await this.executeHttpGet(
                        endpointUrl,
                        headers,
                        sessionId,
                        true,
                        undefined,
                        jar,
                        params.countryOverride,
                    );
                    updateTokenJarFromSetCookieHeaders(jar, res.headers['set-cookie']);

                    // Strip JSONP wrapper if returned despite type=json
                    let jsonText = res.body.trim();
                    const jsonpMatch = jsonText.match(/^[a-zA-Z0-9_$]+\(([\s\S]*)\)\s*;?$/);
                    if (jsonpMatch) {
                        jsonText = jsonpMatch[1]!;
                    }

                    let parsed: { ret?: string[]; data?: T } | null = null;
                    try {
                        parsed = JSON.parse(jsonText) as { ret?: string[]; data?: T };
                    } catch {
                        parsed = null;
                    }

                    const check = isBlockOrCaptchaResponse(res.statusCode, res.body, parsed?.ret);

                    if (check.tokenExpired && tokenPass === 0) {
                        // First pass received fresh _m_h5_tk cookie; immediately retry pass 2 with updated token
                        continue;
                    }

                    if (check.blocked) {
                        firstBlockReason ??= check.reason ?? 'Blocked by H5 API';
                        if (params.skipBreaker) {
                            this.mtopFastFailBlocks += 1;
                        } else {
                            await this.circuitBreaker.recordBlock(check.reason ?? 'Blocked by H5 API');
                        }
                        break; // Break out of tokenPass loop to retire session, backoff, and retry
                    }

                    if (parsed && Array.isArray(parsed.ret)) {
                        const retStr = parsed.ret.join(' | ');
                        if (retStr.includes('SUCCESS')) {
                            this.circuitBreaker.recordSuccess();
                            return {
                                ok: true,
                                data: parsed.data,
                            };
                        }

                        if (
                            !retStr.includes('FAIL_SYS_API_NOT_FOUND') &&
                            (retStr.includes('ITEM_NOT_FOUND') ||
                            retStr.includes('FAIL_BIZ_ITEM_NOT_FOUND') ||
                            retStr.includes('下架') ||
                            retStr.includes('不存在'))
                        ) {
                            this.circuitBreaker.recordSuccess();
                            return {
                                ok: false,
                                notFound: true,
                                errorReason: `Item not found or delisted (${retStr})`,
                            };
                        }
                    }

                    // Unexpected payload or unrecovered token expiration
                    if (attempt === maxAttempts) {
                        return {
                            ok: false,
                            errorReason: parsed?.ret?.join(' | ') || `Unexpected H5 API response (HTTP ${res.statusCode})`,
                        };
                    }
                    break;
                } catch (err) {
                    const msg = formatErrorMessage(err);
                    if (attempt === maxAttempts) {
                        return {
                            ok: false,
                            errorReason: `Network error calling ${params.api}: ${msg}`,
                        };
                    }
                    break;
                }
            }

            // Retire blocked session in SessionPool, rotate country & session ID, and exponential backoff before next attempt
            sessionId = this.retireSession(sessionId, firstBlockReason ?? 'RGV587_ERROR');
            if (attempt === maxAttempts) break;
            const backoffMs = this.baseBackoffMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }

        return {
            ok: false,
            blocked: true,
            errorReason:
                firstBlockReason ?? `Blocked or failed after ${maxAttempts} attempt(s) with proxy rotation`,
        };
    }

    /**
     * Fetches an HTML or JSON web page (e.g., world.taobao.com or short link) with automatic
     * block detection, session retirement & proxy rotation, exponential backoff (up to 3 retries), and circuit breaker.
     */
    public async fetchPage(
        url: string,
        options?: { referer?: string; mobileUa?: boolean; followRedirect?: boolean; urlType?: DebugProbeUrlType },
    ): Promise<DataSourceResult<{ body: string; finalUrl: string; statusCode: number }>> {
        await this.circuitBreaker.waitForGate();
        if (this.circuitBreaker.isTripped()) {
            return {
                ok: false,
                blocked: true,
                errorReason: 'Circuit breaker tripped due to repeated anti-bot blocks',
            };
        }

        let sessionId = this.activeSessionId;
        let firstBlockReason: string | undefined;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            await this.circuitBreaker.waitForGate();
            if (this.circuitBreaker.isTripped()) {
                return {
                    ok: false,
                    blocked: true,
                    errorReason: 'Circuit breaker tripped due to repeated anti-bot blocks',
                };
            }

            await this.politeDelay();
            const jar = this.getTokenJar('h5api.m.taobao.com', sessionId);

            const headers: Record<string, string> = {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
                Referer: options?.referer ?? 'https://world.taobao.com/',
                ...REAL_BROWSER_HEADERS,
                'User-Agent': options?.mobileUa
                    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
                    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            };

            const cookieHeader = buildCookieHeader(jar, this.userCookie);
            if (cookieHeader) {
                headers.Cookie = cookieHeader;
            }

            try {
                const res = await this.executeHttpGet(
                    url,
                    headers,
                    sessionId,
                    options?.followRedirect ?? true,
                    options?.urlType,
                    jar,
                );
                updateTokenJarFromSetCookieHeaders(jar, res.headers['set-cookie']);

                const finalUrl =
                    res.redirectUrls && res.redirectUrls.length > 0
                        ? res.redirectUrls[res.redirectUrls.length - 1]!
                        : (typeof res.headers.location === 'string' ? res.headers.location : url);

                if (res.statusCode === 404 || finalUrl.includes('taglist-404-301')) {
                    this.circuitBreaker.recordSuccess();
                    return {
                        ok: false,
                        notFound: true,
                        errorReason: `Page returned HTTP 404 (${url})`,
                    };
                }

                const check = isBlockOrCaptchaResponse(res.statusCode, res.body);
                const isLoginRedirect =
                    finalUrl.includes('login.taobao.com') ||
                    finalUrl.includes('login.tmall.com') ||
                    res.body.includes('window.location.href="https://login.taobao.com');

                if (check.blocked || isLoginRedirect) {
                    const reason =
                        check.reason ?? (isLoginRedirect ? 'Redirected to Taobao/Tmall login wall' : 'Blocked');
                    firstBlockReason ??= reason;
                    await this.circuitBreaker.recordBlock(reason);
                } else if (res.statusCode >= 200 && res.statusCode < 400) {
                    this.circuitBreaker.recordSuccess();
                    return {
                        ok: true,
                        data: {
                            body: res.body,
                            finalUrl,
                            statusCode: res.statusCode,
                        },
                    };
                } else if (attempt === this.maxRetries) {
                    return {
                        ok: false,
                        errorReason: `HTTP ${res.statusCode} when fetching ${url}`,
                    };
                }
            } catch (err) {
                const msg = formatErrorMessage(err);
                if (attempt === this.maxRetries) {
                    return {
                        ok: false,
                        errorReason: `Network error fetching ${url}: ${msg}`,
                    };
                }
            }

            sessionId = this.retireSession(sessionId, firstBlockReason ?? 'HTML block or network error');
            const backoffMs = this.baseBackoffMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }

        return {
            ok: false,
            blocked: true,
            errorReason:
                firstBlockReason ?? `Blocked or failed after ${this.maxRetries} retries fetching ${url}`,
        };
    }

    /**
     * Resolves Taobao short links (`tb.cn`, `m.tb.cn`, `e.tb.cn`, `s.tb.cn`)
     * by checking both HTTP Location redirects and embedded JS `var url = '...'` inside m.tb.cn/e.tb.cn landing pages.
     */
    public async resolveShortLink(shortUrl: string): Promise<DataSourceResult<string>> {
        const res = await this.fetchPage(shortUrl, { mobileUa: true, followRedirect: true, urlType: 'short_link' });
        if (!res.ok || !res.data) {
            return {
                ok: false,
                blocked: res.blocked,
                errorReason: res.errorReason ?? `Failed to resolve short link: ${shortUrl}`,
            };
        }

        const { body, finalUrl } = res.data;

        // If HTTP redirect already resolved to a full taobao/tmall URL, return it
        if (finalUrl && finalUrl !== shortUrl && !finalUrl.includes('tb.cn')) {
            return { ok: true, data: finalUrl };
        }

        // Parse embedded JS target URL inside m.tb.cn / e.tb.cn HTML response
        const urlVarMatch =
            body.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/i) ||
            body.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i) ||
            body.match(/["']url["']\s*:\s*["'](https?:\/\/[^"']+)["']/i);

        if (urlVarMatch?.[1]) {
            const extracted = urlVarMatch[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/').trim();
            return { ok: true, data: extracted };
        }

        // Look for world.taobao.com item slug inside the short-link page
        const worldSlugMatch = body.match(/https?:\/\/world\.taobao\.com\/(?:lang\/[a-z-]+\/)?item\/([A-Za-z0-9+/=_-]+)\.htm/i);
        if (worldSlugMatch?.[0]) {
            return { ok: true, data: worldSlugMatch[0] };
        }

        // Look for item id inside the short-link page
        const idMatch = body.match(/[?&]id=(\d{5,20})/) || body.match(/\/i(\d{5,20})\.htm/i);
        if (idMatch?.[1]) {
            return { ok: true, data: `https://item.taobao.com/item.htm?id=${idMatch[1]}` };
        }

        return {
            ok: false,
            errorReason: `Could not extract destination URL from short link ${shortUrl}`,
        };
    }
}
