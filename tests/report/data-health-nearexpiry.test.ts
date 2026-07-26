import { beforeEach, describe, expect, it } from "vitest";
import { skus, spus } from "@/db/schema";
import { getDataHealth } from "@/server/modules/report/data-health";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * 临期阈值告警的**预算**护栏。
 *
 * 曾经这条告警在真实数据上命中 391/391——100% 命中率意味着零区分度。
 * 根因是把两件性质不同的事混在一起报：
 *   ① 有人显式把阈值设得比渠道口径松 → 真的逐 SKU 配置错误
 *   ② 从没设过、吃全局缺省 90 天     → **一个**设定决策，不是 N 个问题
 * 实测 0/1026 个成品显式设过阈值，所以那 391 条讲的全是同一件事，
 * 却摆出 20 条逐 SKU 样例，让人以为有几百件事要办。
 *
 * 这些用例钉住拆分后的行为：缺省态只出一句话且**不给逐 SKU 清单**，
 * 显式设错才逐条列。
 */
describe("主数据健康度：临期阈值告警不得变成 100% 命中的噪音", () => {
  let db: TestDb;

  const mkSku = async (
    code: string,
    shelfLifeDays: number | null,
    nearExpiryDays: number | null,
  ): Promise<void> => {
    const [spu] = await db.insert(spus).values({ code: `SPU-${code}`, nameCn: code }).returning();
    await db.insert(skus).values({
      spuId: spu.id, code, name: code, skuType: "finished", baseUom: "个",
      active: true, shelfLifeDays, nearExpiryDays,
    });
  };
  const warn = async (key: string) =>
    (await getDataHealth({ pageSize: 1 }, db)).structural.find((w) => w.key === key);

  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  it("**全都吃缺省时只出一句话，且不给逐 SKU 清单**", async () => {
    for (const c of ["A1", "A2", "A3"]) await mkSku(c, 1095, null);

    const w = await warn("near_expiry_using_default");
    expect(w).toBeDefined();
    expect(w!.count).toBe(3);
    expect(w!.samples).toEqual([]); // 给清单就是假装有 3 件事要办，实际只有 1 件
    expect(w!.impact).toContain("一个设定决策");
    // 没人设错，就不该出「已设定低于渠道口径」那条
    expect(await warn("near_expiry_below_channel")).toBeUndefined();
  });

  it("**显式设得比渠道口径松 → 逐条列出**（这才是真的逐 SKU 问题）", async () => {
    await mkSku("SET-LOW", 1095, 60); // 渠道口径 max(219,100)=219，设了 60
    await mkSku("SET-OK", 1095, 300); // 高于渠道口径，不该报

    const w = await warn("near_expiry_below_channel");
    expect(w).toBeDefined();
    expect(w!.count).toBe(1);
    expect(w!.samples[0]).toContain("SET-LOW");
    expect(w!.samples[0]).toContain("60");
    expect(w!.samples.join()).not.toContain("SET-OK");
  });

  it("两类并存时各归各条，不互相污染计数", async () => {
    await mkSku("SET-LOW", 1095, 60);
    await mkSku("DEFAULT-1", 1095, null);
    await mkSku("DEFAULT-2", 1095, null);

    expect((await warn("near_expiry_below_channel"))!.count).toBe(1);
    expect((await warn("near_expiry_using_default"))!.count).toBe(2);
  });

  it("没有保质期的成品不参与临期口径判定（无从比较）", async () => {
    await mkSku("NO-SHELF", null, null);

    expect(await warn("near_expiry_using_default")).toBeUndefined();
    expect(await warn("near_expiry_below_channel")).toBeUndefined();
  });

  it("零命中即零 DOM：全部设置妥当时两条都不出现", async () => {
    await mkSku("GOOD-1", 1095, 250);
    await mkSku("GOOD-2", 730, 200);

    const all = (await getDataHealth({ pageSize: 1 }, db)).structural.map((w) => w.key);
    expect(all).not.toContain("near_expiry_using_default");
    expect(all).not.toContain("near_expiry_below_channel");
  });
});
