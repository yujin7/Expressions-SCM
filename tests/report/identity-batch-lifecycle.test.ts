import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { claimPlatformSku, type PlatformKey } from "@/server/modules/master/platform-sku-claim";
import { computePlatformSkuIdentityGap } from "@/server/modules/report/platform-sku-identity-gap";
import { refreshJiandaoyunExternalDemandReadModel } from "@/server/modules/report/external-demand-signal";

async function setup() {
  const { db, client } = await createTestDb();
  const [user] = await db.insert(schema.users).values({ name: "身份生命周期测试", roles: ["pmc"] }).returning();
  const actor = { id: user.id, name: user.name, roles: ["pmc"], isApprover: false };
  const [spu] = await db.insert(schema.spus).values({ code: "LIFE", nameCn: "生命周期" }).returning();
  const [a, b] = await db.insert(schema.skus).values(["LIFE-A", "LIFE-B"].map((code) => ({ code, name: code, spuId: spu.id, skuType: "finished" as const, baseUom: "支" }))).returning();
  async function batch(stream: string, status: "done" | "superseded" = "done", qualityBlocked = false) {
    const template = `jdy_${stream.replaceAll("-", "_")}`;
    const [job] = await db.insert(schema.importJobs).values({ template, filename: template, sourceAsOf: "2026-09-02", createdBy: actor.id, status }).returning();
    await db.insert(schema.integrationRuns).values({ connector: "jdy", stream, idempotencyKey: `life-${job.id}`, status: "succeeded", importJobId: job.id, requestScope: { qualityBlocked }, finishedAt: new Date("2026-09-02T03:00:00Z") });
    return job;
  }
  async function bridge(platform: PlatformKey, skuId: number, status: "done" | "superseded", review = false) {
    const job = await batch(`${platform}-sku-crosswalk-observation`, status, review);
    await db.insert(schema.stagingRows).values({ importJobId: job.id, rowNo: 1, status: "pending", targetTable: job.template, payload: {
      data: { shopName: "测试店", platformSkuId: "P1", platformProductId: "P1", merchantSkuCode: "LIFE-A" }, _identity: { skuId },
    } });
    return job;
  }
  return { db, client, actor, a, b, batch, bridge };
}

describe("身份批次生命周期不能在认领与读模型间断链", () => {
  it.each(["tmall", "pdd"] as const)("%s：review 中已治理身份仍阻止矛盾认领，拒绝不留下标识", async (platform) => {
    const { db, client, actor, a, b, bridge } = await setup();
    try {
      await bridge(platform, a.id, "done", true);
      const input = { platform, shopName: "测试店", platformSkuId: platform === "pdd" ? "P1|LIFE-A" : "P1" };
      await expect(claimPlatformSku(actor, { ...input, skuId: b.id }, db)).rejects.toThrow(/相互矛盾/);
      expect(await db.select().from(schema.skuIdentifiers)).toHaveLength(0);
      await expect(claimPlatformSku(actor, { ...input, skuId: a.id }, db)).resolves.toMatchObject({ created: true });
      await expect(claimPlatformSku(actor, { ...input, skuId: a.id }, db)).resolves.toMatchObject({ created: false });
    } finally { await client.close(); }
  });

  it.each(["tmall", "pdd"] as const)("%s：被替代批次不能抢占当前可用归属", async (platform) => {
    const { db, client, actor, a, b, bridge } = await setup();
    try {
      await bridge(platform, a.id, "done");
      await bridge(platform, b.id, "superseded");
      await expect(claimPlatformSku(actor, { platform, shopName: "测试店", platformSkuId: platform === "pdd" ? "P1|LIFE-A" : "P1", skuId: a.id }, db)).resolves.toMatchObject({ created: true });
    } finally { await client.close(); }
  });

  it.each(["identity", "demand"] as const)("%s：只有被替代销量批次时，不能继续输出 ready", async (consumer) => {
    const { db, client, a, batch, bridge } = await setup();
    try {
      await bridge("tmall", a.id, "done");
      const sales = await batch("tmall-sku-sales-observation", "superseded");
      const refunds = await batch("tmall-sku-refund-observation");
      await db.insert(schema.stagingRows).values([sales, refunds].map((job) => ({ importJobId: job.id, rowNo: 1, status: "pending" as const, targetTable: job.template, payload: { data: { shopName: "测试店", skuId: "P1", statisticalDate: "2026-09-02", paidNumber: "10", paidAmount: "100", successRefundSuborderNumber: "0" } } })));
      const result = consumer === "identity" ? await computePlatformSkuIdentityGap(db) : await refreshJiandaoyunExternalDemandReadModel(db);
      expect(result.state).toBe("insufficient");
    } finally { await client.close(); }
  });

  it("拼多多明细使用已选批次，不二次选择被替代的较新批次", async () => {
    const { db, client, a, b, bridge } = await setup();
    try {
      await bridge("pdd", a.id, "done");
      const old = await bridge("pdd", b.id, "superseded");
      await db.insert(schema.stagingRows).values({ importJobId: old.id, rowNo: 2, status: "pending", targetTable: old.template, payload: { data: { shopName: "过期店", platformProductId: "OLD", merchantSkuCode: "LIFE-A" }, _identity: {} } });
      const result = await computePlatformSkuIdentityGap(db);
      expect(result.pddSummary.crosswalkRows).toBe(1);
      expect(result.pddExactHits.some((hit) => hit.shopName === "过期店")).toBe(false);
    } finally { await client.close(); }
  });
});
