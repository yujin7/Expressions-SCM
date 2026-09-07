import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { createNpdFirstOrder, createNpdProject, createNpdProjectSchema, getNpdProject, rescheduleNpd, updateNpdProject, updateNpdProjectSkuCode, updateNpdTask } from "@/server/modules/npd/service";
import { createTestDb } from "../helpers/db";

const requestKey = "ac264aa1-38a0-4803-9643-f9371545d3b8";
let fixture: Awaited<ReturnType<typeof createTestDb>>;
let actor: SessionUser;
let other: SessionUser;
let projectId: number;
let taskId: number;
const firstOrder = (extra = {}) => ({ projectId, version: 1, qty: "12.5", requestKey, ...extra });

beforeEach(async () => {
  fixture = await createTestDb();
  const { db } = fixture;
  const people = await db.insert(schema.users).values([{ name: "QA计划", roles: ["pmc"] }, { name: "QA运营", roles: ["ops"] }]).returning();
  actor = { id: people[0].id, name: people[0].name, roles: ["pmc"], isApprover: false };
  other = { id: people[1].id, name: people[1].name, roles: ["ops"], isApprover: false };
  const [spu] = await db.insert(schema.spus).values({ code: "QA-NPD", nameCn: "QA新品" }).returning();
  await db.insert(schema.skus).values({ code: "QA-NPD-A", spuId: spu.id, name: "QA成品", skuType: "finished", baseUom: "支", active: true });
  const [project] = await db.insert(schema.npdProjects).values({ name: "QA项目", skuCode: "QA-NPD-A", startDate: "2026-09-01", createdBy: actor.id }).returning();
  projectId = project.id;
  const [task] = await db.insert(schema.npdTasks).values({ projectId, seq: 1, name: "QA节点", days: 2, planStart: "2026-09-01", planEnd: "2026-09-03", note: "原备注" }).returning();
  taskId = task.id;
});
afterEach(async () => { await fixture.client.close(); });

