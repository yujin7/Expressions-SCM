/**
 * W2 代决清单在应用内导入（review/checklist.importReviewChecklist）。
 *
 * 背景：`/review/checklist` 的空态此前写着「请管理员运行 seed-review-items 脚本」——
 * 一个用户在应用里**永远做不到**的动作（要 SSH、要停 dev server、要先把 md 放到机器上）。
 * 于是这页对所有实际使用者都是一张只读空页。
 *
 * 本文件钉住：仅管理员、按 title 幂等（可反复导入）、同事务写审计、
 * 以及"只导入不生成"——输入里没有的行不会凭空出现。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogs, reviewItems, users } from "@/db/schema";
import { importReviewChecklist, REVIEW_IMPORT_MAX_CHARS } from "@/server/modules/review/checklist";
import type { DB } from "@/db";
import { createTestDb, type TestDb } from "../helpers/db";

const MD = [
  "# 复核清单",
  "",
  "## 主轮",
  "- SPU 簇代决：N006-001（同名两簇合并）——待业务确认",
  "- BOM 歧义代决：DEV005-000-0301（两版本并存，取最新）",
  "- 物料代决分类：N02-032（按包材归类）",
  "- 无编码物料：某供应商赠品",
  "正文行不算条目",
].join("\n");

describe("代决清单导入", () => {
  let db: TestDb;
  let dbx: DB;
  let admin: { id: number; name: string; roles: string[] };
  let pmc: { id: number; name: string; roles: string[] };

  beforeEach(async () => {
    ({ db } = await createTestDb());
    dbx = db as unknown as DB;
    const [a] = await db.insert(users).values({ name: "管理员", roles: ["admin"], isApprover: true }).returning();
    const [p] = await db.insert(users).values({ name: "计划员", roles: ["pmc"], isApprover: false }).returning();
    admin = { id: a.id, name: a.name, roles: ["admin"] };
    pmc = { id: p.id, name: p.name, roles: ["pmc"] };
  });

  it("仅管理员：有裁决权的 PMC 也不能往清单里塞事项", async () => {
    await expect(importReviewChecklist(pmc, { markdown: MD }, dbx)).rejects.toThrow(/仅限管理员/);
    expect(await db.select().from(reviewItems)).toHaveLength(0);
  });

  it("按前缀归类落库，正文行不成为复核项（只导入，不生成）", async () => {
    const res = await importReviewChecklist(admin, { markdown: MD, source: "复核清单-2026-07-24.md" }, dbx);
    expect(res.parsed).toBe(4);
    expect(res.inserted).toBe(4);
    expect(res.skipped).toBe(0);

    const rows = await db.select().from(reviewItems);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.category).sort()).toEqual(["bom_version", "segment", "spu_cluster", "uncoded"]);
    expect(rows.every((r) => r.status === "open")).toBe(true);
    expect(rows.find((r) => r.category === "spu_cluster")?.refKey).toBe("N006-001");
    // 正文行没有变成 category=other 的垃圾行
    expect(rows.some((r) => r.title.includes("正文行"))).toBe(false);
  });

  it("按 title 幂等：重复导入不产生重复行", async () => {
    await importReviewChecklist(admin, { markdown: MD }, dbx);
    const again = await importReviewChecklist(admin, { markdown: MD }, dbx);
    expect(again.parsed).toBe(4);
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(4);
    expect(await db.select().from(reviewItems)).toHaveLength(4);
  });

  it("同事务写审计：谁导的、导了多少、来源标签（脚本一行审计都不写）", async () => {
    await importReviewChecklist(admin, { markdown: MD, source: "复核清单-2026-07-24.md" }, dbx);
    const audits = await db.select().from(auditLogs)
      .where(and(eq(auditLogs.entity, "review_item"), eq(auditLogs.action, "review_import")));
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(admin.id);
    expect(audits[0].after).toMatchObject({
      source: "复核清单-2026-07-24.md",
      parsed: 4,
      inserted: 4,
      skipped: 0,
    });
  });

  it("解析不出条目就明确报错，不静默写 0 行让人以为成功了", async () => {
    await expect(importReviewChecklist(admin, { markdown: "只有正文，没有条目行" }, dbx))
      .rejects.toThrow(/未解析出任何代决条目/);
  });

  it("有大小上限：不接受把几十 MB 贴进请求体", async () => {
    const huge = `- SPU 簇代决：N006-001\n${"x".repeat(REVIEW_IMPORT_MAX_CHARS)}`;
    await expect(importReviewChecklist(admin, { markdown: huge }, dbx)).rejects.toThrow();
  });
});

describe("页面：空态不再指向一个用户做不到的动作", () => {
  const client = readFileSync(
    path.join(process.cwd(), "src/app/(app)/review/checklist/checklist-client.tsx"),
    "utf8",
  );

  it("空态文案不再叫人去跑 seed-review-items 脚本", () => {
    expect(client).not.toContain("seed-review-items");
    expect(client).toContain("导入代决清单");
  });

  it("导入入口按管理员可见，且与服务端 REVIEW_IMPORT_ROLES 同口径", () => {
    expect(client).toMatch(/const canImport = me\?\.roles\?\.includes\("admin"\) === true/);
    expect(client).toContain('"/api/review/checklist/import"');
  });
});
