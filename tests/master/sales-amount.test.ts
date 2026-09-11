/**
 * sales_amount_monthly 服务（D53）——PGlite：
 * append-only supersedes 链 + 同事务审计；链尾即当前；写守卫 finance/admin；范围校验；
 * DTO 键 salesAmount 对非价格可见角色剥离；观察预填只算不落库。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { maskSensitive, type SessionUser } from "@/server/core/dto";
import { listSalesAmountMonthly, prefillFromObservation, upsertSalesAmountMonthly } from "@/server/modules/master/sales-amount";
import { createTestDb, type TestDb } from "../helpers/db";

describe("sales_amount_monthly", () => {
  let db: TestDb;
  let finance: SessionUser;
  let ops: SessionUser;
  let channelTmall = 0;
  let brandId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [f] = await db.insert(schema.users).values({ name: "财务", roles: ["finance"] }).returning();
    const [o] = await db.insert(schema.users).values({ name: "运营", roles: ["ops"] }).returning();
    finance = { id: f.id, name: f.name, roles: f.roles, isApprover: false };
    ops = { id: o.id, name: o.name, roles: o.roles, isApprover: false };
    const [ch] = await db.insert(schema.channels).values({ code: "tmall", name: "天猫", kind: "platform" }).returning();
    await db.insert(schema.channels).values({ code: "vip", name: "唯品会", kind: "platform" });
    channelTmall = ch.id;
    const [b] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING", nameEn: "NING" }).returning();
    brandId = b.id;
  });

  it("新增 → 幂等 → 改写形成 supersedes 链；链尾即当前；审计同事务", async () => {
    const created = await upsertSalesAmountMonthly(finance, { yearMonth: "2026-08", scopeKind: "company", amount: 1000 }, db);
    expect(created.unchanged).toBe(false);
    expect(created.row).toMatchObject({ yearMonth: "2026-08", scopeKind: "company", scopeId: null, salesAmount: "1000.00", source: "manual", supersedesId: null, superseded: false, createdByName: "财务" });

    const same = await upsertSalesAmountMonthly(finance, { yearMonth: "2026-08", scopeKind: "company", amount: "1000.00" }, db);
    expect(same.unchanged).toBe(true);
    expect(same.row.id).toBe(created.row.id);

    const fixed = await upsertSalesAmountMonthly(finance, { yearMonth: "2026-08", scopeKind: "company", amount: "1200.5", note: "修正" }, db);
    expect(fixed).toMatchObject({ unchanged: false, supersededId: created.row.id });
    expect(fixed.row).toMatchObject({ salesAmount: "1200.50", supersedesId: created.row.id, note: "修正" });

    const current = await listSalesAmountMonthly({ yearMonth: "2026-08" }, db);
    expect(current.total).toBe(1);
    expect(current.rows[0]).toMatchObject({ id: fixed.row.id, salesAmount: "1200.50", superseded: false });
    const all = await listSalesAmountMonthly({ yearMonth: "2026-08", includeSuperseded: true }, db);
    expect(all.rows.map((r) => [r.id, r.superseded])).toEqual([[fixed.row.id, false], [created.row.id, true]]);

    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "sales_amount_monthly"));
    expect(audits.map((a) => a.action).sort()).toEqual(["create", "supersede"]);
    const sup = audits.find((a) => a.action === "supersede");
    expect(sup?.entityId).toBe(fixed.row.id);
    expect((sup?.before as { amount: string }).amount).toBe("1000.00");
    expect((sup?.after as { supersedesId: number }).supersedesId).toBe(created.row.id);
  });

  it("写守卫与范围校验", async () => {
    await expect(upsertSalesAmountMonthly(ops, { yearMonth: "2026-08", scopeKind: "company", amount: 1 }, db)).rejects.toMatchObject({ status: 403 });
    await expect(upsertSalesAmountMonthly(finance, { yearMonth: "2026-08", scopeKind: "brand", amount: 1 }, db)).rejects.toMatchObject({ status: 400 });
    await expect(upsertSalesAmountMonthly(finance, { yearMonth: "2026-08", scopeKind: "company", scopeId: 1, amount: 1 }, db)).rejects.toMatchObject({ status: 400 });
    await expect(upsertSalesAmountMonthly(finance, { yearMonth: "2026-08", scopeKind: "channel", scopeId: 999999, amount: 1 }, db)).rejects.toMatchObject({ status: 404 });
    await expect(upsertSalesAmountMonthly(finance, { yearMonth: "2026-13", scopeKind: "company", amount: 1 }, db)).rejects.toThrow();
    await expect(upsertSalesAmountMonthly(finance, { yearMonth: "2026-08", scopeKind: "company", amount: "abc" }, db)).rejects.toThrow();
    const brand = await upsertSalesAmountMonthly(finance, { yearMonth: "2026-08", scopeKind: "brand", scopeId: brandId, amount: "300" }, db);
    expect(brand.row).toMatchObject({ scopeKind: "brand", scopeId: brandId, scopeName: "NING" });
    const channel = await upsertSalesAmountMonthly(finance, { yearMonth: "2026-08", scopeKind: "channel", scopeId: channelTmall, amount: "700", source: "prefill_observation", sourceRef: "jdy:tmall:2026-08" }, db);
    expect(channel.row).toMatchObject({ scopeKind: "channel", scopeName: "天猫", source: "prefill_observation" });
    const list = await listSalesAmountMonthly({ yearMonth: "2026-08", scopeKind: "channel" }, db);
    expect(list.rows).toHaveLength(1);
  });

  it("DTO：salesAmount 对非价格可见角色剥离，数量/来源字段保留", async () => {
    const list = await listSalesAmountMonthly({ yearMonth: "2026-08", scopeKind: "company" }, db);
    const masked = maskSensitive(list, ["ops"]);
    expect(masked.rows[0]).not.toHaveProperty("salesAmount");
    expect(masked.rows[0]).toMatchObject({ yearMonth: "2026-08", source: "manual" });
    expect(maskSensitive(list, ["finance"]).rows[0].salesAmount).toBe("1200.50");
  });

  it("观察预填：天猫支付−退款 / 唯品会销售额 / 拼多多缺流 → insufficient；只算不落库", async () => {
    const [actor] = await db.select().from(schema.users).where(eq(schema.users.name, "财务"));
    const jobs = await db.insert(schema.importJobs).values([
      { template: "jdy_tmall_sku_sales_observation", filename: "s", sourceAsOf: "2026-09-01", createdBy: actor.id, status: "done" },
      { template: "jdy_tmall_sku_refund_observation", filename: "r", sourceAsOf: "2026-09-01", createdBy: actor.id, status: "done" },
      { template: "jdy_vip_shop_trading_observation", filename: "v", sourceAsOf: "2026-08-15", createdBy: actor.id, status: "done" },
      { template: "jdy_tmall_sku_sales_observation", filename: "old", sourceAsOf: "2026-08-01", createdBy: actor.id, status: "superseded" },
    ]).returning();
    const [sales, refund, vip, stale] = jobs;
    const finishedAt = new Date("2026-09-01T03:00:00.000Z");
    await db.insert(schema.integrationRuns).values([
      { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "pf-s", status: "succeeded", importJobId: sales.id, finishedAt },
      { connector: "jdy", stream: "tmall-sku-refund-observation", idempotencyKey: "pf-r", status: "succeeded", importJobId: refund.id, finishedAt },
      { connector: "jdy", stream: "vip-shop-trading-observation", idempotencyKey: "pf-v", status: "succeeded", importJobId: vip.id, finishedAt },
      // 被 supersede 的更晚批次不得入选
      { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "pf-stale", status: "succeeded", importJobId: stale.id, finishedAt: new Date("2026-09-02T03:00:00.000Z") },
    ]);
    const row = (jobId: number, rowNo: number, table: string, data: Record<string, string>) => ({
      importJobId: jobId, rowNo, status: "pending" as const, targetTable: table, payload: { data },
    });
    await db.insert(schema.stagingRows).values([
      row(sales.id, 1, "jdy_tmall_sku_sales_observation", { statisticalDate: "2026-08-01", shopName: "A店", skuId: "1", paidAmount: "100.5" }),
      row(sales.id, 2, "jdy_tmall_sku_sales_observation", { statisticalDate: "2026-08-31", shopName: "A店", skuId: "2", paidAmount: "200" }),
      row(sales.id, 3, "jdy_tmall_sku_sales_observation", { statisticalDate: "2026-08-20", shopName: "A店", skuId: "3", paidAmount: "坏值" }),
      row(sales.id, 4, "jdy_tmall_sku_sales_observation", { statisticalDate: "2026-09-01", shopName: "A店", skuId: "1", paidAmount: "999" }), // 下月不算
      row(sales.id, 5, "jdy_tmall_sku_sales_observation", { statisticalDate: "2026-08-31", shopName: "A店", skuId: "2", paidAmount: "200" }), // 业务键重复上传：按 DISTINCT ON 去重，不得算大
      row(refund.id, 1, "jdy_tmall_sku_refund_observation", { statisticalDate: "2026-08-31", shopName: "A店", skuId: "1", successRefundAmount: "50.5" }),
      row(vip.id, 1, "jdy_vip_shop_trading_observation", { statisticalDate: "2026-08-10", shopName: "V店", brandName: "NING", salesAmount: "300" }),
      row(vip.id, 2, "jdy_vip_shop_trading_observation", { statisticalDate: "2026-08-15", shopName: "V店", brandName: "NING", salesAmount: "40.25" }),
      row(stale.id, 1, "jdy_tmall_sku_sales_observation", { statisticalDate: "2026-08-05", shopName: "A店", skuId: "1", paidAmount: "5000" }),
    ]);

    const p = await prefillFromObservation("2026-08", db);
    expect(p).toMatchObject({ yearMonth: "2026-08", authority: "observation_only", source: "prefill_observation" });
    const tmall = p.platforms.find((x) => x.platform === "天猫")!;
    // rows = 该月去重后的业务键数（含坏值行 1 条，坏值不计入金额；重复行只计一次）：3 条日销 + 1 条退款
    expect(tmall).toMatchObject({ state: "ready", salesAmount: "250.00", channelId: channelTmall, rows: 4, importJobIds: [sales.id, refund.id] });
    expect(tmall.detail).toEqual({ paidAmount: "300.50", successRefundAmount: "50.50" });
    const vipRow = p.platforms.find((x) => x.platform === "唯品会")!;
    expect(vipRow).toMatchObject({ state: "partial", salesAmount: "340.25", coverageThrough: "2026-08-15" });
    expect(vipRow.channelId).toBeGreaterThan(0);
    const pdd = p.platforms.find((x) => x.platform === "拼多多")!;
    expect(pdd).toMatchObject({ state: "insufficient", salesAmount: null, channelId: null });
    expect(p.company).toMatchObject({ salesAmount: "590.25", complete: false, missing: ["拼多多"] });

    // 只算不落库：受控表里仍只有此前手工/测试写入的行
    const rows = await db.select().from(schema.salesAmountMonthly).where(and(eq(schema.salesAmountMonthly.yearMonth, "2026-08"), eq(schema.salesAmountMonthly.source, "prefill_observation")));
    expect(rows).toHaveLength(1); // 上一用例写入的天猫渠道行
    // 非价格可见角色拿不到金额
    const masked = maskSensitive(p, ["ops"]);
    expect(masked.platforms[0]).not.toHaveProperty("salesAmount");
    expect(masked.company).not.toHaveProperty("salesAmount");
    await expect(prefillFromObservation("2026-8", db)).rejects.toMatchObject({ status: 400 });
  });
});
