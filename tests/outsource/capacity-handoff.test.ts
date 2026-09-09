import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { getCapacityCheck } from "@/server/modules/outsource/capacity-check";
import { attachCapacityCheck } from "@/server/modules/outsource/capacity-handoff";
import { listWorkItemHistory } from "@/server/modules/todo/history";
import { GET, POST } from "@/app/api/outsource/sourcing-aid/route";
import { createTestDb, type TestDb } from "../helpers/db";

const deps = vi.hoisted(() => ({ db: vi.fn(), user: vi.fn(), fail: false }));
vi.mock("@/db", async original => ({ ...await original<typeof import("@/db")>(), getDbAsync: deps.db }));
vi.mock("@/server/core/dto", async original => ({ ...await original<typeof import("@/server/core/dto")>(), getFreshSessionUser: deps.user }));
vi.mock("@/server/core/audit", async original => {
  const actual = await original<typeof import("@/server/core/audit")>();
  return { ...actual, writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
    await actual.writeAudit(...args); if (deps.fail) throw new Error("synthetic capacity audit failure");
  } };
});
let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"];
let actor: SessionUser, stranger: SessionUser, factoryId: number;
beforeAll(async () => {
  ({ db, client } = await createTestDb()); deps.db.mockResolvedValue(db);
  const people = await db.insert(schema.users).values([{ name: "合成计划员", roles: ["pmc"] }, { name: "合成仓管", roles: ["warehouse"] }]).returning();
  [actor, stranger] = people.map(u => ({ id: u.id, name: u.name, roles: u.roles as SessionUser["roles"], isApprover: false }));
  const [factory] = await db.insert(schema.suppliers).values({ code: "CAP-HANDOFF", name: "合成加工厂", kinds: ["processor"], status: "qualified",
    declaredMonthlyCapacity: "1000", capacityUom: "支", surgeCapacityPct: 20, capacityValidFrom: "2020-01-01", capacityValidUntil: "2099-12-31", capacityEvidence: "合成签认依据" }).returning();
  factoryId = factory.id;
});
afterAll(async () => client?.close());
async function fixture(category = "inventory_cover") {
  const key = randomUUID();
  const [spu] = await db.insert(schema.spus).values({ code: `CAP-SPU-${key}`, nameCn: "合成产能产品" }).returning();
  const [sku] = await db.insert(schema.skus).values({ code: `CAP-${key}`, name: "合成精华", skuType: "finished", baseUom: "支", spuId: spu.id }).returning();
  const [alert] = await db.insert(schema.systemAlerts).values({ category, title: "合成需核对产能", status: "open",
    dedupeKey: category === "inventory_cover" ? `inventory_cover:${sku.id}` : `sales_spike:sku:${sku.id}`,
    detail: "店铺 合成不可见店；数量仅供观察", lastHitAt: new Date("2026-09-09T00:00:00Z") }).returning();
  const [item] = await db.insert(schema.workItems).values({ title: "合成来源待办", assigneeId: actor.id, assignerId: actor.id, createdBy: actor.id,
    status: "open", sourceKind: "alert", sourceRef: String(alert.id) }).returning();
  const query = { skuId: sku.id, alertId: alert.id, supplierId: factoryId, dueDate: "2090-09-20", candidateQty: "1200.0001" };
  const check = await getCapacityCheck(actor, query, db);
  const input = { ...query, workItemId: item.id, assigneeId: actor.id, evidenceKey: check.evidenceKey!, requestId: randomUUID(), note: "请核实额外产能和书面交期" };
  return { sku, alert, item, query, check, input };
}

