import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { approveSh, createQc, createSh, submitSh } from "@/server/modules/matflow/sh";
import { createTestDb, type TestDb } from "../helpers/db";

describe("同JG多收货单累计边界", () => {
  let db: TestDb, n = 0;
  const queries: string[] = [];
  beforeAll(async () => {
    const { client } = await createTestDb();
    db = drizzle(client, { schema: s, logger: { logQuery(query) { queries.push(query); } } });
    await db.insert(s.approvalConfigs).values({ docType: "sh", approverRole: "warehouse" });
    await db.insert(s.sysParams).values({ scope: "global", key: "over_receive_tolerance_pct", value: "0" });
  });
  async function fixture(qty = "100") {
    const code = `JGR-${++n}`;
    const [maker, checker] = await db.insert(s.users).values([
      { name: code, roles: ["warehouse"] }, { name: `${code}-复核`, roles: ["warehouse"], isApprover: true },
    ]).returning();
    const [spu] = await db.insert(s.spus).values({ code, nameCn: code }).returning();
    const [sku] = await db.insert(s.skus).values({ code, name: code, spuId: spu.id, skuType: "finished", baseUom: "盒" }).returning();
    const [sup] = await db.insert(s.suppliers).values({ code, name: code, kinds: ["processor"] }).returning();
    const [wh] = await db.insert(s.warehouses).values({ code, name: code, kind: "finished", accountingMode: "realtime" }).returning();
    const [bom] = await db.insert(s.boms).values({ productSkuId: sku.id, versionNo: code }).returning();
    const [wo] = await db.insert(s.woDocs).values({ docNo: `WO-${code}`, productSkuId: sku.id, qty, supplierId: sup.id, feeRatePlan: "1", bomId: bom.id, createdBy: maker.id }).returning();
    const [jg] = await db.insert(s.jgDocs).values({ docNo: `JG-${code}`, woId: wo.id, supplierId: sup.id, productSkuId: sku.id, qty, feeRateCurrent: "1", status: "in_progress", createdBy: maker.id }).returning();
    return {
      sku, wh, jg,
      actor: { id: maker.id, name: maker.name, roles: maker.roles, isApprover: false },
      checker: { id: checker.id, name: checker.name, roles: checker.roles, isApprover: true },
    };
  }
  async function pending(f: Awaited<ReturnType<typeof fixture>>, qty: string, lineType = "normal") {
    const draft = await createSh(f.actor, { sourceType: "jg", sourceId: f.jg.id, warehouseId: f.wh.id, lines: [{ skuId: f.sku.id, actualQty: qty, lineType }] }, db);
    const sh = await submitSh(f.actor, draft.id, draft.version, db);
    const [line] = await db.select().from(s.shLines).where(eq(s.shLines.shId, sh.id));
    return { sh, line };
  }
  const approve = (f: Awaited<ReturnType<typeof fixture>>, sh: typeof s.shDocs.$inferSelect) => approveSh(f.checker, sh.id, { action: "approve", version: sh.version }, db);
  const row = async (id: number) => (await db.select().from(s.shDocs).where(eq(s.shDocs.id, id)))[0];
  function jgLockAfterReceipt() {
    const sh = queries.findIndex(q => q.includes('from "sh_docs"') && q.endsWith("for update"));
    const jg = queries.findIndex(q => q.includes('from "jg_docs"') && q.endsWith("for update"));
    expect(sh).toBeGreaterThanOrEqual(0);
    expect(jg).toBeGreaterThan(sh);
    return jg;
  }

  it("审批实际SQL按本单→共同JG排他锁→累计读取，不在审批时写库存", async () => {
    const f = await fixture(), a = await pending(f, "80");
    queries.length = 0;
    await approve(f, a.sh);
    const lock = jgLockAfterReceipt();
    const aggregate = queries.findIndex(q => q.includes('from "sh_lines" inner join "sh_docs"'));
    expect(aggregate).toBeGreaterThan(lock);
    expect(await db.select().from(s.stockLedger)).toHaveLength(0);
  });

  it("QC按相同JG锁序提交不合格分母，源JG已关闭仍允许登记已批收货的检验事实", async () => {
    const f = await fixture(), a = await pending(f, "20");
    await approve(f, a.sh);
    await db.update(s.jgDocs).set({ status: "closed" }).where(eq(s.jgDocs.id, f.jg.id));
    queries.length = 0;
    await createQc(f.actor, { shId: a.sh.id, lines: [{ shLineId: a.line.id, passQty: "0", failQty: "20", concessionQty: "0", failHandling: "rework" }] }, db);
    const lock = jgLockAfterReceipt();
    expect(queries.findIndex(q => q.startsWith('insert into "qc_records"'))).toBeGreaterThan(lock);
  });

  it("源JG关闭后的待批SH拒绝并回滚版本、审批和审计，但仍可驳回草稿", async () => {
    const f = await fixture(), a = await pending(f, "10");
    await db.update(s.jgDocs).set({ status: "closed" }).where(eq(s.jgDocs.id, f.jg.id));
    await expect(approve(f, a.sh)).rejects.toMatchObject({ status: 409 });
    expect(await row(a.sh.id)).toMatchObject({ status: "pending", version: a.sh.version });
    expect(await db.select().from(s.approvals).where(and(eq(s.approvals.docType, "sh"), eq(s.approvals.docId, a.sh.id)))).toHaveLength(0);
    expect(await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "sh"), eq(s.auditLogs.entityId, a.sh.id), eq(s.auditLogs.action, "approve")))).toHaveLength(0);
    expect(await approveSh(f.checker, a.sh.id, { action: "reject", version: a.sh.version }, db)).toMatchObject({ status: "draft" });
  });

  it("两张预先创建的正常行不能在审批后超过共同限额；成功重放不受后来关闭影响", async () => {
    const f = await fixture(), a = await pending(f, "80"), b = await pending(f, "80");
    await approve(f, a.sh);
    await expect(approve(f, b.sh)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("累计收货超限") });
    expect(await row(b.sh.id)).toMatchObject({ status: "pending", version: b.sh.version });
    await db.update(s.jgDocs).set({ status: "closed" }).where(eq(s.jgDocs.id, f.jg.id));
    expect(await approve(f, a.sh)).toMatchObject({ idempotent: true });
  });

  it("0.3减已判不合格0.1，正常0.1+0.1恰好通过，备品/返工仍不占正常累计", async () => {
    const f = await fixture("0.3"), a = await pending(f, "0.1"), b = await pending(f, "0.1"), c = await pending(f, "0.0001"), spare = await pending(f, "0.1", "spare"), rework = await pending(f, "0.1", "rework");
    await approve(f, a.sh);
    await createQc(f.actor, { shId: a.sh.id, lines: [{ shLineId: a.line.id, passQty: "0", failQty: "0.1", concessionQty: "0", failHandling: "rework" }] }, db);
    await approve(f, spare.sh);
    await createQc(f.actor, { shId: spare.sh.id, lines: [{ shLineId: spare.line.id, passQty: "0", failQty: "0.1", concessionQty: "0", failHandling: "scrap" }] }, db);
    await approve(f, b.sh);
    await approve(f, rework.sh);
    await expect(approve(f, c.sh)).rejects.toMatchObject({ status: 409 });
  });
});
