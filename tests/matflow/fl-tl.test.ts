import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  approvalConfigs, auditLogs, boms, flDocs, jgDocs, skus, spus, stockBalances,
  stockLedger, suppliers, tlDocs, users, warehouses, woDocs, woLines,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { getBalance } from "@/server/posting";
import { approveFl, createFl, getFl, listFls, submitFl } from "@/server/modules/matflow/fl";
import { approveTl, createTl, getTl, listTls, submitTl } from "@/server/modules/matflow/tl";
import { createTestDb, type TestDb } from "../helpers/db";
import * as auditModule from "@/server/core/audit";

/**
 * W4 发料 FL / 退料 TL：
 * fl_issue 过账（自有仓−/委外仓+）、超发管理员门（《02》§3）、
 * TL≤FL 守卫、tl_return 过账、SoD 与审计留痕。
 * WO/JG 夹具直插（W3 服务链已有 chain.test.ts 全覆盖）。
 */
describe("物料流转 W4：FL 发料 / TL 退料", () => {
  let db: TestDb;
  let whCreator: SessionUser; // 仓管制单
  let whApprover: SessionUser; // 仓管审批人
  let admin: SessionUser;

  let cp = 0; // 成品
  let yl = 0; // 原料（毛需求 51）
  let bc = 0; // 包材（毛需求 10500）
  let whRawId = 0; // 原料仓
  let whWxId = 0; // 委外仓
  let jg1 = 0;

  let fl1 = 0; // 首张发料（yl 30）
  let fl2 = 0; // 超发单（yl 30 → 累计 60 > 51）

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
      return { id: u.id, name: u.name, roles, isApprover };
    };
    whCreator = await mkUser("仓管制单", ["warehouse"], false);
    whApprover = await mkUser("仓管审批", ["warehouse"], true);
    admin = await mkUser("管理员", ["admin"], true);

    await db.insert(approvalConfigs).values([
      { docType: "fl", approverRole: "warehouse" },
      { docType: "tl", approverRole: "warehouse" },
    ]);

    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const mkSku = async (code: string, name: string, skuType: "finished" | "raw" | "packaging", baseUom: string) => {
      const [s] = await db.insert(skus).values({ code, name, spuId: spu.id, skuType, baseUom }).returning();
      return s.id;
    };
    cp = await mkSku("CP00001", "成品A", "finished", "盒");
    yl = await mkSku("YL00001", "原料A", "raw", "kg");
    bc = await mkSku("BC00001", "包材A", "packaging", "个");

    const [supProc] = await db
      .insert(suppliers)
      .values({ code: "SUP001", name: "加工厂C", kinds: ["processor"], status: "qualified" })
      .returning();

    const [whRaw] = await db
      .insert(warehouses)
      .values({ code: "WH-YL", name: "原料仓", kind: "raw", accountingMode: "realtime" })
      .returning();
    whRawId = whRaw.id;
    const [whWx] = await db
      .insert(warehouses)
      .values({ code: "WH-WX", name: "委外仓C", kind: "outsource", accountingMode: "realtime", supplierId: supProc.id })
      .returning();
    whWxId = whWx.id;

    // WO/JG 夹具直插：wo_line 快照 = 超发校验基准（yl 毛需求 51 / bc 10500）
    const [bom] = await db
      .insert(boms)
      .values({ productSkuId: cp, versionNo: "V1", status: "active", effectiveDate: "2026-01-01" })
      .returning();
    const [wo] = await db
      .insert(woDocs)
      .values({
        docNo: "WO-T-0001", status: "approved", productSkuId: cp, qty: "1000",
        supplierId: supProc.id, feeRatePlan: "2.50", bomId: bom.id, createdBy: admin.id,
      })
      .returning();
    await db.insert(woLines).values([
      { woId: wo.id, materialSkuId: yl, qtyPer: "0.05", planLossRatePct: "2", grossReq: "51", suggestedQty: "51" },
      { woId: wo.id, materialSkuId: bc, qtyPer: "10", planLossRatePct: "5", grossReq: "10500", suggestedQty: "10500" },
    ]);
    const [jg] = await db
      .insert(jgDocs)
      .values({
        docNo: "JG-T-0001", status: "in_progress", woId: wo.id, supplierId: supProc.id,
        productSkuId: cp, qty: "1000", feeRateCurrent: "2.50", createdBy: admin.id,
      })
      .returning();
    jg1 = jg.id;

    // 期初库存（测试直插余额；应用侧仅可经过账引擎）
    await db.insert(stockBalances).values([
      { skuId: yl, warehouseId: whRawId, qty: "100" },
      { skuId: bc, warehouseId: whRawId, qty: "20000" },
    ]);
  });

  it("1) FL 建单：委外仓自动定位加工厂仓；JG 非执行中拒建；无委外仓 404", async () => {
    const fl = await createFl(whCreator, {
      jgId: jg1, fromWarehouseId: whRawId,
      lines: [{ skuId: yl, qty: "30" }],
    }, db);
    fl1 = fl.id;
    expect(fl.docNo.startsWith("FL-")).toBe(true);
    expect(fl.status).toBe("draft");
    expect(fl.toWarehouseId).toBe(whWxId); // 自动 = 该加工厂委外仓

    // 非仓管拒建
    const [ops] = await db.insert(users).values({ name: "非仓管", roles: ["ops"] }).returning();
    await expect(
      createFl({ id: ops.id, name: ops.name, roles: ops.roles, isApprover: false }, { jgId: jg1, fromWarehouseId: whRawId, lines: [{ skuId: yl, qty: "1" }] }, db),
    ).rejects.toMatchObject({ status: 403 });

    // 无委外仓的加工厂 → 404
    const [supNoWh] = await db
      .insert(suppliers)
      .values({ code: "SUP009", name: "无仓加工厂", kinds: ["processor"], status: "qualified" })
      .returning();
    const [wo0] = await db.select().from(woDocs).limit(1);
    const [wo2] = await db
      .insert(woDocs)
      .values({
        docNo: "WO-T-0009", status: "approved", productSkuId: cp, qty: "10",
        supplierId: supNoWh.id, feeRatePlan: "1.00", bomId: wo0.bomId, createdBy: admin.id,
      })
      .returning();
    const [jgNoWh] = await db
      .insert(jgDocs)
      .values({
        docNo: "JG-T-0009", status: "in_progress", woId: wo2.id,
        supplierId: supNoWh.id, productSkuId: cp, qty: "10", feeRateCurrent: "1.00", createdBy: admin.id,
      })
      .returning();
    await expect(
      createFl(whCreator, { jgId: jgNoWh.id, fromWarehouseId: whRawId, lines: [{ skuId: yl, qty: "1" }] }, db),
    ).rejects.toMatchObject({ status: 404, message: expect.stringContaining("委外仓") });
  });

  it("2) FL 审批过账：自有仓 − / 委外仓 +（一事件两腿）；重试幂等", async () => {
    const pending = await submitFl(whCreator, fl1, 1, db);
    expect(pending.status).toBe("pending");

    const r = await approveFl(whApprover, fl1, { action: "approve", version: pending.version }, db);
    expect(r).toMatchObject({ status: "completed", idempotent: false });

    expect(await getBalance(db, yl, whRawId)).toBe("70.0000");
    expect(await getBalance(db, yl, whWxId)).toBe("30.0000");

    // 流水：fl_issue 一事件、每行两腿（±sourceLineId）
    const ledger = await db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.sourceDocType, "fl_issue"));
    expect(ledger).toHaveLength(2);
    expect(ledger.map((l) => l.qtyDelta).sort()).toEqual(["-30.0000", "30.0000"]);

    // 重试幂等：同版本重复审批不重复过账
    const retry = await approveFl(whApprover, fl1, { action: "approve", version: pending.version }, db);
    expect(retry.idempotent).toBe(true);
    expect(await getBalance(db, yl, whWxId)).toBe("30.0000");
  });

  it("3) 超发规则：累计+本单 > wo_line 毛需求 → 仓管审批 403，管理员放行", async () => {
    const fl = await createFl(whCreator, {
      jgId: jg1, fromWarehouseId: whRawId,
      lines: [{ skuId: yl, qty: "30" }], // 累计 30+30=60 > 毛需求 51
    }, db);
    fl2 = fl.id;
    const pending = await submitFl(whCreator, fl2, 1, db);

    await expect(
      approveFl(whApprover, fl2, { action: "approve", version: pending.version }, db),
    ).rejects.toMatchObject({ status: 403, message: "超发需管理员审批" });

    // 校验失败整个事务回滚：单据仍待审批、无过账
    const [doc] = await db.select().from(flDocs).where(eq(flDocs.id, fl2));
    expect(doc.status).toBe("pending");
    expect(doc.version).toBe(pending.version);
    expect(await getBalance(db, yl, whWxId)).toBe("30.0000");

    // 管理员放行（SoD：管理员≠制单人）
    const r = await approveFl(admin, fl2, { action: "approve", version: pending.version }, db);
    expect(r).toMatchObject({ status: "completed", idempotent: false });
    expect(await getBalance(db, yl, whRawId)).toBe("40.0000");
    expect(await getBalance(db, yl, whWxId)).toBe("60.0000");
  });

  it("4) FL 详情：需求对照（毛需求 vs 累计已发）；列表", async () => {
    const detail = await getFl(fl2, db);
    expect(detail.jgId).toBe(jg1);
    expect(detail.fromWarehouseName).toBe("原料仓");
    expect(detail.toWarehouseName).toBe("委外仓C");
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]).toMatchObject({ skuId: yl, qty: "30.0000", baseUom: "kg" });
    expect(detail.requirements).toEqual([{ skuId: yl, grossReq: "51.0000", issuedCum: "60.0000" }]);
    expect(detail.approvals.length).toBeGreaterThanOrEqual(1);

    const list = await listFls("", { jgId: jg1, page: 1, pageSize: 10 }, db);
    expect(list.total).toBe(2);
  });

  it("5) TL 退料：部分退回过账（委外仓−/自有仓+）；退超累计发料 → 409", async () => {
    const tl = await createTl(whCreator, {
      jgId: jg1, toWarehouseId: whRawId,
      lines: [{ skuId: yl, qty: "10", reason: "surplus_return" }],
    }, db);
    expect(tl.docNo.startsWith("TL-")).toBe(true);
    expect(tl.fromWarehouseId).toBe(whWxId); // 自动 = 委外仓
    const pending = await submitTl(whCreator, tl.id, 1, db);
    const r = await approveTl(whApprover, tl.id, { action: "approve", version: pending.version }, db);
    expect(r).toMatchObject({ status: "completed", idempotent: false });
    expect(await getBalance(db, yl, whWxId)).toBe("50.0000");
    expect(await getBalance(db, yl, whRawId)).toBe("50.0000");

    const detail = await getTl(tl.id, db);
    expect(detail.lines[0]).toMatchObject({ skuId: yl, qty: "10.0000", reason: "surplus_return" });
    expect((await listTls("", { jgId: jg1, page: 1, pageSize: 10 }, db)).total).toBe(1);

    // 累计 TL(10+100=110) > 累计 FL(60) → 审批 409，全量回滚
    const tl2 = await createTl(whCreator, {
      jgId: jg1, toWarehouseId: whRawId,
      lines: [{ skuId: yl, qty: "100", reason: "defect_exchange" }],
    }, db);
    const p2 = await submitTl(whCreator, tl2.id, 1, db);
    await expect(
      approveTl(whApprover, tl2.id, { action: "approve", version: p2.version }, db),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("退料超过累计发料") });
    const [doc2] = await db.select().from(tlDocs).where(eq(tlDocs.id, tl2.id));
    expect(doc2.status).toBe("pending");
    expect(await getBalance(db, yl, whWxId)).toBe("50.0000");
  });

  it("6) SoD：制单人不可审批自己的单（管理员亦不豁免）", async () => {
    const fl = await createFl(whApprover, {
      jgId: jg1, fromWarehouseId: whRawId,
      lines: [{ skuId: bc, qty: "100" }],
    }, db);
    const pending = await submitFl(whApprover, fl.id, 1, db);
    await expect(
      approveFl(whApprover, fl.id, { action: "approve", version: pending.version }, db),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining("SELF_APPROVAL") });
  });

  it("退料提交审计失败整笔回滚；旧会话角色不能代替当前写入身份", async () => {
    const tl = await createTl(whCreator, { jgId: jg1, toWarehouseId: whRawId, lines: [{ skuId: yl, qty: "1", reason: "surplus_return" }] }, db);
    const fail = vi.spyOn(auditModule, "writeAudit").mockRejectedValueOnce(new Error("submit audit failed"));
    try { await expect(submitTl(whCreator, tl.id, tl.version, db)).rejects.toThrow("submit audit failed"); } finally { fail.mockRestore(); }
    expect((await db.select().from(tlDocs).where(eq(tlDocs.id, tl.id)))[0]).toMatchObject({ status: "draft", version: tl.version });
    await db.update(users).set({ active: false }).where(eq(users.id, whCreator.id));
    try {
      await expect(submitTl(whCreator, tl.id, tl.version, db)).rejects.toMatchObject({ status: 403 });
      await expect(createTl(whCreator, { jgId: jg1, toWarehouseId: whRawId, lines: [{ skuId: yl, qty: "1", reason: "surplus_return" }] }, db)).rejects.toMatchObject({ status: 403 });
    } finally { await db.update(users).set({ active: true }).where(eq(users.id, whCreator.id)); }
  });

  it("关闭JG拦截待审发料但保留驳回；退料允许短关回收；审批仍核对当前身份", async () => {
    const fl = await createFl(whCreator, { jgId: jg1, fromWarehouseId: whRawId, lines: [{ skuId: yl, qty: "1" }] }, db);
    const fp = await submitFl(whCreator, fl.id, fl.version, db);
    await db.update(jgDocs).set({ status: "closed" }).where(eq(jgDocs.id, jg1));
    try {
      await expect(approveFl(whApprover, fl.id, { action: "approve", version: fp.version }, db)).rejects.toMatchObject({ status: 409 });
      expect((await db.select().from(flDocs).where(eq(flDocs.id, fl.id)))[0].status).toBe("pending");
      await approveFl(whApprover, fl.id, { action: "reject", version: fp.version }, db);
      const tl = await createTl(whCreator, { jgId: jg1, toWarehouseId: whRawId, lines: [{ skuId: yl, qty: "1", reason: "surplus_return" }] }, db);
      const pending = await submitTl(whCreator, tl.id, tl.version, db);
      await db.update(users).set({ isApprover: false }).where(eq(users.id, whApprover.id));
      try { await expect(approveTl(whApprover, tl.id, { action: "approve", version: pending.version }, db)).rejects.toMatchObject({ status: 403 }); }
      finally { await db.update(users).set({ isApprover: true }).where(eq(users.id, whApprover.id)); }
      expect(await approveTl(whApprover, tl.id, { action: "approve", version: pending.version }, db)).toMatchObject({ status: "completed" });
      expect(await approveTl(whApprover, tl.id, { action: "approve", version: pending.version }, db)).toMatchObject({ idempotent: true });
    } finally { await db.update(jgDocs).set({ status: "in_progress" }).where(eq(jgDocs.id, jg1)); }
  });

  it("7) 审计留痕：FL/TL 每个写动作均有 audit_logs 行", async () => {
    const rows = await db
      .select({ entity: auditLogs.entity, action: auditLogs.action })
      .from(auditLogs)
      .where(inArray(auditLogs.entity, ["fl", "tl"]));
    const seen = new Set(rows.map((r) => `${r.entity}:${r.action}`));
    for (const key of [
      "fl:create", "fl:submit", "fl:approve", "fl:post_and_complete",
      "tl:create", "tl:submit", "tl:approve", "tl:post_and_complete",
    ]) {
      expect(seen, `缺少审计: ${key}`).toContain(key);
    }
  });
});