it("binds source, manual scenario, actual owner and server-derived evidence, without changing business state", async () => {
  const f = await fixture();
  expect(f.check.handoff?.items).toEqual([expect.objectContaining({ id: f.item.id, assigneeId: actor.id })]);
  const before = await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, f.alert.id));
  const result = await attachCapacityCheck(f.input, actor, db);
  expect(result).toMatchObject({ itemId: f.item.id, replayed: false });
  expect((await db.select().from(schema.workItems).where(eq(schema.workItems.id, f.item.id)))[0]).toEqual(f.item);
  expect(await db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, f.alert.id))).toEqual(before);
  const [event] = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.id, result.eventId));
  expect(event.after).toMatchObject({ capacity: { skuId: f.sku.id, alertId: f.alert.id, assigneeId: actor.id,
    scenario: { candidateQty: "1200.0001", signal: { scheduledQty: "0.0000", projectedQty: "1200.0001", advisoryOnly: true } } } });
  expect(event.isStateChange).toBe(false);
  const history = await listWorkItemHistory(f.item.id, {}, actor, db);
  expect(history.rows[0]).toMatchObject({ action: "capacity_check", requestId: f.input.requestId });
  expect(history.rows[0].note).toContain("合成签认依据");
  expect(history.rows[0].note).toContain("请核实额外产能和书面交期");
  for (const table of [schema.stockLedger, schema.jgDocs, schema.notifications]) expect(await db.select().from(table)).toHaveLength(0);
});
it("same request replays the same receipt even after the source later closes; altered content conflicts", async () => {
  const f = await fixture(); const first = await attachCapacityCheck(f.input, actor, db);
  await db.update(schema.systemAlerts).set({ status: "resolved" }).where(eq(schema.systemAlerts.id, f.alert.id));
  expect(await attachCapacityCheck(f.input, actor, db)).toEqual({ ...first, replayed: true });
  await expect(attachCapacityCheck({ ...f.input, note: "不能替换之前的核对内容" }, actor, db)).rejects.toMatchObject({ status: 409 });
  expect((await listWorkItemHistory(f.item.id, {}, actor, db)).rows).toHaveLength(1);
});
it("stale source or supplier declarations refuse saving until a fresh scenario is reviewed", async () => {
  const f = await fixture();
  await db.update(schema.systemAlerts).set({ detail: "新事实" }).where(eq(schema.systemAlerts.id, f.alert.id));
  await expect(attachCapacityCheck(f.input, actor, db)).rejects.toMatchObject({ status: 409 });
  const refreshed = await getCapacityCheck(actor, f.query, db);
  await db.update(schema.suppliers).set({ capacityEvidence: "变化后的合成协议" }).where(eq(schema.suppliers.id, factoryId));
  await expect(attachCapacityCheck({ ...f.input, evidenceKey: refreshed.evidenceKey }, actor, db)).rejects.toMatchObject({ status: 409 });
  expect((await listWorkItemHistory(f.item.id, {}, actor, db)).rows).toHaveLength(0);
});
it("refuses a different task source, reassigned/closed task or inactive owner without guessing assignments", async () => {
  const f = await fixture(), other = await fixture();
  await expect(attachCapacityCheck({ ...f.input, workItemId: other.item.id }, actor, db)).rejects.toMatchObject({ status: 409 });
  await db.update(schema.workItems).set({ assigneeId: stranger.id }).where(eq(schema.workItems.id, f.item.id));
  await expect(attachCapacityCheck(f.input, actor, db)).rejects.toMatchObject({ status: 409 });
  expect((await getCapacityCheck(actor, f.query, db)).handoff?.items).toEqual([]);
  await expect(attachCapacityCheck({ ...f.input, assigneeId: stranger.id }, actor, db)).rejects.toMatchObject({ status: 409 });
  await db.update(schema.workItems).set({ status: "done", completedAt: new Date(), assigneeId: actor.id }).where(eq(schema.workItems.id, f.item.id));
  await expect(attachCapacityCheck(f.input, actor, db)).rejects.toMatchObject({ status: 409 });
  const empty = await getCapacityCheck(actor, f.query, db); expect(empty.handoff?.items).toEqual([]);
  await db.update(schema.workItems).set({ status: "open", completedAt: null }).where(eq(schema.workItems.id, f.item.id));
  await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, actor.id));
  try { await expect(attachCapacityCheck(f.input, actor, db)).rejects.toMatchObject({ status: 409 }); }
  finally { await db.update(schema.users).set({ active: true }).where(eq(schema.users.id, actor.id)); }
});
it("task access cannot grant source access; revoked channel scope blocks replay and redacts historical evidence", async () => {
  const f = await fixture("sales_spike"); await attachCapacityCheck(f.input, actor, db);
  const limited = { ...actor, channelScope: [2147483647] };
  await expect(getCapacityCheck(limited, f.query, db)).rejects.toMatchObject({ status: 404 });
  await expect(attachCapacityCheck(f.input, limited, db)).rejects.toMatchObject({ status: 404 });
  const history = await listWorkItemHistory(f.item.id, {}, limited, db);
  expect(history.rows[0].note).toContain("当前无权读取");
  expect(JSON.stringify(history)).not.toContain(f.sku.code);
  await expect(attachCapacityCheck(f.input, stranger, db)).rejects.toMatchObject({ status: 403 });
  await expect(attachCapacityCheck(f.input, { ...stranger, roles: ["purchasing"] }, db)).rejects.toMatchObject({ status: 404 });
});
it("historical channel scope stays frozen when the current alert or shop attribution narrows", async () => {
  const f = await fixture("sales_spike"), key = randomUUID();
  const [a, b] = await db.insert(schema.channels).values([
    { code: `cap-a-${key}`, name: "合成渠道甲", kind: "platform" },
    { code: `cap-b-${key}`, name: "合成渠道乙", kind: "platform" },
  ]).returning();
  const shopA = `合成甲店-${key}`, shopB = `合成乙店-${key}`;
  const links = await db.insert(schema.aliases).values([
    { aliasType: "channel", scope: "JIANDAOYUN", rawValue: shopA, targetId: a.id },
    { aliasType: "channel", scope: "JIANDAOYUN", rawValue: shopB, targetId: b.id },
  ]).returning();
  await db.update(schema.systemAlerts).set({ detail: `店铺 ${shopA}、${shopB}；合成跨渠道观察` }).where(eq(schema.systemAlerts.id, f.alert.id));
  const check = await getCapacityCheck(actor, f.query, db);
  expect(check.handoff?.source.channelIds).toEqual([a.id, b.id]);
  await attachCapacityCheck({ ...f.input, evidenceKey: check.evidenceKey! }, actor, db);
  await db.update(schema.systemAlerts).set({ detail: `店铺 ${shopA}；合成当前单渠道观察` }).where(eq(schema.systemAlerts.id, f.alert.id));
  const limited = { ...actor, channelScope: [a.id] };
  // The current source is readable, but that is not authority to read its wider old snapshot.
  expect((await getCapacityCheck(limited, f.query, db)).handoff?.source.id).toBe(f.alert.id);
  const hidden = await listWorkItemHistory(f.item.id, {}, limited, db);
  expect(hidden.rows[0]).toMatchObject({ note: "已保存产能核对依据；当前无权读取其来源内容", requestId: null });
  expect(hidden.rows[0].sourceAlertId).toBeUndefined();
  expect(JSON.stringify(hidden)).not.toContain(f.sku.code);
  expect((await listWorkItemHistory(f.item.id, {}, { ...actor, channelScope: [a.id, b.id] }, db)).rows[0].note).toContain(f.sku.code);
  // Re-attribution after capture must not retroactively authorize the old cross-channel evidence.
  await db.update(schema.aliases).set({ targetId: a.id }).where(eq(schema.aliases.id, links[1].id));
  await db.update(schema.systemAlerts).set({ detail: `店铺 ${shopA}、${shopB}；合成当前同渠道观察` }).where(eq(schema.systemAlerts.id, f.alert.id));
  expect((await getCapacityCheck(limited, f.query, db)).handoff?.source.channelIds).toEqual([a.id]);
  expect((await listWorkItemHistory(f.item.id, {}, limited, db)).rows[0].note).toContain("当前无权读取");
});
it("unmapped historical attribution remains unknown after a later shop mapping; fresh scoped evidence is readable", async () => {
  const f = await fixture("sales_spike"), shop = `合成未知店-${randomUUID()}`;
  await db.update(schema.systemAlerts).set({ detail: `店铺 ${shop}；合成未归属观察` }).where(eq(schema.systemAlerts.id, f.alert.id));
  const initial = await getCapacityCheck(actor, f.query, db);
  expect(initial.handoff?.source.channelIds).toBeNull();
  const old = await attachCapacityCheck({ ...f.input, evidenceKey: initial.evidenceKey! }, actor, db);
  const [channel] = await db.insert(schema.channels).values({ code: `cap-known-${randomUUID()}`, name: "合成已知渠道", kind: "platform" }).returning();
  await db.insert(schema.aliases).values({ aliasType: "channel", scope: "JIANDAOYUN", rawValue: shop, targetId: channel.id });
  const limited = { ...actor, channelScope: [channel.id] };
  const fresh = await getCapacityCheck(limited, f.query, db);
  expect(fresh.evidenceKey).not.toBe(initial.evidenceKey);
  const saved = await attachCapacityCheck({ ...f.input, evidenceKey: fresh.evidenceKey!, requestId: randomUUID() }, limited, db);
  const history = await listWorkItemHistory(f.item.id, {}, limited, db);
  expect(history.rows.find(row => row.id === old.eventId)?.note).toContain("当前无权读取");
  expect(history.rows.find(row => row.id === saved.eventId)).toMatchObject({ sourceAlertId: f.alert.id });
  expect(history.rows.find(row => row.id === saved.eventId)?.note).toContain(f.sku.code);
});
it("audit failure rolls back, explicit retry persists once, and the API rejects arbitrary snapshots", async () => {
  const f = await fixture(); deps.fail = true;
  try { await expect(attachCapacityCheck(f.input, actor, db)).rejects.toThrow("synthetic capacity audit failure"); } finally { deps.fail = false; }
  expect((await listWorkItemHistory(f.item.id, {}, actor, db)).rows).toHaveLength(0);
  deps.user.mockResolvedValue(actor);
  const request = (body: unknown, query = "") => new NextRequest(`http://localhost/api/outsource/sourcing-aid${query}`, { method: "POST", body: JSON.stringify(body) });
  for (const body of [{ ...f.input, snapshot: { fake: true } }, { ...f.input, note: "" }, { ...f.input, requestId: "bad" }]) expect((await POST(request(body))).status).toBe(400);
  expect((await POST(request(f.input, "?mode=capacity"))).status).toBe(400);
  expect((await POST(request(f.input))).status).toBe(201);
  expect((await POST(request(f.input))).status).toBe(200);
  expect((await GET(new NextRequest(`http://localhost/api/outsource/sourcing-aid?mode=capacity&skuId=${f.sku.id}&alertId=${f.alert.id}&alertId=${f.alert.id}`))).status).toBe(400);
  deps.user.mockResolvedValue(stranger); expect((await POST(request(f.input))).status).toBe(403);
});
