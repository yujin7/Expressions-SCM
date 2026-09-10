import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { approvalConfigs, auditLogs, bhDocs, bomLines, boms, skus, spus, suppliers, users, woDocs } from "@/db/schema";
import { ORDER_TYPES } from "@/server/core/constants";
import { formatOrderType } from "@/components/labels";
import type { SessionUser } from "@/server/core/dto";
import * as audit from "@/server/core/audit";
import { approveBh, createBh, submitBh } from "@/server/modules/outsource/bh";
import { approveWo, createWo, generateDocs, submitWo } from "@/server/modules/outsource/wo";
import { createTestDb, type TestDb } from "../helpers/db";

describe("FS-R2 返单身份从人工申请到加工单，不从常规/采购历史推断", () => {
  let db: TestDb;
  let maker: SessionUser;
  let approver: SessionUser;
  let skuId: number;
  let otherId: number;
  let supplierId: number;
  beforeAll(async () => {
    ({ db } = await createTestDb());
    const us = await db.insert(users).values([
      { name: "返单制单", roles: ["admin"], isApprover: false },
      { name: "返单审批", roles: ["admin"], isApprover: true },
    ]).returning();
    [maker, approver] = us.map(u => ({ id: u.id, name: u.name, roles: u.roles, isApprover: u.isApprover }));
    await db.insert(approvalConfigs).values([{ docType: "bh", approverRole: "pmc" }, { docType: "wo", approverRole: "pmc" }]);
    const [spu] = await db.insert(spus).values({ code: "REPEAT", nameCn: "返单测试" }).returning();
    const products = await db.insert(skus).values([
      { code: "REPEAT-FG", name: "返单成品", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "REPEAT-OTHER", name: "另一成品", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "REPEAT-PKG", name: "包材", spuId: spu.id, skuType: "packaging", baseUom: "个" },
    ]).returning();
    [skuId, otherId] = products.map(p => p.id);
    for (const productSkuId of [skuId, otherId]) {
      const [bom] = await db.insert(boms).values({ productSkuId, versionNo: "1", status: "active" }).returning();
      await db.insert(bomLines).values({ bomId: bom.id, materialSkuId: products[2].id, qtyPer: "1" });
    }
    const [supplier] = await db.insert(suppliers).values({ code: "REPEAT-S", name: "返单加工厂", kinds: ["processor"], status: "qualified" }).returning();
    supplierId = supplier.id;
  });
  async function source(orderType?: string, approved = true) {
    const bh = await createBh(maker, { orderType, lines: [{ skuId, qty: "10" }] }, db);
    if (approved) {
      const pending = await submitBh(maker, bh.id, bh.version, db);
      await approveBh(approver, bh.id, { action: "approve", version: pending.version }, db);
    }
    return bh;
  }
  const input = () => ({ productSkuId: skuId, supplierId, qty: "10", feeRatePlan: "1" });

  it("字典和表单标签支持明确的成品返单，不重新解释 regular", () => {
    expect(ORDER_TYPES).toContain("repeat");
    expect(formatOrderType("repeat")).toBe("成品返单");
    expect(formatOrderType("regular")).toBe("常规备货");
  });
  it("人工BH返单经真实审批→WO自动继承→审批→JG仍是返单，审计保留来源", async () => {
    const bh = await source("repeat");
    const wo = await createWo(maker, { ...input(), bhId: bh.id }, db);
    expect(wo.orderType).toBe("repeat");
    const pending = await submitWo(maker, wo.id, wo.version, db);
    await approveWo(approver, wo.id, { action: "approve", version: pending.version }, db);
    const { jg } = await generateDocs(maker, wo.id, { poGroups: [] }, db);
    expect(jg.orderType).toBe("repeat");
    const [event] = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "wo"), eq(auditLogs.entityId, wo.id), eq(auditLogs.action, "create")));
    expect(event.after).toMatchObject({ orderType: "repeat", orderTypeSource: "bh", bhId: bh.id });
  });
  it("常规、未分类和旧purpose原样继承，不自动认定返单", async () => {
    for (const kind of ["regular", undefined]) {
      const bh = await source(kind);
      expect((await createWo(maker, { ...input(), bhId: bh.id }, db)).orderType).toBe(kind ?? null);
    }
    const bh = await source();
    await db.update(bhDocs).set({ purpose: "MONTH_STOCK:9" }).where(eq(bhDocs.id, bh.id));
    expect((await createWo(maker, { ...input(), bhId: bh.id }, db)).orderType).toBe("MONTH_STOCK:9");
  });
  it("无来源时可人工选择返单；来源未分类也允许人工明确，并记审计来源", async () => {
    const bh = await source();
    for (const bhId of [undefined, bh.id]) {
      const wo = await createWo(maker, { ...input(), bhId, orderType: "repeat" }, db);
      expect(wo.orderType).toBe("repeat");
      const [event] = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "wo"), eq(auditLogs.entityId, wo.id), eq(auditLogs.action, "create")));
      expect(event.after).toMatchObject({ orderTypeSource: "manual" });
    }
  });
  it("禁止把来源新品首单/返单静默改成其他类型，无多余工单和审计", async () => {
    for (const kind of ["npd_first", "repeat"]) {
      const bh = await source(kind);
      const before = await db.select().from(woDocs);
      const events = await db.select().from(auditLogs);
      await expect(createWo(maker, { ...input(), bhId: bh.id, orderType: "regular" }, db)).rejects.toMatchObject({ status: 409 });
      expect(await db.select().from(woDocs)).toHaveLength(before.length);
      expect(await db.select().from(auditLogs)).toHaveLength(events.length);
    }
  });
  it("草稿来源和不属于申请的成品不能变成已认可的返单来源", async () => {
    const draft = await source(undefined, false);
    await expect(createWo(maker, { ...input(), bhId: draft.id }, db)).rejects.toMatchObject({ status: 409 });
    const bh = await source("regular");
    await expect(createWo(maker, { ...input(), bhId: bh.id, productSkuId: otherId }, db)).rejects.toMatchObject({ status: 400 });
  });
  it("跨渠道PMC不能通过工单建单认领不可访问申请；无来源也不泄漏其类型", async () => {
    const bh = await source("repeat");
    const scoped: SessionUser = { ...approver, roles: ["pmc"], channelScope: [] };
    await expect(createWo(scoped, { ...input(), bhId: bh.id }, db)).rejects.toMatchObject({ status: 404 });
    await expect(createWo(maker, { ...input(), bhId: 99999999 }, db)).rejects.toMatchObject({ status: 404 });
  });
  it("明确选择相同来源类型可以继续，空白则由服务器继承", async () => {
    const bh = await source("repeat");
    expect((await createWo(maker, { ...input(), bhId: bh.id, orderType: "repeat" }, db)).orderType).toBe("repeat");
  });
  it("审计失败时类型与工单整体回滚，不留下无来源记录", async () => {
    const bh = await source("regular");
    const before = await db.select().from(woDocs);
    const spy = vi.spyOn(audit, "writeAudit").mockRejectedValueOnce(new Error("audit unavailable"));
    try { await expect(createWo(maker, { ...input(), bhId: bh.id }, db)).rejects.toThrow("audit unavailable"); }
    finally { spy.mockRestore(); }
    expect(await db.select().from(woDocs)).toHaveLength(before.length);
  });
});
