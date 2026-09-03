import { channels, salesMonthly, skuParams, skus, spus, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import type { TestDb } from "./db";

/**
 * D58/D59 分层 / 权责 / 试点 / 周期主数据共用种子（W2 域 F 各测试共用，避免每个文件各造一套口径）。
 *
 * 近 6 月（2026-01..06）天猫单渠道、逐月恒定销量（CV=0 → XYZ=X）：
 *   S 级 600/月（60%） · A 级 250/月（25%） · B 级 100/月（10%） · C 级 50/月（5%） · NEW 无销量（恒 C，XYZ 样本不足）
 * 累计占比：S 前 0% <50 → S；A 前 60% <80 → A；B 前 85% <95 → B；C 前 95% → C。
 * 周期主数据：S 加工 30 + 在途 15（已知）；B 只有加工（在途缺）；A / C / NEW 无 sku_params。
 * 预期权责：S 供应链直出；A、B 联合评审（交期缺失）；C、NEW 运营按需。
 */
export const SEED_MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"] as const;

export interface TierWorld {
  admin: SessionUser;
  pmc: SessionUser;
  ops: SessionUser;
  purchasing: SessionUser;
  warehouse: SessionUser;
  /** 受限运营：只有拼多多渠道范围 */
  opsPdd: SessionUser;
  tmall: number;
  pdd: number;
  sku: { S: number; A: number; B: number; C: number; NEW: number };
}

export async function seedTierWorld(db: TestDb): Promise<TierWorld> {
  const mkUser = async (name: string, roles: string[], channelScope?: number[] | null): Promise<SessionUser> => {
    const [u] = await db.insert(users).values({ name, roles, isApprover: false }).returning();
    return { id: u.id, name: u.name, roles, isApprover: false, ...(channelScope !== undefined ? { channelScope } : {}) };
  };
  const admin = await mkUser("管理员", ["admin"], null);
  const pmc = await mkUser("生产计划", ["pmc"], null);
  const ops = await mkUser("运营", ["ops"], null);
  const purchasing = await mkUser("采购", ["purchasing"], null);
  const warehouse = await mkUser("仓管", ["warehouse"], null);

  const [tm] = await db.insert(channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
  const [pd] = await db.insert(channels).values({ code: "pdd", name: "拼多多", kind: "platform" }).returning();
  const opsPdd = await mkUser("拼多多运营", ["ops"], [pd.id]);

  const [spu] = await db.insert(spus).values({ code: "SPU-TIER", nameCn: "分层测试" }).returning();
  const mkSku = async (code: string, name: string): Promise<number> => {
    const [s] = await db.insert(skus).values({ code, name, spuId: spu.id, skuType: "finished", baseUom: "支", active: true }).returning();
    return s.id;
  };
  const S = await mkSku("TIER-S", "核心品 S");
  const A = await mkSku("TIER-A", "主力品 A");
  const B = await mkSku("TIER-B", "常规品 B");
  const C = await mkSku("TIER-C", "长尾品 C");
  const NEW = await mkSku("TIER-NEW", "新品无销量");

  const monthly: Record<number, number> = { [S]: 600, [A]: 250, [B]: 100, [C]: 50 };
  await db.insert(salesMonthly).values(
    Object.entries(monthly).flatMap(([skuId, qty]) => SEED_MONTHS.map((ym) => ({ skuId: Number(skuId), channelId: tm.id, yearMonth: ym, qty: String(qty) }))),
  );
  await db.insert(skuParams).values([
    { skuId: S, normalLeadDays: 30, logisticsLeadDays: 15 },
    { skuId: B, normalLeadDays: 30, logisticsLeadDays: null },
  ]);

  return { admin, pmc, ops, purchasing, warehouse, opsPdd, tmall: tm.id, pdd: pd.id, sku: { S, A, B, C, NEW } };
}
