/**
 * Shared registry mapping numeric Taobao/Tmall itemIds to world.taobao.com encrypted itemIdStr slugs
 * (and vice-versa), plus known Tmall brand subdomain -> shopId mappings.
 *
 * Pre-seeded with verified live Taobao/Tmall items from world.taobao.com and dynamically updated
 * during keyword search, category browsing, and shop catalogue scraping.
 */

export interface SeedItemEntry {
    slug: string;
    shopId?: string;
    platform?: 'taobao' | 'tmall';
}

const INITIAL_ITEM_SLUGS: Record<string, SeedItemEntry> = {
    '1079352038299': { slug: 'RjRZL1NqR2pVTkxHOTFNTUIvZU8wZz09', shopId: '503709453', platform: 'tmall' },
    '1019865884154': { slug: 'bVhKbkxURm1FZlFDV2lWTHdBTk1GQT09', shopId: '286954087', platform: 'tmall' },
    '1069464409891': { slug: 'aUUyNGo3S09hY0djNHBZcnkrMmllUT09', shopId: '481080356', platform: 'taobao' },
    '846190791238': { slug: 'Y3Z0TkZ6Q21pNzJlRkhDKzRhMUdMQT09', shopId: '203075414', platform: 'tmall' },
    '765833709683': { slug: 'M3hoaXBUL3N4L2VnVUJncG9JWFphZz09', shopId: '467290190', platform: 'taobao' },
    '981046147710': { slug: 'RG9aSWRSdXI1NkQzQmcvOFVWUWdEdz09', shopId: '520691794', platform: 'tmall' },
    '1009384322956': { slug: 'c05lYUsvUDJML3N5MzJSdHJsNlpjQT09', shopId: '436010517', platform: 'tmall' },
    '1062229607417': { slug: 'T0RndW50azBpZ1p3b2lKS2pLS2hKUT09', shopId: '112677360', platform: 'tmall' },
    '953082139000': { slug: 'b3BLZVp1WFlkdHl3aitXQTNMRHYxUT09', shopId: '436010517', platform: 'tmall' },
    '1043657581228': { slug: 'bkVMdy9ROTl5SlA3NlF4STJIc2JBZz09', shopId: '61880113', platform: 'tmall' },
    '803402121912': { slug: 'ditqV2U2dzQ0eUF6UXZiK1Urd2tTZz09', shopId: '546876235', platform: 'tmall' },
    '1088844348801': { slug: 'WHh5aE9laHdTdEszRFVWZm1YUkp4QT09', shopId: '245320730', platform: 'taobao' },
    '990390136940': { slug: 'bDU2K2wzVnFhZittT1duck9sRW1Idz09', shopId: '130322887', platform: 'taobao' },
    '828861769635': { slug: 'SG8zRWQ3TVNLZ0tmMHRJcmZOS05jZz09', shopId: '70186190', platform: 'taobao' },
    '1091822136156': { slug: 'MU1IaVJKZWN6TDFqSk13aEd2bmNFZz09', shopId: '114424207', platform: 'taobao' },
    '1090460480215': { slug: 'dnNaVUpxT3l2aTZobTl4QlhsVUZNUT09', shopId: '128593474', platform: 'taobao' },
    '1079170863181': { slug: 'MjE2U0cvREI5SktsT1dTay9HVVl0dz09', shopId: '65218980', platform: 'tmall' },
    '1066760406588': { slug: 'bmRxUWtkbVZibElTVWE0VmNiQVdEZz09', shopId: '65218980', platform: 'tmall' },
    '1046431225694': { slug: 'a0RuM3RLUHBYeFV0aVBjclRtd0xzUT09', shopId: '60790435', platform: 'tmall' },
    '966460859339': { slug: 'b2Urd3ZTd2RHSktxcmpKdXlua29qdz09', shopId: '60036677', platform: 'tmall' },
    '539322699324': { slug: 'Rm1YWnc2U05hcDlHRUZzclloeVRzdz09', shopId: '60036677', platform: 'tmall' },
    '981525773506': { slug: 'S0NIMzFSVG1nN1Q0U1dOaXk1VVJGZz09', shopId: '67095450', platform: 'tmall' },
    '778412379986': { slug: 'NHlKQ0loS2R3VTdkUlNNcXBPYTNKQT09', shopId: '67095450', platform: 'tmall' },
    '521031921743': { slug: 'Z1FOM0FVVlpBK1FneS8rNmNKSVpjQT09', shopId: '67095450', platform: 'tmall' },
    '523147854719': { slug: 'VW9zZjU2NGlBNFRtSEdsTE9BKzl1Zz09', shopId: '67095450', platform: 'tmall' },
    '525146431223': { slug: 'ak9LSTQ1aEc2YUZIb3F3RnA5bzU3QT09', shopId: '67095450', platform: 'tmall' },
    '984586032930': { slug: 'QXAzRTB5OVJtOWR5Y0hvYWVSREZVdz09', shopId: '239494884', platform: 'taobao' },
    '1084447292668': { slug: 'a2Z5aW5zV0N2Si8wcEhpM2JNakwvQT09', shopId: '556789434', platform: 'taobao' },
    '1079469092489': { slug: 'Mnp6eHBIMytZbHBmRFQrQk5TWkZ3QT09', shopId: '108239702', platform: 'taobao' },
    '1008918228623': { slug: 'Zm5jWnNxS1JqS3VkMmgzR3dEUTZOZz09', shopId: '452107751', platform: 'tmall' },
    '1074835457451': { slug: 'bXFLL1lSTkxycnNjeFIxQ2ZwZ0szdz09', shopId: '350369320', platform: 'tmall' },
    '1072996751613': { slug: 'MEw4VDlvNDNSUU41ZXlJMVFKUnVRUT09', shopId: '452107751', platform: 'tmall' },
    '1091207477219': { slug: 'ZjgveGExSXZlb0N0L3BsWnF2cjV0QT09', shopId: '273165416', platform: 'tmall' },
    '1091318850367': { slug: 'UUhsMk12N0JsZUlsK3E3QnY5QTVLZz09', shopId: '503709453', platform: 'tmall' },
    '1065450909889': { slug: 'dnF2dTlvT0k0SnVQTnlXTy93NzBOdz09', shopId: '124947219', platform: 'taobao' },
    '1080059250991': { slug: 'aWpTY1BTQjcvN1BObldBYmZrQy85UT09', shopId: '338365384', platform: 'tmall' },
    '1022951227321': { slug: 'ZTF5RSszQkJ5Y3hKTWgraVVycmFhdz09', shopId: '288490934', platform: 'taobao' },
    '1085650622422': { slug: 'NGFxaE11VEJWUk9Lb3VuYjlkVkNMZz09', shopId: '461106964', platform: 'taobao' },
    '976921310639': { slug: 'bldNYkJkTmViYk1Mb3pvMGY4YTJOQT09', shopId: '514957394', platform: 'taobao' },
    '1078907312106': { slug: 'SnA2dmxGcWpIZXRWLzJoZ0tCQjdXQT09', shopId: '72104903', platform: 'tmall' },
    '582890145005': { slug: 'SmFWQlNHc2lpUGEzZHVBTlJ6eS9RQT09', shopId: '67095450', platform: 'tmall' },
    '1042322599854': { slug: 'U0NqNTVKSG5xcU11dXBWN0RCd3U0Zz09', shopId: '551215426', platform: 'tmall' },
    '1082325834322': { slug: 'VHF0S0ZxcStZOE9iajV6NkpOOHA2UT09', shopId: '108337685', platform: 'taobao' },
    '1071758771428': { slug: 'UERiS3p6T3I4c3JNTytIbFVDcm1vdz09', shopId: '274251190', platform: 'taobao' },
};

