/**
 * D62 店铺维观察内容的渠道范围裁剪（安全审计 S3）。
 *
 * 背景：`src/lib/route-access.ts` 把 `/alerts` 与 `/inventory/alerts` 标成 `channel_scoped`，
 * 驾驶舱也已按 `resolveChannelScope(...).forced` 跳过跨店铺观察块；但 `/api/alerts` 与
 * `/api/report/sales-spike` 没有任何渠道过滤，而爆单预警的标题/详情/去重键里直接写着
 * 店铺名与平台 SKU——受限渠道账号照样读得到别人家店的爆单。本模块补上那道闸。
 *
 * 口径（与 core/data-scope 同一权威，不自建判定）：
 * - 不限用户（admin 或无范围记录，`scope.channelIds === null`）：原样返回，逐字等价于改造前；
 * - 受限用户：店铺 → 渠道映射走 `channel-observation.loadShopChannelMap`（aliases，唯一权威）；
 *   **一行只要有任何一个店铺落在范围外或压根没映射，整行剔除**——爆单行的件数是跨店铺汇总的，
 *   只要混进范围外店铺，留下来就是把别人家的数字讲给他听；「未映射 = 不确定」同样按剔除处理
 *   （不确定不是可见的理由，这与 filterShopRowsByChannelScope 的既有取舍一致）。
 */
import { inArray, notInArray, or, type SQL } from "drizzle-orm";
import { systemAlerts } from "@/db/schema";
import type { ChannelScope } from "@/server/core/data-scope";
import { loadShopChannelMap, type ShopChannelMap } from "@/server/modules/report/channel-observation";
import type { AnyDb } from "@/server/core/svc";
import type { SalesSpikeReadModel, SpikeHit } from "@/server/modules/report/sales-spike";
import { spikeCoverage } from "@/server/modules/report/sales-spike";

/** 内容按店铺归属的告警类别：受限渠道账号只看得到能归到自己渠道的行 */
export const CHANNEL_SCOPED_ALERT_CATEGORIES = ["sales_spike"] as const;

/** 多店铺连接符（sales-spike 的 shopName 用顿号连接，见 report/sales-spike.ts） */
const SHOP_JOIN = "、";

export interface AlertShopFields {
  category: string;
  dedupeKey?: string | null;
  refKey?: string | null;
  detail?: string | null;
}

/**
 * 从告警行还原店铺名。
 * - 未映射平台 SKU 行：`dedupe_key = sales_spike:platform:<店铺>|<平台SKU>`（refKey 同尾段）；
 * - 已映射 SKU 行：去重键里只有 skuId，店铺只在 detail 的「店铺 X、Y；」段里。
 * 还原不出 → null = **不可归属**，受限用户一律不下发（不猜、不放行）。
 */
export function alertShopNames(row: AlertShopFields): string[] | null {
  const platformPrefix = `${row.category}:platform:`;
  const key = row.dedupeKey ?? "";
  if (key.startsWith(platformPrefix)) {
    const rest = key.slice(platformPrefix.length);
    const cut = rest.lastIndexOf("|");
    const shop = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
    return shop ? [shop] : null;
  }
  const m = /店铺\s*([^；;]+)/.exec(row.detail ?? "");
  if (m) {
    const shops = m[1].split(SHOP_JOIN).map((s) => s.trim()).filter(Boolean);
    if (shops.length) return shops;
  }
  return null;
}

/** 行内全部店铺都落在允许渠道里才算在范围内；任一未映射/范围外 → false */
function allShopsInScope(shops: string[] | null, map: ShopChannelMap, allowed: Set<number>): boolean {
  if (!shops || !shops.length) return false;
  return shops.every((s) => {
    const id = map.byShop[s];
    return id != null && allowed.has(id);
  });
}

/**
 * 受限用户可见的「店铺维告警」id 集合（只扫 CHANNEL_SCOPED_ALERT_CATEGORIES 那几类，
 * 其余类别不受本闸影响）。调用方把结果交给 channelScopedAlertCondition 下推 SQL，
 * 这样 total 与分页仍然是同一口径（先裁剪再分页，不是分页后再删行）。
 */
export async function visibleChannelScopedAlertIds(db: AnyDb, scope: ChannelScope): Promise<number[]> {
  if (scope.channelIds === null) return [];
  const rows: { id: number; category: string; dedupeKey: string | null; refKey: string | null; detail: string | null }[] = await db
    .select({
      id: systemAlerts.id, category: systemAlerts.category, dedupeKey: systemAlerts.dedupeKey,
      refKey: systemAlerts.refKey, detail: systemAlerts.detail,
    })
    .from(systemAlerts)
    .where(inArray(systemAlerts.category, [...CHANNEL_SCOPED_ALERT_CATEGORIES]));
  if (!rows.length) return [];
  const shopsByRow = new Map<number, string[] | null>(rows.map((r) => [r.id, alertShopNames(r)]));
  const allShops = [...new Set([...shopsByRow.values()].flatMap((s) => s ?? []))];
  const map = await loadShopChannelMap(db, allShops);
  const allowed = new Set(scope.channelIds);
  return rows.filter((r) => allShopsInScope(shopsByRow.get(r.id) ?? null, map, allowed)).map((r) => r.id);
}

/**
 * 列表 SQL 条件：非店铺维类别照常可见；店铺维类别只保留 visibleIds。
 * visibleIds 为空 → 直接排除全部店铺维类别（不写 `id IN ()` 这种空集合条件）。
 */
export function channelScopedAlertCondition(visibleIds: readonly number[]): SQL {
  const others = notInArray(systemAlerts.category, [...CHANNEL_SCOPED_ALERT_CATEGORIES]);
  if (!visibleIds.length) return others;
  return or(others, inArray(systemAlerts.id, [...visibleIds])) as SQL;
}

/** 爆单命中行的店铺（已映射行的 shopName 是顿号连接的多店铺） */
export function spikeHitShops(hit: SpikeHit): string[] {
  return String(hit.shopName ?? "").split(SHOP_JOIN).map((s) => s.trim()).filter(Boolean);
}

/**
 * 爆单读模型按渠道范围裁剪：受限用户只留下全部店铺都在自己渠道里的命中行。
 * coverage/params 等汇总不含店铺明细，原样保留；limitations 追加一句说明，
 * 免得读者把"少了很多行"误读成"最近没爆单"。
 */
export async function scopeSalesSpikeModel(
  db: AnyDb,
  model: SalesSpikeReadModel,
  scope: ChannelScope,
): Promise<SalesSpikeReadModel> {
  if (scope.channelIds === null) return model;
  const hits = [...model.hits, ...model.unmappedHits];
  const map = await loadShopChannelMap(db, [...new Set([...hits.flatMap((h) => spikeHitShops(h)), ...model.evaluations.flatMap((e) => e.shopNames)])]);
  const allowed = new Set(scope.channelIds);
  const keep = (h: SpikeHit) => allShopsInScope(spikeHitShops(h), map, allowed);
  const scopedHits = model.hits.filter(keep);
  const evaluations = model.evaluations.filter((e) => allShopsInScope(e.shopNames, map, allowed));
  const coverage = spikeCoverage(evaluations, scopedHits);
  return {
    ...model,
    evaluations, coverage,
    state: coverage.evaluatedItems === 0 ? "insufficient" : coverage.incompleteItems > 0 ? "partial" : "ready",
    hits: scopedHits,
    unmappedHits: model.unmappedHits.filter(keep),
    limitations: [...model.limitations, "已按你的渠道范围裁剪（D62）：跨店铺汇总或店铺未映射到渠道的命中行不下发"],
  };
}
