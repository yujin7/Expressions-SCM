/**
 * S6（2026-09-04 安全审计）：站内通知的已读状态必须是**逐收件人**的。
 *
 * 事故形态：已读是 `notifications.read_at` 这一个列，而 `user_id` / `target_role` 都可空，
 * 且 `notifyAudienceWhere` 对 admin 返回 undefined（＝不加任何条件）。于是
 * 管理员点一次「全部已读」执行的是
 * `UPDATE notifications SET read_at = now() WHERE read_at IS NULL`——
 * 一次点击把**全公司每个人**的未读队列清空，包括定向给某个人、他还从没看到过的那些；
 * 传单个 `{id}` 则能把任意一个人的某条通知标成已读。
 * 非管理员也一样：广播行是共享的，谁先读谁就替所有人读了。
 *
 * 为什么选「逐收件人已读表」而不是「把 UPDATE 收窄到 user_id = 自己」：
 * 后者能堵住越权，却让广播与角色定向的通知**永远无法标已读**——未读徽标从此归不了零，
 * 正是本仓反复吃过亏的「用户学会无视徽标」那条路（见 core/notify-audience 的事故说明）。
 */
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { notificationReads, notifications, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { getFreshSessionUser, getSessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

const mocks = vi.hoisted(() => ({ db: null as unknown, session: null as unknown }));
vi.mock("@/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/db")>();
  return { ...original, getDbAsync: vi.fn(async () => mocks.db) };
});
vi.mock("@/server/core/dto", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/core/dto")>();
  return {
    ...original,
    getSessionUser: vi.fn(async () => mocks.session),
    getFreshSessionUser: vi.fn(async () => mocks.session),
  };
});

const { GET, POST } = await import("@/app/api/notifications/route");

let db: TestDb;
let admin: SessionUser;
let pmc: SessionUser;
let ops: SessionUser;

beforeEach(async () => {
  ({ db } = await createTestDb());
  mocks.db = db;
  const rows = await db.insert(users).values([
    { name: "管理员", roles: ["admin"], isApprover: true },
    { name: "计划员", roles: ["pmc"], isApprover: false },
    { name: "运营", roles: ["ops"], isApprover: false },
  ]).returning();
  admin = { id: rows[0].id, name: rows[0].name, roles: ["admin"], isApprover: true };
  pmc = { id: rows[1].id, name: rows[1].name, roles: ["pmc"], isApprover: false };
  ops = { id: rows[2].id, name: rows[2].name, roles: ["ops"], isApprover: false };

  await db.insert(notifications).values([
    // 广播（所有人可见）
    { channel: "in_app", title: "广播：系统维护", body: "x", status: "sent", dedupeKey: "b1" },
    // 角色定向 pmc
    { channel: "in_app", title: "定向 pmc：断货预警", body: "x", status: "sent", targetRole: "pmc", dedupeKey: "b2" },
    // 定向个人 pmc
    { channel: "in_app", title: "定向个人：待你签认", body: "x", status: "sent", userId: rows[1].id, dedupeKey: "b3" },
  ]);
});

const as = (user: SessionUser) => { mocks.session = user; };
const list = async () => (await GET(new NextRequest("http://localhost/api/notifications"))).json() as Promise<{
  rows: { id: number; title: string; readAt: string | null }[];
  unread: number;
  total: number;
}>;
const markAll = () =>
  POST(new NextRequest("http://localhost/api/notifications", { method: "POST", body: JSON.stringify({ all: true }) }));
const markOne = (id: unknown) =>
  POST(new NextRequest("http://localhost/api/notifications", { method: "POST", body: JSON.stringify({ id }) }));

