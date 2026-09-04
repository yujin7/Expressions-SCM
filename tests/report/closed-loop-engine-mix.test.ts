/**
 * W2 修复（T6）：闭环准确度不得把两套引擎口径混成一个数还不说。
 *
 * 事故形态：`planning_version_lines` 横跨所有历史版本，而 `planning_versions.engine_version`
 * 在本波从 `time-phased-v2`（账面在库）换成了 `time-phased-v3`（可用在库 = 账面在库扣临期净额）。
 * 一个不分版本的准确度数字于是横跨两套口径：v3 把净需求抬高之后，同样的实际下单量会落进
 * 更靠近 100% 的桶——**准确度看起来变好了，其实只是分母换了算法**。
 * 而这个数字自己的版本串 `/v1` 一动不动，读者无从发现。
 *
 * 现在：总分布仍给，但同时给 `engineMix`（各引擎版本的样本数）与 `byEngineVersion`
 * （逐版本分布），caliber 里明说混了几套；键升到 `/v2`。
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  getSuggestionAccuracy,
  SUGGESTION_ACCURACY_VERSION,
  UNKNOWN_ENGINE_VERSION,
} from "@/server/modules/report/closed-loop";
import { createTestDb, type TestDb } from "../helpers/db";

const NOW = new Date("2026-09-03T03:00:00.000Z");

describe("闭环准确度：引擎口径混用必须披露", () => {
  let db: TestDb;
  let pmc: SessionUser;
  const sku: Record<string, number> = {};

  const envelope = (businessDate: string, horizonDays: number, net: string) => ({
    schemaVersion: "decision-envelope/v1",
    businessDate,
    inputs: { policy: { horizonDays } },
    outputs: { netRequiredBeforeRounding: net },
  });

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [p] = await db.insert(schema.users).values({ name: "计划", roles: ["pmc"] }).returning();
    pmc = { id: p.id, name: p.name, roles: ["pmc"], isApprover: false };
    const [rt] = await db.insert(schema.warehouses).values({ code: "EM-RT", name: "实时仓", kind: "finished" }).returning();
    const [spu] = await db.insert(schema.spus).values({ code: "EM-SPU", nameCn: "引擎口径" }).returning();
    for (const k of ["OLD1", "OLD2", "NEW1"]) {
      const [s] = await db.insert(schema.skus).values({
        code: `EM-${k}`, name: k, spuId: spu.id, baseUom: "件", skuType: "finished",
      }).returning();
      sku[k] = s.id;
    }

    /* 两个捕获版本：一个跑 time-phased-v2（本波之前），一个跑 time-phased-v3（本波之后）。
       两者的净需求分母算法不同（账面在库 vs 可用在库），因此它们的桶分布不在同一把尺子上。 */
    const mkVersion = async (name: string, engineVersion: string, at: string) => {
      const [v] = await db.insert(schema.planningVersions).values({
        name, weekStart: "2026-06-01", engineVersion, parameters: {}, sourceMeta: {},
        lineCount: 2, suggestedCount: 2, suppressedCount: 0,
        digest: name, idempotencyKey: `em-${name}`, createdBy: pmc.id, createdAt: new Date(at),
      }).returning();
      return v.id;
    };
    const vOld = await mkVersion("v-old", "time-phased-v2", "2026-06-01T02:00:00Z");
    const vNew = await mkVersion("v-new", "time-phased-v3", "2026-06-02T02:00:00Z");

    const line = (versionId: number, skuId: number, code: string, qty: string, businessDate: string) => ({
      versionId, skuId, skuCode: code, skuName: code, baseUom: "件", suggestedQty: qty,
      suppressed: false, onHand: "0", inTransit: "0", daily: "1", safetyQty: "0",
      explanation: [], decisionEnvelope: envelope(businessDate, 30, qty),
    });
    await db.insert(schema.planningVersionLines).values([
      line(vOld, sku.OLD1, "EM-OLD1", "100", "2026-06-01"),
      line(vOld, sku.OLD2, "EM-OLD2", "200", "2026-06-01"),
      line(vNew, sku.NEW1, "EM-NEW1", "100", "2026-06-02"),
    ]);

    // 实际下单：三条各下 100（OLD2 于是落进 <50% 桶，OLD1/NEW1 落进 90–110%）
    for (const [i, k] of ["OLD1", "OLD2", "NEW1"].entries()) {
      const [bh] = await db.insert(schema.bhDocs).values({
        docNo: `BH-EM-${i}`, status: "approved", createdBy: pmc.id, createdAt: new Date("2026-06-10T02:00:00Z"),
      }).returning();
      await db.insert(schema.bhLines).values({ bhId: bh.id, skuId: sku[k], qty: "100" });
    }
    // 给一条实时仓流水，免得全部落进"快照仓弃权"
    await db.insert(schema.stockLedger).values({
      skuId: sku.OLD1, warehouseId: rt.id, qtyDelta: "-10", sourceDocType: "test", sourceDocId: 1,
      action: "post", occurredAt: new Date("2026-06-15T02:00:00Z"),
    });
  });

  it("键随口径升版（数字含义变了就必须换版本串）", () => {
    expect(SUGGESTION_ACCURACY_VERSION).toBe("closed-loop-accuracy/v2");
  });

  it("engineMix 列出每个引擎版本的样本数，逐版本分布与总分布并存", async () => {
    const a = await getSuggestionAccuracy(db, { now: NOW });
    expect(a.sample).toBe(3);
    expect(a.matured).toBe(3);

    const mix = Object.fromEntries(a.engineMix.map((m) => [m.engineVersion, m.matured]));
    expect(mix, "两套引擎口径必须各自可见").toEqual({ "time-phased-v2": 2, "time-phased-v3": 1 });

    const byVer = Object.fromEntries(a.byEngineVersion.map((v) => [v.engineVersion, v]));
    const count = (list: { key: string; count: number }[], key: string) => list.find((b) => b.key === key)?.count ?? 0;
    expect(count(byVer["time-phased-v2"].orderedVsRequired, "90_110"), "v2 里 OLD1 达成 100%").toBe(1);
    expect(count(byVer["time-phased-v2"].orderedVsRequired, "50_90"), "v2 里 OLD2 只下了一半（100/200 = 50%）").toBe(1);
    expect(count(byVer["time-phased-v3"].orderedVsRequired, "90_110")).toBe(1);
    // 逐版本之和 = 总分布（分布没有被切碎或重复计数）
    expect(
      a.byEngineVersion.reduce((s, v) => s + v.orderedVsRequired.reduce((x, b) => x + b.count, 0), 0),
    ).toBe(a.orderedVsRequired.reduce((s, b) => s + b.count, 0));
  });

  it("混用时 caliber 里必须明说「不是同一把尺子」——否则读者会把口径切换当成改善", async () => {
    const a = await getSuggestionAccuracy(db, { now: NOW });
    const line = a.caliber.find((c) => c.startsWith("引擎版本"));
    expect(line, "口径清单里必须有一条讲引擎版本").toBeDefined();
    expect(line).toContain("time-phased-v2");
    expect(line).toContain("time-phased-v3");
    expect(line, "混了两套就必须点名说总分布不可比").toContain("不是同一把尺子");
  });

  it("只有一套引擎时如实说「同一套口径」，不制造无谓警告", async () => {
    const { db: db2, client } = await createTestDb();
    try {
      const [p] = await db2.insert(schema.users).values({ name: "计划", roles: ["pmc"] }).returning();
      const [spu] = await db2.insert(schema.spus).values({ code: "EM2-SPU", nameCn: "单口径" }).returning();
      const [s] = await db2.insert(schema.skus).values({
        code: "EM2-A", name: "A", spuId: spu.id, baseUom: "件", skuType: "finished",
      }).returning();
      const [v] = await db2.insert(schema.planningVersions).values({
        name: "only", weekStart: "2026-06-01", engineVersion: "time-phased-v3", parameters: {}, sourceMeta: {},
        lineCount: 1, suggestedCount: 1, suppressedCount: 0,
        digest: "only", idempotencyKey: "em2", createdBy: p.id, createdAt: new Date("2026-06-01T02:00:00Z"),
      }).returning();
      await db2.insert(schema.planningVersionLines).values({
        versionId: v.id, skuId: s.id, skuCode: "EM2-A", skuName: "A", baseUom: "件", suggestedQty: "10",
        suppressed: false, onHand: "0", inTransit: "0", daily: "1", safetyQty: "0",
        explanation: [], decisionEnvelope: envelope("2026-06-01", 30, "10"),
      });
      const a = await getSuggestionAccuracy(db2, { now: NOW });
      expect(a.engineMix).toEqual([{ engineVersion: "time-phased-v3", sample: 1, matured: 1 }]);
      expect(a.caliber.find((c) => c.startsWith("引擎版本"))).toContain("同一套引擎口径");
    } finally {
      await client.close();
    }
  });

  it("旧快照没有 engine_version 值时不冒充某个版本，落到「(未记录)」", () => {
    expect(UNKNOWN_ENGINE_VERSION).toBe("(未记录)");
  });
});
