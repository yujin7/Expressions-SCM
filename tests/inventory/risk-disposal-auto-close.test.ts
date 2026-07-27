import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approvalConfigs,
  auditLogs,
  reviewItems,
  skus,
  spus,
  users,
  warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  approveStockDoc,
  createStockDoc,
  reverseStockDoc,
  submitStockDoc,
} from "@/server/modules/inventory/stock-doc";
import { createTestDb, type TestDb } from "../helpers/db";

describe("报废出库与风险处置闭环", () => {
  let db: TestDb;
  let creator: SessionUser;
  let approver: SessionUser;
  let skuId = 0;
  let skuCode = "";
  let warehouseId = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [creatorRow, approverRow] = await db
      .insert(users)
      .values([
        { name: "仓库制单", roles: ["warehouse"], isApprover: false },
        { name: "仓库审批", roles: ["warehouse"], isApprover: true },
      ])
      .returning();
    creator = {
      id: creatorRow.id,
      name: creatorRow.name,
      roles: ["warehouse"],
      isApprover: false,
    };
    approver = {
      id: approverRow.id,
      name: approverRow.name,
      roles: ["warehouse"],
      isApprover: true,
    };
    await db.insert(approvalConfigs).values([
      { docType: "opening", approverRole: "warehouse" },
      { docType: "stock_doc", approverRole: "warehouse" },
    ]);
    const [spu] = await db
      .insert(spus)
      .values({ code: "RISK-SPU", nameCn: "风险库存测试" })
      .returning();
    const [sku] = await db
      .insert(skus)
      .values({
        code: "RISK-SKU",
        name: "待报废产品",
        spuId: spu.id,
        skuType: "finished",
        baseUom: "件",
      })
      .returning();
    skuId = sku.id;
    skuCode = sku.code;
    const [warehouse] = await db
      .insert(warehouses)
      .values({ code: "RISK-WH", name: "报废测试仓", kind: "raw" })
      .returning();
    warehouseId = warehouse.id;

    const opening = await createStockDoc(
      creator,
      {
        subtype: "opening",
        warehouseId,
        lines: [{ skuId, qty: "10" }],
      },
      db,
    );
    const pending = await submitStockDoc(creator, opening.id, opening.version, db);
    await approveStockDoc(
      approver,
      pending.id,
      { action: "approve", version: pending.version },
      db,
    );
  });

  async function createDisposal(action = "报废评审") {
    const [item] = await db
      .insert(reviewItems)
      .values({
        category: "risk_disposal",
        refType: "sku",
        refKey: skuCode,
        title: `处置决定：${action} ${skuCode}`,
      })
      .returning();
    return item;
  }

  async function approveLinkedScrap(disposalId: number) {
    const draft = await createStockDoc(
      creator,
      {
        subtype: "issue_out",
        warehouseId,
        riskDisposalId: disposalId,
        remark: "风险库存报废处置",
        lines: [{ skuId, qty: "4" }],
      },
      db,
    );
    const pending = await submitStockDoc(creator, draft.id, draft.version, db);
    await approveStockDoc(
      approver,
      pending.id,
      { action: "approve", version: pending.version },
      db,
    );
    return draft;
  }

  it("绑定报废登记的出库审批过账后同事务自动完成；红字审批后重新打开", async () => {
    const disposal = await createDisposal();
    const scrap = await approveLinkedScrap(disposal.id);

    const [closed] = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.id, disposal.id));
    expect(closed).toMatchObject({
      status: "done",
      decidedBy: approver.id,
    });
    expect(closed.note).toContain(scrap.docNo);
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(and(
          eq(auditLogs.entity, "risk_disposal"),
          eq(auditLogs.action, "auto_close_after_scrap"),
        )),
    ).toHaveLength(1);

    const reversal = await reverseStockDoc(
      creator,
      scrap.id,
      { reason: "报废数量录错" },
      db,
    );
    const reversalPending = await submitStockDoc(
      creator,
      reversal.id,
      reversal.version,
      db,
    );
    await approveStockDoc(
      approver,
      reversalPending.id,
      { action: "approve", version: reversalPending.version },
      db,
    );

    const [reopened] = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.id, disposal.id));
    expect(reopened).toMatchObject({
      status: "open",
      decidedBy: null,
      decidedAt: null,
    });
    expect(reopened.note).toContain(reversal.docNo);
  });

  it("不允许绑定非报废决定、其他 SKU 或已关闭登记；普通出库不会误关登记", async () => {
    const disposal = await createDisposal();
    const unrelated = await createStockDoc(
      creator,
      {
        subtype: "issue_out",
        warehouseId,
        lines: [{ skuId, qty: "1" }],
      },
      db,
    );
    const unrelatedPending = await submitStockDoc(
      creator,
      unrelated.id,
      unrelated.version,
      db,
    );
    await approveStockDoc(
      approver,
      unrelatedPending.id,
      { action: "approve", version: unrelatedPending.version },
      db,
    );
    const [stillOpen] = await db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.id, disposal.id));
    expect(stillOpen.status).toBe("open");

    const nonScrap = await createDisposal("商务处置");
    await expect(
      createStockDoc(
        creator,
        {
          subtype: "issue_out",
          warehouseId,
          riskDisposalId: nonScrap.id,
          lines: [{ skuId, qty: "1" }],
        },
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });

    await db
      .update(reviewItems)
      .set({ status: "done" })
      .where(eq(reviewItems.id, disposal.id));
    await expect(approveLinkedScrap(disposal.id)).rejects.toMatchObject({ status: 409 });
  });
});
