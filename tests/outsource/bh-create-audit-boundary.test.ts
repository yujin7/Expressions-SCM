/**
 * 写路径审计**必须在同一事务边界**（CLAUDE.md）。
 *
 * 事故形态：`npd/service.createNpdFirstOrder` 先 `createBh(...)`（自带事务、事务内已提交），
 * 再在事务**之外** `writeAudit(db, { action: "first_order_draft" })`。
 * 审计那一步一失败（连接抖动、约束冲突、进程被杀），BH 草稿已经落库，
 * 留下一张没人知道从哪来的单——而 NPD 首单恰恰是最需要出处的那种单。
 *
 * 修法：`createBh` 提供 `hooks.inTx`，调用方把自己的审计写进同一事务；抛错即整单回滚。
 * 本文件钉两件事：钩子确实在事务内（抛错 → BH 一行都不留），以及 NPD 首单两条审计同事务成对出现。
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createBh } from "@/server/modules/outsource/bh";
import { createNpdFirstOrder } from "@/server/modules/npd/service";
import { createTestDb, type TestDb } from "../helpers/db";

describe("createBh 的 inTx 钩子：调用方审计与建单同事务", () => {
  let db: TestDb;
  let opsUser: SessionUser;
  let pmcUser: SessionUser;
  let skuId = 0;
  let projectId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const people = await db.insert(schema.users).values([
      { name: "运营", roles: ["ops"] },
      { name: "计划", roles: ["pmc"] },
    ]).returning();
    opsUser = { id: people[0].id, name: people[0].name, roles: ["ops"], isApprover: false };
    pmcUser = { id: people[1].id, name: people[1].name, roles: ["pmc"], isApprover: false };

    const [spu] = await db.insert(schema.spus).values({ code: "P40001", nameCn: "新品项目品" }).returning();
    const [sku] = await db.insert(schema.skus).values({
      code: "CP40001", name: "新品成品", spuId: spu.id, skuType: "finished", baseUom: "支", active: true,
    }).returning();
    skuId = sku.id;

    const [proj] = await db.insert(schema.npdProjects).values({
      name: "新品A 立项", skuCode: "CP40001", startDate: "2026-09-01", createdBy: pmcUser.id,
    }).returning();
    projectId = proj.id;
  });

  it("钩子抛错 → 整单回滚：bh_docs / bh_lines / audit_logs 一行都不留", async () => {
    const before = (await db.select().from(schema.bhDocs)).length;
    await expect(createBh(
      opsUser,
      { remark: "会被回滚", lines: [{ skuId, qty: "10" }] },
      db,
      { inTx: async () => { throw new Error("审计写失败"); } },
    )).rejects.toThrow("审计写失败");

    expect((await db.select().from(schema.bhDocs)).length).toBe(before);
    expect((await db.select().from(schema.bhLines)).length).toBe(0);
    expect((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "bh"))).length).toBe(0);
  });

  it("NPD 首单：BH 草稿与 first_order_draft 审计成对落库（同一事务）", async () => {
    const res = await createNpdFirstOrder(pmcUser, { projectId, qty: "500" }, db);
    expect(res.docNo.startsWith("BH")).toBe(true);

    const [doc] = await db.select().from(schema.bhDocs).where(eq(schema.bhDocs.id, res.id));
    expect(doc.status).toBe("draft"); // R13 人工闸：只出草稿，审批走正常流
    expect(doc.remark).toContain(`#${projectId}`);

    const bhAudit = await db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entity, "bh"), eq(schema.auditLogs.action, "create")));
    expect(bhAudit.length).toBe(1);

    const npdAudit = await db.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.entity, "npd_project"), eq(schema.auditLogs.action, "first_order_draft")));
    expect(npdAudit.length).toBe(1);
    expect(npdAudit[0].userId).toBe(pmcUser.id);
    expect(npdAudit[0].entityId).toBe(projectId);
    expect(npdAudit[0].after).toMatchObject({ docNo: res.docNo, skuCode: "CP40001", qty: "500" });
    // 同事务：两条审计 id 相邻，中间不可能夹进别的写
    expect(npdAudit[0].id).toBe(bhAudit[0].id + 1);
  });
});