describe("NPD写入：日期、版本、关闭边界及首单请求重放", () => {
  it.each(["2026-02-31", "2026-13-45", "2025-02-29", "0000-01-01", "2026-09-01T00:00:00Z"])("rejects an invalid project date: %s", startDate => {
    expect(createNpdProjectSchema.safeParse({ name: "QA项目", startDate }).success).toBe(false);
  });
  it("accepts an actual leap day", () => {
    expect(createNpdProjectSchema.safeParse({ name: "QA项目", startDate: "2028-02-29" }).success).toBe(true);
  });
  it.each([
    { startDate: "2026-09-01", days: "9999999999" },
    { startDate: "9999-12-31", days: "2" },
  ])("rejects an overflowing template schedule without partial project creation: $startDate/$days", async ({ startDate, days }) => {
    const [job] = await fixture.db.insert(schema.importJobs).values({ template: "npd", filename: "qa-template.xlsx", createdBy: actor.id }).returning();
    await fixture.db.insert(schema.transitRefs).values({ kind: "npd_node", materialName: "QA越界节点", qty: days, sourceJobId: job.id });
    await expect(createNpdProject(actor, { name: "QA越界项目", startDate }, fixture.db))
      .rejects.toMatchObject({ status: 400, message: "排期超出支持的日期范围，请核对节点天数和启动日" });
    expect(await fixture.db.select().from(schema.npdProjects)).toHaveLength(1);
    expect(await fixture.db.select().from(schema.npdTasks)).toHaveLength(1);
    expect(await fixture.db.select().from(schema.auditLogs)).toHaveLength(0);
  });
  it("rejects a stale task version without changing the node", async () => {
    await expect(updateNpdTask(actor, { taskId, status: "done", version: 99 }, fixture.db)).rejects.toMatchObject({ status: 409 });
    expect((await getNpdProject(projectId, fixture.db)).tasks[0].status).toBe("pending");
  });
  it("serial commands cannot overwrite a project version already consumed by another node change", async () => {
    await updateNpdTask(actor, { taskId, status: "doing", version: 1 }, fixture.db);
    await expect(updateNpdProject(actor, { projectId, status: "cancelled", version: 1 }, fixture.db)).rejects.toMatchObject({ status: 409 });
    expect((await getNpdProject(projectId, fixture.db)).project.status).toBe("active");
  });
  it.each(["node", "sku", "plan", "first_order"])("closed projects reject %s until explicitly restored", async action => {
    await updateNpdProject(actor, { projectId, status: "cancelled", version: 1 }, fixture.db);
    const result = action === "node" ? updateNpdTask(actor, { taskId, status: "done", version: 2 }, fixture.db)
      : action === "sku" ? updateNpdProjectSkuCode(actor, { projectId, skuCode: "QA-NPD-A", version: 2 }, fixture.db)
      : action === "plan" ? rescheduleNpd(actor, { projectId, version: 2 }, fixture.db)
      : createNpdFirstOrder(actor, firstOrder({ version: 2 }), fixture.db);
    await expect(result).rejects.toMatchObject({ status: 409 });
  });
  it("explicit restore permits node work using the new version", async () => {
    await updateNpdProject(actor, { projectId, status: "done", version: 1 }, fixture.db);
    await updateNpdProject(actor, { projectId, status: "active", version: 2 }, fixture.db);
    await updateNpdTask(actor, { taskId, status: "doing", version: 3 }, fixture.db);
    expect((await getNpdProject(projectId, fixture.db)).tasks[0].status).toBe("doing");
  });
  it("a same-status retry does not rewrite a historical completion date", async () => {
    await fixture.db.update(schema.npdTasks).set({ status: "done", doneAt: "2026-08-20" }).where(eq(schema.npdTasks.id, taskId));
    await updateNpdTask(actor, { taskId, status: "done", version: 1 }, fixture.db);
    expect((await getNpdProject(projectId, fixture.db)).tasks[0].doneAt).toBe("2026-08-20");
  });
  it("omitted note is preserved, explicit empty note clears and audit matches the actual state", async () => {
    await updateNpdTask(actor, { taskId, status: "doing", version: 1 }, fixture.db);
    expect((await getNpdProject(projectId, fixture.db)).tasks[0].note).toBe("原备注");
    await updateNpdTask(actor, { taskId, status: "doing", note: "", version: 2 }, fixture.db);
    expect((await getNpdProject(projectId, fixture.db)).tasks[0].note).toBeNull();
    const logs = await fixture.db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity, "npd_task"), eq(schema.auditLogs.action, "update_status")));
    expect(logs.at(-1)?.after).toMatchObject({ note: null });
  });
  it("the same request returns the original BH, even after project closure", async () => {
    const created = await createNpdFirstOrder(actor, firstOrder(), fixture.db);
    await updateNpdProject(actor, { projectId, status: "done", version: 2 }, fixture.db);
    const replay = await createNpdFirstOrder(actor, firstOrder(), fixture.db);
    expect(replay.id).toBe(created.id);
    expect((await fixture.db.select().from(schema.bhDocs))).toHaveLength(1);
    const logs = await fixture.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "first_order_draft"));
    expect(logs).toHaveLength(1);
  });
  it("a reused request key cannot change quantity", async () => {
    await createNpdFirstOrder(actor, firstOrder(), fixture.db);
    await expect(createNpdFirstOrder(actor, firstOrder({ qty: "99" }), fixture.db)).rejects.toMatchObject({ status: 409 });
    expect((await fixture.db.select().from(schema.bhDocs))).toHaveLength(1);
  });
  it("a deliberate new request may create another draft using the latest version", async () => {
    const one = await createNpdFirstOrder(actor, firstOrder(), fixture.db);
    const two = await createNpdFirstOrder(actor, firstOrder({ requestKey: "2ca9dd43-25e2-4e5c-93d1-456f0a1658e1", version: 2 }), fixture.db);
    expect(one.id).not.toBe(two.id);
    expect((await fixture.db.select().from(schema.bhDocs)).every(row => row.status === "draft")).toBe(true);
  });
  it("loss of write role denies even a known request replay", async () => {
    await createNpdFirstOrder(actor, firstOrder(), fixture.db);
    await expect(createNpdFirstOrder({ ...actor, roles: ["warehouse"] }, firstOrder(), fixture.db)).rejects.toMatchObject({ status: 403 });
  });
  it("over-precision quantity fails before creating a BH", async () => {
    await expect(createNpdFirstOrder(actor, firstOrder({ qty: "0.00001" }), fixture.db)).rejects.toThrow();
    expect(await fixture.db.select().from(schema.bhDocs)).toHaveLength(0);
  });
  it("an NPD audit failure rolls back the BH and the project version", async () => {
    await fixture.client.exec(`CREATE FUNCTION qa_reject_npd_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'first_order_draft' THEN RAISE EXCEPTION 'QA NPD audit refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER qa_reject_npd_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION qa_reject_npd_audit();`);
    await expect(createNpdFirstOrder(actor, firstOrder(), fixture.db)).rejects.toThrow();
    expect(await fixture.db.select().from(schema.bhDocs)).toHaveLength(0);
    expect(await fixture.db.select().from(schema.bhLines)).toHaveLength(0);
    await fixture.db.execute(sql.raw("DROP TRIGGER qa_reject_npd_audit ON audit_logs"));
    // If the version increment leaked, this legitimate retry would conflict.
    await expect(createNpdFirstOrder(actor, firstOrder(), fixture.db)).resolves.toHaveProperty("docNo");
  });
  it("different actors do not receive each other's receipt from the same request key", async () => {
    const a = await createNpdFirstOrder(actor, firstOrder(), fixture.db);
    const b = await createNpdFirstOrder(other, firstOrder({ version: 2 }), fixture.db);
    expect(a.id).not.toBe(b.id);
  });
  it("canonical quantity and UUID casing recover the same request", async () => {
    const result = await createNpdFirstOrder(actor, firstOrder(), fixture.db);
    const replay = await createNpdFirstOrder(actor, firstOrder({ qty: "12.5000", requestKey: requestKey.toUpperCase() }), fixture.db);
    expect(replay).toEqual({ ...result, replayed: true });
  });
  it("first-order history follows BH own/shared-channel visibility, with no actor defaulting to no history", async () => {
    const own = await createNpdFirstOrder(actor, firstOrder(), fixture.db);
    const peer = await createNpdFirstOrder(other, firstOrder({ version: 2 }), fixture.db);
    expect((await getNpdProject(projectId, fixture.db)).firstOrders).toEqual([]);
    expect((await getNpdProject(projectId, fixture.db, { ...actor, channelScope: [] })).firstOrders.map((r: { id: number }) => r.id)).toEqual([own.id]);
    const [channel] = await fixture.db.insert(schema.channels).values({ code: "QA-NPD-CHANNEL", name: "QA范围", kind: "platform" }).returning();
    await fixture.db.insert(schema.userDataScopes).values({ userId: other.id, scopeKind: "channel", targetId: channel.id, createdBy: actor.id });
    const visible = await getNpdProject(projectId, fixture.db, { ...actor, channelScope: [channel.id] });
    expect(visible.firstOrders.map((r: { id: number }) => r.id)).toEqual([peer.id, own.id]);
    expect(visible.firstOrders[0]).toMatchObject({ qty: "12.5000", baseUom: "支", status: "draft" });
    expect(visible.firstOrders[0]).not.toHaveProperty("requestKey");
  });
  it("a new request at an already consumed version fails without another BH", async () => {
    await createNpdFirstOrder(actor, firstOrder(), fixture.db);
    await expect(createNpdFirstOrder(actor, firstOrder({ requestKey: "2ca9dd43-25e2-4e5c-93d1-456f0a1658e1" }), fixture.db)).rejects.toMatchObject({ status: 409 });
    expect(await fixture.db.select().from(schema.bhDocs)).toHaveLength(1);
  });
  it.each(["node", "status", "sku", "plan"])("%s audit failure cannot leave a partially changed project", async action => {
    const [spu] = await fixture.db.select().from(schema.spus);
    await fixture.db.insert(schema.skus).values({ code: "QA-NPD-B", spuId: spu.id, skuType: "finished", baseUom: "支" });
    const before = await getNpdProject(projectId, fixture.db);
    await fixture.client.exec(`CREATE FUNCTION qa_reject_npd_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity IN ('npd_task','npd_project') THEN RAISE EXCEPTION 'QA NPD audit refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER qa_reject_npd_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION qa_reject_npd_audit();`);
    const result = action === "node" ? updateNpdTask(actor, { taskId, version: 1, status: "done" }, fixture.db)
      : action === "status" ? updateNpdProject(actor, { projectId, version: 1, status: "cancelled" }, fixture.db)
      : action === "sku" ? updateNpdProjectSkuCode(actor, { projectId, version: 1, skuCode: "QA-NPD-B" }, fixture.db)
      : rescheduleNpd(actor, { projectId, version: 1 }, fixture.db);
    await expect(result).rejects.toThrow();
    expect(await getNpdProject(projectId, fixture.db)).toEqual(before);
  });
});
