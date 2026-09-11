import { beforeAll, describe, expect, it } from "vitest";
import { approvalConfigs, bhDocs, bhLines, skus, spus, stockDocs, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { getInbox } from "@/server/modules/inbox/service";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * 我的待办聚合：
 * - 审批域=approval_configs（bh→pmc、opening→finance）；角色只见本域 pending 单
 * - SoD：自己创建的单不进「待我审批」，单列「我提交的待审」
 * - admin 全域可见；非审批人（is_approver=false）待审区为空
 * - 排序：最早提交在前；total=待我审批数
 */
describe("inbox：待办聚合（域过滤 / SoD / 排序）", () => {
  let db: TestDb;
  let pmcApprover: SessionUser;
  let pmcApprover2: SessionUser; // bh2 的制单人（同为 pmc 审批人——验证 SoD 分区）
  let pmcNonApprover: SessionUser;
  let financeApprover: SessionUser;
  let admin: SessionUser;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[], isApprover: boolean): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover }).returning();
      return { id: u.id, name: u.name, roles, isApprover };
    };
    pmcApprover = await mkUser("PMC审批", ["pmc"], true);
    pmcApprover2 = await mkUser("PMC审批2", ["pmc"], true);
    pmcNonApprover = await mkUser("PMC制单", ["pmc"], false);
    financeApprover = await mkUser("财务审批", ["finance"], true);
    admin = await mkUser("管理员", ["admin"], true);

    await db.insert(approvalConfigs).values([
      { docType: "bh", approverRole: "pmc" },
      { docType: "opening", approverRole: "finance" },
      { docType: "stock_doc", approverRole: "warehouse" },
    ]);

    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const [sku] = await db
      .insert(skus)
      .values({ code: "CP00001", name: "胶原蛋白肽饮品", spuId: spu.id, skuType: "finished", baseUom: "盒" })
      .returning();

    // 两张 pending BH（bh2 较早提交，验证 oldest-first）；一张 draft BH（不应出现）
    const [bh1] = await db
      .insert(bhDocs)
      .values({
        docNo: "BH20260702-001", status: "pending", createdBy: pmcNonApprover.id,
        createdAt: new Date("2026-07-02T08:00:00Z"),
      })
      .returning();
    const [bh2] = await db
      .insert(bhDocs)
      .values({
        docNo: "BH20260701-001", status: "pending", createdBy: pmcApprover2.id,
        createdAt: new Date("2026-07-01T08:00:00Z"),
      })
      .returning();
    await db.insert(bhDocs).values({ docNo: "BH20260703-001", status: "draft", createdBy: pmcNonApprover.id });
    await db.insert(bhLines).values([
      { bhId: bh1.id, skuId: sku.id, qty: "100" },
      { bhId: bh1.id, skuId: sku.id, qty: "50" },
      { bhId: bh2.id, skuId: sku.id, qty: "30" },
    ]);

    // pending 期初库存单（审批域=opening，财务）
    await db.insert(stockDocs).values({
      docNo: "RK20260703-001", status: "pending", subtype: "opening", createdBy: pmcNonApprover.id,
      createdAt: new Date("2026-07-03T08:00:00Z"),
    });
  });

  it("pmc 审批人：只见 bh 域，最早提交在前，含摘要与 href", async () => {
    const r = await getInbox(pmcApprover, db);
    expect(r.total).toBe(2);
    expect(r.pending.map((i) => i.docNo)).toEqual(["BH20260701-001", "BH20260702-001"]);
    expect(r.pending.every((i) => i.docType === "bh")).toBe(true);
    const bh1 = r.pending.find((i) => i.docNo === "BH20260702-001")!;
    expect(bh1.docTypeLabel).toBe("备货申请");
    expect(bh1.title).toBe("胶原蛋白肽饮品×100 等2项");
    expect(bh1.href).toBe(`/outsource/bh?docId=${bh1.id}`);
    expect(bh1.version).toBe(1);
    expect(bh1.createdByName).toBe("PMC制单");
    expect(r.submitted).toHaveLength(0);
  });

  it("财务审批人：只见期初库存单（opening 域）", async () => {
    const r = await getInbox(financeApprover, db);
    expect(r.total).toBe(1);
    expect(r.pending[0].docNo).toBe("RK20260703-001");
    expect(r.pending[0].docType).toBe("stock_doc");
    expect(r.pending[0].docTypeLabel).toBe("库存·期初");
    expect(r.pending[0].href).toBe(`/inventory/docs?docId=${r.pending[0].id}`);
  });

  it("SoD：自己创建的 pending 单不进待审区，落入「我提交的待审」", async () => {
    const r = await getInbox(pmcApprover2, db);
    expect(r.total).toBe(1); // 只剩别人建的 bh1
    expect(r.pending.map((i) => i.docNo)).toEqual(["BH20260702-001"]);
    expect(r.submitted.map((i) => i.docNo)).toEqual(["BH20260701-001"]);
  });

  it("非审批人：待审区为空，但能看到自己提交的待审单", async () => {
    const r = await getInbox(pmcNonApprover, db);
    expect(r.total).toBe(0);
    expect(r.pending).toHaveLength(0);
    // 他创建了 bh1 + 期初单（draft 的 bh 不算待审）
    expect(r.submitted.map((i) => i.docNo)).toEqual(["BH20260702-001", "RK20260703-001"]);
  });

  it("admin：全域可见（bh×2 + 期初），跨类型仍按提交时间升序", async () => {
    const r = await getInbox(admin, db);
    expect(r.total).toBe(3);
    expect(r.pending.map((i) => i.docNo)).toEqual([
      "BH20260701-001",
      "BH20260702-001",
      "RK20260703-001",
    ]);
  });
  it("异常待审盘点调整进入来源核对区，不变成可独立审批的待办，也不向无关角色泄露", async () => {
    const [doc] = await db.insert(stockDocs).values({
      docNo: "CA-QA-ANOMALY", status: "pending", subtype: "count_adjust", createdBy: pmcNonApprover.id,
    }).returning();
    for (const person of [admin, financeApprover]) {
      const result = await getInbox(person, db);
      expect(result.review.map(r => r.id)).toContain(doc.id);
      expect(result.pending.some(r => r.docNo === doc.docNo)).toBe(false);
      expect(result.submitted.some(r => r.docNo === doc.docNo)).toBe(false);
      expect(result.total).toBe(person === admin ? 3 : 1);
      expect(result.review.find(r => r.id === doc.id)?.href).toBe(`/inventory/docs?docId=${doc.id}`);
    }
    const unrelated = await getInbox(pmcApprover, db);
    expect(unrelated.review).toEqual([]);
  });
});
