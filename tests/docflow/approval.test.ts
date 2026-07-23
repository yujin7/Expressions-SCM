import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { approvalConfigs, approvals, bhDocs, users } from "@/db/schema";
import { ApprovalError, approveDoc, type Approver } from "@/server/docflow/approval";
import { nextDocNo } from "@/server/docflow/doc-no";
import { createTestDb, type TestDb } from "../helpers/db";

describe("通用单级审批 approveDoc（§6 + R10）", () => {
  let db: TestDb;
  let creatorId: number;
  let approverId: number;
  let pmcApprover: Approver;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [creator] = await db
      .insert(users)
      .values({ name: "运营制单员", roles: ["ops"] })
      .returning();
    const [approver] = await db
      .insert(users)
      .values({ name: "PMC审批人", roles: ["pmc"], isApprover: true })
      .returning();
    creatorId = creator.id;
    approverId = approver.id;
    pmcApprover = { id: approverId, roles: ["pmc"], isApprover: true };
    await db.insert(approvalConfigs).values({ docType: "bh", approverRole: "pmc" });
  });

  /** 造一张待审批 BH 单（先落 draft 再置 pending，模拟提交动作） */
  async function makePendingBh(): Promise<{ id: number; version: number }> {
    const [doc] = await db
      .insert(bhDocs)
      .values({ docNo: await nextDocNo(db, "BH"), createdBy: creatorId, purpose: "测试" })
      .returning();
    await db.update(bhDocs).set({ status: "pending" }).where(eq(bhDocs.id, doc.id));
    return { id: doc.id, version: doc.version };
  }

  function approvalRows(docId: number) {
    return db
      .select()
      .from(approvals)
      .where(and(eq(approvals.docType, "bh"), eq(approvals.docId, docId)));
  }

  it("正常路径：approve → approved，写审批记录，版本+1", async () => {
    const doc = await makePendingBh();
    const r = await approveDoc(db, {
      docType: "bh",
      table: bhDocs,
      docId: doc.id,
      approver: pmcApprover,
      action: "approve",
      comment: "同意",
      expectedVersion: doc.version,
    });
    expect(r).toEqual({ status: "approved", idempotent: false });

    const [row] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(row.status).toBe("approved");
    expect(row.version).toBe(doc.version + 1);

    const logs = await approvalRows(doc.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      node: 1,
      approverId,
      action: "approve",
      comment: "同意",
    });
  });

  it("角色不符 → ROLE_FORBIDDEN", async () => {
    const doc = await makePendingBh();
    await expect(
      approveDoc(db, {
        docType: "bh",
        table: bhDocs,
        docId: doc.id,
        approver: { id: approverId, roles: ["warehouse"], isApprover: true },
        action: "approve",
        expectedVersion: doc.version,
      }),
    ).rejects.toMatchObject({ name: "ApprovalError", code: "ROLE_FORBIDDEN" });
  });

  it("is_approver=false → NOT_APPROVER", async () => {
    const doc = await makePendingBh();
    await expect(
      approveDoc(db, {
        docType: "bh",
        table: bhDocs,
        docId: doc.id,
        approver: { id: approverId, roles: ["pmc"], isApprover: false },
        action: "approve",
        expectedVersion: doc.version,
      }),
    ).rejects.toMatchObject({ code: "NOT_APPROVER" });
  });

  it("管理员兜底：无需 pmc 角色、is_approver=false 也可审批", async () => {
    const doc = await makePendingBh();
    const r = await approveDoc(db, {
      docType: "bh",
      table: bhDocs,
      docId: doc.id,
      approver: { id: approverId, roles: ["admin"], isApprover: false },
      action: "approve",
      expectedVersion: doc.version,
    });
    expect(r.status).toBe("approved");
  });

  it("职责分离：审批人=制单人 → SELF_APPROVAL（即使是管理员）", async () => {
    const doc = await makePendingBh();
    await expect(
      approveDoc(db, {
        docType: "bh",
        table: bhDocs,
        docId: doc.id,
        approver: { id: creatorId, roles: ["pmc", "admin"], isApprover: true },
        action: "approve",
        expectedVersion: doc.version,
      }),
    ).rejects.toMatchObject({ code: "SELF_APPROVAL" });
    expect(await approvalRows(doc.id)).toHaveLength(0);
  });

  it("重复审批幂等：第二次返回 idempotent:true，不写重复行，状态不变（优先于版本冲突）", async () => {
    const doc = await makePendingBh();
    const input = {
      docType: "bh",
      table: bhDocs,
      docId: doc.id,
      approver: pmcApprover,
      action: "approve" as const,
      expectedVersion: doc.version, // 第二次已过期，但幂等优先（R10）
    };
    const first = await approveDoc(db, input);
    expect(first.idempotent).toBe(false);

    const second = await approveDoc(db, input);
    expect(second).toEqual({ status: "approved", idempotent: true });

    expect(await approvalRows(doc.id)).toHaveLength(1);
    const [row] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(row.status).toBe("approved");
    expect(row.version).toBe(doc.version + 1); // 未再次+1
  });

  it("过期 expectedVersion → VERSION_CONFLICT，且整个事务回滚（不留审批行）", async () => {
    const doc = await makePendingBh();
    await expect(
      approveDoc(db, {
        docType: "bh",
        table: bhDocs,
        docId: doc.id,
        approver: pmcApprover,
        action: "approve",
        expectedVersion: doc.version + 99,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    const [row] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(row.status).toBe("pending"); // 回滚
    expect(await approvalRows(doc.id)).toHaveLength(0); // 审批行也回滚
  });

  it("驳回：reject → 状态回 draft", async () => {
    const doc = await makePendingBh();
    const r = await approveDoc(db, {
      docType: "bh",
      table: bhDocs,
      docId: doc.id,
      approver: pmcApprover,
      action: "reject",
      comment: "数量有误",
      expectedVersion: doc.version,
    });
    expect(r).toEqual({ status: "draft", idempotent: false });
    const [row] = await db.select().from(bhDocs).where(eq(bhDocs.id, doc.id));
    expect(row.status).toBe("draft");
  });

  it("非 pending 状态（draft）→ BAD_STATUS", async () => {
    const [doc] = await db
      .insert(bhDocs)
      .values({ docNo: await nextDocNo(db, "BH"), createdBy: creatorId })
      .returning(); // 仍是 draft
    await expect(
      approveDoc(db, {
        docType: "bh",
        table: bhDocs,
        docId: doc.id,
        approver: pmcApprover,
        action: "approve",
        expectedVersion: doc.version,
      }),
    ).rejects.toMatchObject({ code: "BAD_STATUS" });
  });

  it("无审批配置的单据类型 → NO_CONFIG", async () => {
    const doc = await makePendingBh();
    await expect(
      approveDoc(db, {
        docType: "zz",
        table: bhDocs,
        docId: doc.id,
        approver: pmcApprover,
        action: "approve",
        expectedVersion: doc.version,
      }),
    ).rejects.toMatchObject({ code: "NO_CONFIG" });
  });

  it("单据不存在 → NOT_FOUND", async () => {
    await expect(
      approveDoc(db, {
        docType: "bh",
        table: bhDocs,
        docId: 999999,
        approver: pmcApprover,
        action: "approve",
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("错误均为 ApprovalError 实例", async () => {
    const doc = await makePendingBh();
    try {
      await approveDoc(db, {
        docType: "bh",
        table: bhDocs,
        docId: doc.id,
        approver: { id: creatorId, roles: ["pmc"], isApprover: true },
        action: "approve",
        expectedVersion: doc.version,
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApprovalError);
    }
  });
});