const KNOWN_SHOP_SUBDOMAINS: Record<string, string> = {
    ugreen: '67095450',
    lulian: '67095450',
    fila: '65218980',
    anta: '60790435',
    xtep: '60036677',
    logitech: '61880113',
    luoji: '61880113',
    torras: '72104903',
    tulasi: '72104903',
    lenovo: '203075414',
    lianxiang: '203075414',
    aigo: '503709453',
    songmont: '338365384',
    bablov: '452107751',
    chakolab: '273165416',
    aula: '112677360',
    langzhu: '112677360',
    eweadn: '436010517',
};

const itemIdToSlug = new Map<string, string>();
const slugToItemId = new Map<string, string>();
const itemIdToShopId = new Map<string, string>();

for (const [itemId, entry] of Object.entries(INITIAL_ITEM_SLUGS)) {
    itemIdToSlug.set(itemId, entry.slug);
    slugToItemId.set(entry.slug, itemId);
    if (entry.shopId) {
        itemIdToShopId.set(itemId, entry.shopId);
    }
}

export function registerItemSlug(itemId: string, itemIdStr: string, shopId?: string): void {
    const cleanId = String(itemId ?? '').trim();
    const cleanSlug = String(itemIdStr ?? '').trim();
    if (!cleanId || !cleanSlug) return;
    if (/^\d{5,20}$/.test(cleanId) && !/^\d+$/.test(cleanSlug)) {
        itemIdToSlug.set(cleanId, cleanSlug);
        slugToItemId.set(cleanSlug, cleanId);
    }
    if (shopId && /^\d+$/.test(String(shopId).trim())) {
        itemIdToShopId.set(cleanId, String(shopId).trim());
    }
}

export function getSlugForItemId(itemId: string): string | null {
    const clean = String(itemId ?? '').trim();
    if (!clean) return null;
    if (!/^\d+$/.test(clean) && /^[A-Za-z0-9+/=_-]{8,80}$/.test(clean)) {
        return clean;
    }
    return itemIdToSlug.get(clean) ?? null;
}

export function getItemIdForSlug(slug: string): string | null {
    const clean = String(slug ?? '').trim();
    if (!clean) return null;
    if (/^\d{5,20}$/.test(clean)) return clean;
    return slugToItemId.get(clean) ?? null;
}

export function getShopIdForItemId(itemId: string): string | null {
    return itemIdToShopId.get(String(itemId ?? '').trim()) ?? null;
}

export function resolveKnownShopIdFromDomain(shopDomain?: string): string | null {
    if (!shopDomain) return null;
    const lower = shopDomain.toLowerCase().trim();
    const shopMatch = lower.match(/^shop(\d+)\./i);
    if (shopMatch) return shopMatch[1]!;
    const subMatch = lower.match(/^([a-z0-9-]+)\.(?:tmall|taobao)\./i);
    if (subMatch) {
        const sub = subMatch[1]!;
        if (KNOWN_SHOP_SUBDOMAINS[sub]) return KNOWN_SHOP_SUBDOMAINS[sub]!;
    }
    return null;
}
