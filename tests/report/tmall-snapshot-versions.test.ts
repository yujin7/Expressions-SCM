import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeChannelObservation } from "@/server/modules/report/channel-observation";
import { computeExternalVelocity } from "@/server/modules/report/external-velocity";

describe("天猫日快照业务键版本在两个消费者中一致", () => {
  it.each([false, true])("重复不累加、末行删除不复活（删除=%s）", async (deleted) => {
    const { db, client } = await createTestDb();
    try {
      const [actor] = await db.insert(schema.users).values({ name: "快照测试" }).returning();
      const [spu] = await db.insert(schema.spus).values({ code: "TM-V", nameCn: "快照" }).returning();
      const [sku] = await db.insert(schema.skus).values({ code: "TM-V1", name: "测试成品", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
      const [sales, refunds, crosswalk] = await db.insert(schema.importJobs).values([
        "jdy_tmall_sku_sales_observation", "jdy_tmall_sku_refund_observation", "jdy_tmall_sku_crosswalk_observation",
      ].map((template) => ({ template, filename: template, sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" as const }))).returning();
      await db.insert(schema.integrationRuns).values([sales, refunds, crosswalk].map((job, i) => ({
        connector: "jdy", stream: ["tmall-sku-sales-observation", "tmall-sku-refund-observation", "tmall-sku-crosswalk-observation"][i],
        idempotencyKey: `snapshot-version-${i}`, status: "succeeded" as const, importJobId: job.id,
        finishedAt: new Date("2026-09-02T03:00:00Z"),
        // 历史删除载荷单独验证；重复-only review 必须保留治理规定的去重读取路径。
        requestScope: { qualityBlocked: !deleted && i < 2, controlSummary: { status: "review", duplicateRows: 2, duplicateKeyGroups: 1, invalidNumericValues: 0, reconciliationMismatchedRows: 0, deletedRows: 0 } },
      })));
      const fact = (job: typeof sales, rowNo: number, platformSku: string, date: string, q: string, isDeleted = false) => ({
        importJobId: job.id, rowNo, status: "pending" as const, targetTable: job.template,
        payload: { ...(isDeleted ? { sourceDeletedAt: "2026-09-02T02:00:00Z" } : {}), data: { shopName: "测试店", skuId: platformSku, statisticalDate: date, paidNumber: q, paidAmount: q, successRefundSuborderNumber: q } },
      });
      await db.insert(schema.stagingRows).values([
        fact(sales, 1, "P1", "2026-09-01", "20.2500"), fact(sales, 2, "P1", "2026-09-01", "20.2500", deleted),
        fact(refunds, 1, "P1", "2026-09-01", "1.1250"), fact(refunds, 2, "P1", "2026-09-01", "1.1250", deleted),
        fact(sales, 3, "P2", "2026-09-02", "3.5000"), fact(refunds, 3, "P2", "2026-09-02", "0.0000"),
        ...["P1", "P2"].map((psku, i) => ({ importJobId: crosswalk.id, rowNo: i + 1, status: "pending" as const, targetTable: crosswalk.template, payload: { data: { shopName: "测试店", platformSkuId: psku }, _identity: { skuId: sku.id } } })),
      ]);
      const channel = await computeChannelObservation(db);
      const velocity = await computeExternalVelocity(db);
      expect(channel.platforms.find((p) => p.platform === "天猫")).toMatchObject({ state: "ready", units: deleted ? "3.5000" : "22.6250", refundUnits: deleted ? "0.0000" : "1.1250" });
      expect(velocity.bySku[String(sku.id)].tmallNet30).toBe(deleted ? "3.5000" : "22.6250");
      if (deleted) {
        // 最新日的退款记录已删除：不能用同键旧行证明该日退款已覆盖。
        const [newRefunds] = await db.insert(schema.importJobs).values({ template: refunds.template, filename: "deleted-horizon", sourceAsOf: "2026-09-02", createdBy: actor.id, status: "done" }).returning();
        await db.insert(schema.integrationRuns).values({ connector: "jdy", stream: "tmall-sku-refund-observation", idempotencyKey: "deleted-horizon", status: "succeeded", importJobId: newRefunds.id, finishedAt: new Date("2026-09-02T04:00:00Z") });
        await db.insert(schema.stagingRows).values([
          fact(newRefunds, 1, "P1", "2026-09-01", "0"),
          fact(newRefunds, 2, "P2", "2026-09-02", "0"),
          fact(newRefunds, 3, "P2", "2026-09-02", "0", true),
        ]);
        expect((await computeChannelObservation(db)).platforms.find((p) => p.platform === "天猫")).toMatchObject({ state: "insufficient", units: null });
        expect(await computeExternalVelocity(db)).toMatchObject({ state: "insufficient", bySku: {} });
      }
    } finally { await client.close(); }
  });
});
