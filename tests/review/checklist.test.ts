import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { auditLogs, reviewItems } from "@/db/schema";
import type { DB } from "@/db";
import {
  bulkDecideReviewItems,
  countReviewItems,
  decideReviewItem,
  listReviewItems,
} from "@/server/modules/review/checklist";
import { createTestDb, type TestDb } from "../helpers/db";

const mocks = vi.hoisted(() => ({ guardRead: vi.fn(), db: null as unknown }));
vi.mock("@/db", async () => ({ getDbAsync: async () => mocks.db, schema: await import("@/db/schema") }));
vi.mock("@/server/modules/master/common", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/modules/master/common")>();
  return { ...original, guardRead: mocks.guardRead };
});
import { ApiError } from "@/server/modules/master/common";
import { GET } from "@/app/api/review/checklist/route";

describe("在案复核清单：列表/计数/改判/批量/角色门禁", () => {
  let db: TestDb;
  let dbx: DB;
  let client: { close: () => Promise<void>; exec: (query: string) => Promise<unknown> };
  let ids: number[] = [];
  const pmc = { id: 11, name: "PMC", roles: ["pmc"] };
  const ops = { id: 12, name: "运营", roles: ["ops"] };

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    mocks.db = db;
    mocks.guardRead.mockResolvedValue(pmc);
    dbx = db as unknown as DB;
    const rows = await db
      .insert(reviewItems)
      .values([
        { category: "spu_cluster", refType: "spu", refKey: "DEV001", title: "SPU 簇代决接受：DEV001", detail: "成员 1" },
        { category: "bom_version", refType: "bom", refKey: "N009-004", title: "BOM 歧义代决：N009-004", detail: "1 块" },
        { category: "segment", refType: "sku", refKey: "N032-0501", title: "物料代决分类为包材：N032-0501 中文标贴" },
        { category: "uncoded", title: "无编码物料待人工建档：收缩膜", detail: "出现 284 次" },
      ])
      .returning({ id: reviewItems.id });
    ids = rows.map((r) => r.id);
  });
  afterAll(async () => { await client.close(); });

  it("列表：类别/状态/关键字过滤", async () => {
    const all = await listReviewItems({ page: 1, pageSize: 10 }, dbx);
    expect(all.total).toBe(4);
    const cat = await listReviewItems({ category: "bom_version", page: 1, pageSize: 10 }, dbx);
    expect(cat.total).toBe(1);
    expect(cat.data[0].refKey).toBe("N009-004");
    const q = await listReviewItems({ q: "收缩膜", page: 1, pageSize: 10 }, dbx);
    expect(q.total).toBe(1);
    const none = await listReviewItems({ status: "done", page: 1, pageSize: 10 }, dbx);
    expect(none.total).toBe(0);
    // 非法类别值被忽略（不过滤）
    const bad = await listReviewItems({ category: "hacker", page: 1, pageSize: 10 }, dbx);
    expect(bad.total).toBe(4);
  });

  it("单条通过/改判/重开 + 审计", async () => {
    const done = await decideReviewItem(pmc, ids[0], { status: "done" }, dbx);
    expect(done.status).toBe("done");
    expect(done.decidedBy).toBe(pmc.id);
    expect(done.decidedAt).not.toBeNull();

    const over = await decideReviewItem(pmc, ids[1], { status: "overruled", note: "版本取错，应取首块" }, dbx);
    expect(over.status).toBe("overruled");
    expect(over.note).toBe("版本取错，应取首块");

    const reopened = await decideReviewItem(pmc, ids[0], { status: "open" }, dbx);
    expect(reopened.status).toBe("open");
    expect(reopened.decidedBy).toBeNull();
    expect(reopened.decidedAt).toBeNull();

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "review_item"));
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["review_done", "review_overrule", "review_reopen"]),
    );
  });

  it("计数按类别×状态分组", async () => {
    const { counts } = await countReviewItems(dbx);
    const bomOverruled = counts.find((c) => c.category === "bom_version" && c.status === "overruled");
    expect(bomOverruled?.count).toBe(1);
    const spuOpen = counts.find((c) => c.category === "spu_cluster" && c.status === "open");
    expect(spuOpen?.count).toBe(1);
  });

  it("批量通过 + 审计（按批 1 行）", async () => {
    const res = await bulkDecideReviewItems(pmc, { ids: [ids[2], ids[3]], status: "done" }, dbx);
    expect(res.updated).toBe(2);
    const rows = await listReviewItems({ status: "done", page: 1, pageSize: 10 }, dbx);
    expect(rows.total).toBe(2);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "review_bulk"));
    expect(audits).toHaveLength(1);
  });

  it("角色门禁：运营无决策权（403）；不存在的项 404", async () => {
    await expect(decideReviewItem(ops, ids[0], { status: "done" }, dbx)).rejects.toThrow(/无权限/);
    await expect(bulkDecideReviewItems(ops, { ids: [ids[0]], status: "done" }, dbx)).rejects.toThrow(/无权限/);
    await expect(decideReviewItem(pmc, 999999, { status: "done" }, dbx)).rejects.toThrow(/不存在/);
    await expect(decideReviewItem(pmc, ids[0], { status: "deleted" }, dbx)).rejects.toThrow();
  });

  it("精确 ID 忽略陈旧状态/类别/搜索/页码，但只返回该条", async () => {
    const [target] = await db.insert(reviewItems).values({
      category: "bom_version", title: "已改判的精确目标", status: "overruled", note: "保留历史意见",
    }).returning();
    const filter = { id: target.id, status: "open", category: "uncoded", q: "不匹配的旧搜索", page: 99, pageSize: 1 };
    const result = await listReviewItems(filter, dbx);
    expect(result.total).toBe(1);
    expect(result.data.map((r) => r.id)).toEqual([target.id]);
    expect(result.data[0]).toMatchObject({ status: "overruled", note: "保留历史意见" });
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(filter).map(([k, v]) => [k, String(v)])));
    const response = await GET(new NextRequest(`http://localhost/api/review/checklist?${qs}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.data.map((r: { id: number }) => r.id)).toEqual([target.id]);
  });

  it("精确 ID 不存在时不会回落到全列表", async () => {
    const result = await listReviewItems({ id: 2_147_483_647, page: 99, pageSize: 10 }, dbx);
    expect(result).toEqual({ data: [], total: 0 });
  });

  it.each([0, -1, 1.2, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, Number.MAX_SAFE_INTEGER])("service 拒绝非法 ID %s", async (id) => {
    await expect(listReviewItems({ id, page: 1, pageSize: 10 }, dbx)).rejects.toThrow();
  });

  it.each(["", " ", "0", "-1", "+1", "01", "1.0", "1e2", "0x10", "NaN", "2147483648", "https://example.com"])("HTTP 对非法精确 ID %j 返回 400", async (id) => {
    const response = await GET(new NextRequest(`http://localhost/api/review/checklist?${new URLSearchParams({ id })}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
  });

  it("精确 ID 不能绕过认证守卫", async () => {
    mocks.guardRead.mockRejectedValueOnce(new ApiError(401, "未登录"));
    const response = await GET(new NextRequest(`http://localhost/api/review/checklist?id=${ids[0]}`));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "未登录" });
  });

  it("单条与批量改判：审计插入失败必须回滚状态、备注和裁决人", async () => {
    // Deliberate database failure, not a mocked writeAudit: exercise the actual transaction
    // boundary. The trigger is limited to this test actor and this isolated in-memory DB.
    await client.exec(`
      CREATE FUNCTION reject_review_audit_test() RETURNS trigger AS $$
      BEGIN
        IF NEW.user_id = 9191 AND NEW.entity = 'review_item' THEN
          RAISE EXCEPTION 'review audit intentionally rejected';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_review_audit_test BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_review_audit_test();
    `);
    const targets = await db.insert(reviewItems).values([
      { category: "other", title: "单条审计回滚夹具", note: "原始备注1" },
      { category: "other", title: "批量审计回滚夹具1", note: "原始备注2" },
      { category: "other", title: "批量审计回滚夹具2", note: "原始备注3" },
    ]).returning();
    const faultActor = { id: 9191, name: "审计故障夹具", roles: ["pmc"] };
    await expect(decideReviewItem(faultActor, targets[0].id, {
      status: "done", note: "这条备注不得持久化",
    }, dbx)).rejects.toThrow();
    await expect(bulkDecideReviewItems(faultActor, {
      ids: targets.slice(1).map((r) => r.id), status: "overruled", note: "批量备注不得持久化",
    }, dbx)).rejects.toThrow();
    const rows = await db.select().from(reviewItems).where(inArray(reviewItems.id, targets.map((r) => r.id))).orderBy(reviewItems.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => ({ status: r.status, note: r.note, decidedBy: r.decidedBy, decidedAt: r.decidedAt }))).toEqual(
      targets.map((r) => ({ status: "open", note: r.note, decidedBy: null, decidedAt: null })),
    );
    expect(await db.select().from(auditLogs).where(eq(auditLogs.userId, faultActor.id))).toEqual([]);
  });
});
