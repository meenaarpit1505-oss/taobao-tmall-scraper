import type { AgentLinksMap, AgentName, PlatformType } from './types.js';

function resolveCanonicalItemUrl(itemId: string, itemUrl?: string, platform: PlatformType = 'taobao'): string {
    const cleanId = String(itemId).trim();
    if (itemUrl && itemUrl.trim().startsWith('http')) {
        return itemUrl.trim();
    }
    return platform === 'tmall'
        ? `https://detail.tmall.com/item.htm?id=${cleanId}`
        : `https://item.taobao.com/item.htm?id=${cleanId}`;
}

/**
 * Generates a Superbuy product purchase link from itemId / itemUrl.
 */
export function buildSuperbuyLink(itemId: string, itemUrl?: string, platform: PlatformType = 'taobao'): string {
    const canonical = resolveCanonicalItemUrl(itemId, itemUrl, platform);
    return `https://www.superbuy.com/en/page/buy/?nTag=Home-search&from=search-input&url=${encodeURIComponent(canonical)}`;
}

/**
 * Generates a CSSBuy product purchase link from itemId / itemUrl.
 */
export function buildCssbuyLink(itemId: string, _itemUrl?: string, _platform: PlatformType = 'taobao'): string {
    const cleanId = encodeURIComponent(String(itemId).trim());
    return `https://www.cssbuy.com/item-${cleanId}.html`;
}

/**
 * Generates a Sugargoo product purchase link from itemId / itemUrl.
 */
export function buildSugargooLink(itemId: string, itemUrl?: string, platform: PlatformType = 'taobao'): string {
    const canonical = resolveCanonicalItemUrl(itemId, itemUrl, platform);
    return `https://www.sugargoo.com/#/home/productDetail?productLink=${encodeURIComponent(canonical)}`;
}

/**
 * Generates a CNFans product purchase link from itemId / itemUrl.
 */
export function buildCnfansLink(itemId: string, _itemUrl?: string, _platform: PlatformType = 'taobao'): string {
    const cleanId = encodeURIComponent(String(itemId).trim());
    return `https://cnfans.com/product/?shop_type=taobao&id=${cleanId}`;
}

/**
 * Generates a Hoobuy product purchase link from itemId / itemUrl.
 */
export function buildHoobuyLink(itemId: string, _itemUrl?: string, _platform: PlatformType = 'taobao'): string {
    const cleanId = encodeURIComponent(String(itemId).trim());
    return `https://hoobuy.com/product/1/${cleanId}`;
}

const AGENT_BUILDERS: Record<
    AgentName,
    (itemId: string, itemUrl?: string, platform?: PlatformType) => string
> = {
    superbuy: buildSuperbuyLink,
    cssbuy: buildCssbuyLink,
    sugargoo: buildSugargooLink,
    cnfans: buildCnfansLink,
    hoobuy: buildHoobuyLink,
};

/**
 * Builds the requested shopping-agent links map for a given item.
 */
export function buildAgentLinks(params: {
    itemId: string;
    url?: string;
    platform?: PlatformType;
    selectedAgents?: AgentName[];
}): AgentLinksMap {
    const cleanId = String(params.itemId ?? '').trim();
    if (!cleanId) return {};

    const agents = params.selectedAgents ?? ['superbuy', 'cssbuy', 'sugargoo', 'cnfans', 'hoobuy'];
    const result: AgentLinksMap = {};

    for (const agent of agents) {
        const builder = AGENT_BUILDERS[agent];
        if (builder) {
            result[agent] = builder(cleanId, params.url, params.platform ?? 'taobao');
        }
    }

    return result;
}