describe("S6 通知已读：一个人读完不再影响别人", () => {
  it("reads current identity instead of a stale admin session", async () => {
    as(pmc);
    const [privateNotice] = await db.insert(notifications).values({ channel: "in_app", title: "仅运营可读", body: "x", userId: ops.id }).returning();
    vi.mocked(getSessionUser).mockResolvedValueOnce(admin);
    const before = vi.mocked(getFreshSessionUser).mock.calls.length;
    expect((await list()).rows.some(r => r.id === privateNotice.id)).toBe(false);
    expect(vi.mocked(getFreshSessionUser).mock.calls.length).toBe(before + 1);
    vi.mocked(getSessionUser).mockReset().mockImplementation(async () => mocks.session as SessionUser);
  });
  it("pending and sending remain readable and markable for their recipient only", async () => {
    const [notice] = await db.insert(notifications).values({ channel: "in_app", title: "合成投递中的消息", body: "无需等待飞书", status: "pending", userId: pmc.id }).returning();
    as(pmc);
    expect((await list()).rows.some(r => r.id === notice.id)).toBe(true);
    await db.update(notifications).set({ status: "sending", dispatchStartedAt: new Date() }).where(eq(notifications.id, notice.id));
    expect((await list()).rows.some(r => r.id === notice.id), "dispatch must not make an already visible message disappear").toBe(true);
    expect((await list()).unread).toBe(4);
    expect((await (await markOne(notice.id)).json()).marked).toBe(1);
    expect((await list()).rows.find(r => r.id === notice.id)?.readAt).not.toBeNull();
    as(ops); expect((await list()).rows.some(r => r.id === notice.id)).toBe(false);
  });

  it("rejects invalid or repeated read/severity filters instead of returning an unfiltered answer", async () => {
    as(pmc);
    for (const q of ["read=bad", "read=read&read=unread", "severity=bad", "severity=high&severity=info"]) {
      expect((await GET(new NextRequest(`http://localhost/api/notifications?${q}`))).status, q).toBe(400);
    }
  });

  it("rolls back recipient reads if the retention-field update fails", async () => {
    as(pmc);
    await db.execute(`CREATE FUNCTION qa_reject_notice_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic notification update failure'; END; $$`);
    await db.execute(`CREATE TRIGGER qa_reject_notice_update BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION qa_reject_notice_update()`);
    try {
      expect((await markAll()).status).toBe(500);
      expect(await db.select().from(notificationReads), "both effects must roll back together").toHaveLength(0);
    } finally {
      await db.execute(`DROP TRIGGER qa_reject_notice_update ON notifications`);
      await db.execute(`DROP FUNCTION qa_reject_notice_update()`);
    }
    expect((await markAll()).status).toBe(200);
    expect((await list()).unread).toBe(0);
  });

  it("管理员「全部已读」不再清空所有人的未读队列", async () => {
    as(admin);
    expect((await list()).unread, "admin 全见：三条都是未读").toBe(3);
    await markAll();
    expect((await list()).unread).toBe(0);

    as(pmc);
    const mine = await list();
    expect(mine.unread, "admin 读过 ≠ 计划员读过；三条对 pmc 全部仍是未读").toBe(3);
    expect(mine.rows.every((r) => r.readAt === null)).toBe(true);

    as(ops);
    expect((await list()).unread, "运营只看得到广播那一条，且仍未读").toBe(1);
  });

  it("非管理员标已读不再替所有人读掉共享的广播行", async () => {
    as(pmc);
    await markAll();
    expect((await list()).unread).toBe(0);

    as(ops);
    expect((await list()).unread, "广播行对运营仍是未读").toBe(1);
    as(admin);
    expect((await list()).unread, "admin 自己的未读也不受影响").toBe(3);
  });

  it("单条已读只写自己的一行：管理员标 pmc 的定向通知，pmc 那边仍是未读", async () => {
    const [personal] = await db.select().from(notifications).where(eq(notifications.dedupeKey, "b3"));
    as(admin);
    await markOne(personal.id);
    as(pmc);
    const mine = await list();
    expect(mine.rows.find((r) => r.id === personal.id)!.readAt, "别人读过不算我读过").toBeNull();
    expect(mine.unread).toBe(3);
    const reads = await db.select().from(notificationReads).where(eq(notificationReads.notificationId, personal.id));
    expect(reads.map((r) => r.userId), "已读关系落在「人×通知」上").toEqual([admin.id]);
  });

  it("看不见的通知标不了已读（这个端点不能变成探测别人通知 id 的口子）", async () => {
    const [pmcOnly] = await db.select().from(notifications).where(eq(notifications.dedupeKey, "b2"));
    as(ops);
    const res = await markOne(pmcOnly.id);
    expect(res.status).toBe(200);
    expect((await res.json()).marked).toBe(0);
    expect(await db.select().from(notificationReads)).toHaveLength(0);
  });

  it("自己标已读后，列表筛选与未读数一致（徽标能归零，不是永远归不了零）", async () => {
    as(pmc);
    await markAll();
    const after = await list();
    expect(after.unread).toBe(0);
    expect(after.rows.every((r) => r.readAt !== null), "readAt 下发的是我自己的已读时刻").toBe(true);

    const readOnly = await (await GET(new NextRequest("http://localhost/api/notifications?read=read"))).json();
    expect(readOnly.total).toBe(3);
    const unreadOnly = await (await GET(new NextRequest("http://localhost/api/notifications?read=unread"))).json();
    expect(unreadOnly.total).toBe(0);
  });

  it("入参校验：非数字 id 是 400，不是 500（坏参数不该污染 error_logs）", async () => {
    as(pmc);
    for (const body of [{ id: "abc" }, { id: -1 }, {}, { all: false }, { id: 1.5 }, { all: true, id: 1 }, { all: true, userId: ops.id }]) {
      const res = await POST(new NextRequest("http://localhost/api/notifications", {
        method: "POST", body: JSON.stringify(body),
      }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("keeps recipient-specific responses out of shared caches and reports only newly inserted reads", async () => {
    as(pmc);
    const response = await GET(new NextRequest("http://localhost/api/notifications"));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { rows } = await response.json();
    expect((await (await markOne(rows[0].id)).json()).marked).toBe(1);
    expect((await (await markOne(rows[0].id)).json()).marked).toBe(0);
    expect((await (await markAll()).json()).marked).toBe(2);
    expect((await (await markAll()).json()).marked).toBe(0);
  });

  it("保留期判定仍能用：唯一收件人自己读时同步写行级 read_at，且只写自己那一行", async () => {
    as(pmc);
    await markAll();
    const rows = await db.select().from(notifications).orderBy(asc(notifications.id));
    const personal = rows.find((r) => r.dedupeKey === "b3")!;
    expect(personal.readAt, "userId 非空＝唯一收件人，housekeeping 的分档依赖这个列").not.toBeNull();
    expect(rows.find((r) => r.dedupeKey === "b1")!.readAt, "广播行归属不明，不得写行级 read_at").toBeNull();
    expect(rows.find((r) => r.dedupeKey === "b2")!.readAt, "角色定向行同理").toBeNull();
  });
});
