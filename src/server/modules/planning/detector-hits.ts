/**
 * 异动侦测命中集合（D59 权责判定输入）。
 *
 * rules/replenish-ownership 需要「该 SKU 是否被异动侦测命中」；侦测的唯一实现是
 * report/detectors.getDetectorAlerts（三条规则 + sys_params 阈值）。本模块只做**翻页汇总**，
 * 不重实现任何判定——分层页、策略固化、试点读模型都从这里取同一份命中集合，避免口径漂移。
 */
import { getDetectorAlerts } from "@/server/modules/report/detectors";
import { type AnyDb } from "@/server/core/svc";

const PAGE_SIZE = 500;

/** 全部命中异动侦测的成品 SKU id（任一规则命中即计） */
export async function loadDetectorHitSkuIds(db: AnyDb): Promise<Set<number>> {
  const out = new Set<number>();
  for (let page = 1; page <= 200; page += 1) {
    const res = await getDetectorAlerts({ page, pageSize: PAGE_SIZE }, db);
    for (const r of res.rows) out.add(r.skuId);
    if (res.rows.length < PAGE_SIZE || page * PAGE_SIZE >= res.total) break;
  }
  return out;
}
