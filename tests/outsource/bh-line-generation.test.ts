import { afterEach, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "@/db/schema";
import { generateWoFromBhLine, hookAfterBhApprove, previewAutoChain } from "@/server/modules/outsource/auto-chain";
import { createWo } from "@/server/modules/outsource/wo";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb, client: Awaited<ReturnType<typeof createTestDb>>["client"];
let actor: SessionUser, other: SessionUser, bhId: number, skuId: number, supplierId: number, lines: number[];
beforeEach(async () => {
  ({ db, client } = await createTestDb());
  const people = await db.insert(s.users).values([{ name: "PMC A", roles: ["pmc"] }, { name: "PMC B", roles: ["pmc"] }]).returning();
  [actor, other] = people.map(p => ({ id: p.id, name: p.name, roles: p.roles, isApprover: false, sessionVersion: p.sessionVersion }));
  const [spu] = await db.insert(s.spus).values({ code: "LINES", nameCn: "合成多行" }).returning();
  const [sku] = await db.insert(s.skus).values({ code: "LINES-FG", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning(); skuId = sku.id;
  const [supplier] = await db.insert(s.suppliers).values({ code: "LINES", name: "合成工厂" }).returning(); supplierId = supplier.id;
  await db.insert(s.boms).values({ productSkuId: skuId, versionNo: "1", status: "active" });
  await db.insert(s.transitRefs).values({ kind: "oem_map", skuCode: sku.code, supplierId, sourceJobId: 1 });
  await db.insert(s.processingFeeRefs).values({ skuId, supplierId, feeRate: "1.23", effectiveDate: "2026-01-01", source: "manual" });
  const [bh] = await db.insert(s.bhDocs).values({ docNo: "BH-LINES", createdBy: actor.id, status: "approved", version: 3 }).returning(); bhId = bh.id;
  lines = (await db.insert(s.bhLines).values([
    { bhId, skuId, qty: "12.3456", expectDate: "2026-10-01" },
    { bhId, skuId, qty: "23.4567", expectDate: "2026-10-12" },
    { bhId, skuId, qty: "12.3456", expectDate: "2026-10-01" },
  ]).returning()).map(l => l.id);
});
afterEach(async () => { await client.close(); });
const input = (index = 0) => ({ bhId, bhLineId: lines[index], skuId });
const generate = (index = 0, user = actor) => generateWoFromBhLine(user, input(index), db);

it("same-SKU lines retain identities and dates; one success does not hide remaining demand", async () => {
  const first = await generate();
  const preview = (await previewAutoChain(db, actor)).wos;
  expect(preview.map(w => w.bhLineId)).toEqual(lines);
  expect(preview[0].generated?.id).toBe(first.id);
  expect(preview.slice(1).every(w => !w.blockedReason && !w.generated)).toBe(true);
  await generate(1); await generate(2);
  const docs = await db.select().from(s.woDocs).orderBy(s.woDocs.id);
  expect(docs.map(w => [w.qty, w.dueDate, w.status])).toEqual([
    ["12.3456", "2026-10-01", "draft"], ["23.4567", "2026-10-12", "draft"], ["12.3456", "2026-10-01", "draft"],
  ]);
  expect(await db.select().from(s.bhWoGenerations)).toHaveLength(3);
  expect(await db.select().from(s.stockLedger)).toHaveLength(0);
});

it("another current PMC recovers the same receipt without duplicate audit or draft", async () => {
  const first = await generate();
  const replay = await generate(0, other);
  expect(replay).toEqual({ ...first, idempotent: true });
  expect(await db.select().from(s.woDocs)).toHaveLength(1);
  expect(await db.select().from(s.auditLogs).where(and(eq(s.auditLogs.entity, "wo"), eq(s.auditLogs.action, "create")))).toHaveLength(1);
});

it("receipts return actual document status after source closure or master retirement", async () => {
  const first = await generate();
  await db.update(s.woDocs).set({ status: "pending" }).where(eq(s.woDocs.id, first.id));
  await db.update(s.bhDocs).set({ status: "closed" }).where(eq(s.bhDocs.id, bhId));
  await db.update(s.skus).set({ active: false }).where(eq(s.skus.id, skuId));
  await db.update(s.processingFeeRefs).set({ feeRate: "9.99" }).where(eq(s.processingFeeRefs.skuId, skuId));
  expect(await generate()).toMatchObject({ id: first.id, status: "pending", idempotent: true });
  await expect(generate(1)).rejects.toMatchObject({ status: 409 });
  const preview = (await previewAutoChain(db, actor)).wos;
  expect(preview[0]).toMatchObject({ generated: { id: first.id, status: "pending" }, feeRatePlan: "1.23" });
  expect(preview[1].blockedReason).toContain("未审批");
});

it("legacy BH/SKU calls reject ambiguity, exact source IDs reject wrong SKU or BH", async () => {
  await expect(generateWoFromBhLine(actor, { bhId, skuId }, db)).rejects.toMatchObject({ status: 409 });
  await expect(generateWoFromBhLine(actor, { ...input(), skuId: skuId + 1 }, db)).rejects.toMatchObject({ status: 404 });
  await expect(generateWoFromBhLine(actor, { ...input(), bhId: bhId + 1 }, db)).rejects.toMatchObject({ status: 404 });
  expect(await db.select().from(s.woDocs)).toHaveLength(0);
});

it("historical unallocated WOs remain explicit conflicts, never auto-claimed by matching qty", async () => {
  const legacy = await createWo(actor, { bhId, productSkuId: skuId, supplierId, qty: "12.3456", feeRatePlan: "1.23" }, db);
  const preview = (await previewAutoChain(db, actor)).wos;
  expect(preview).toHaveLength(3);
  expect(preview.every(w => w.blockedReason?.includes("未记录来源明细") && !w.generated && w.legacyDocuments[0].id === legacy.id)).toBe(true);
  await expect(generate()).rejects.toMatchObject({ status: 409 });
  expect(await db.select().from(s.bhWoGenerations)).toHaveLength(0);
  expect(await db.select().from(s.woDocs)).toHaveLength(1);
});

it("failure to store a receipt rolls back the WO, numbering and audit", async () => {
  const counters = await db.select().from(s.docCounters);
  await client.exec("CREATE FUNCTION fail_bh_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt fault'; END $$; CREATE TRIGGER fail_bh_receipt BEFORE INSERT ON bh_wo_generations FOR EACH ROW EXECUTE FUNCTION fail_bh_receipt();");
  await expect(generate()).rejects.toThrow();
  expect(await db.select().from(s.woDocs)).toHaveLength(0);
  expect(await db.select().from(s.auditLogs)).toHaveLength(0);
  expect(await db.select().from(s.docCounters)).toEqual(counters);
  await client.exec("DROP TRIGGER fail_bh_receipt ON bh_wo_generations; DROP FUNCTION fail_bh_receipt();");
  expect(await generate()).toMatchObject({ idempotent: false });
});

it("database prevents duplicate source receipts, remapping, deletion and truncate", async () => {
  const first = await generate();
  await expect(db.insert(s.bhWoGenerations).values({ bhLineId: lines[0], sourceVersion: 3, woId: first.id, createdBy: actor.id })).rejects.toThrow();
  await expect(db.update(s.bhWoGenerations).set({ sourceVersion: 9 })).rejects.toThrow();
  await expect(db.delete(s.bhWoGenerations)).rejects.toThrow();
  await expect(client.exec("TRUNCATE bh_wo_generations")).rejects.toThrow();
  expect((await db.select().from(s.bhWoGenerations))[0].sourceVersion).toBe(3);
});

it("role revocation, stale session and changed source visibility block even receipt recovery", async () => {
  await generate();
  await db.update(s.users).set({ roles: ["ops"] }).where(eq(s.users.id, actor.id));
  await expect(generate()).rejects.toMatchObject({ status: 403 });
  await db.update(s.users).set({ roles: ["pmc"], sessionVersion: 2 }).where(eq(s.users.id, actor.id));
  await expect(generate()).rejects.toMatchObject({ status: 401 });
  const [ch] = await db.insert(s.channels).values({ code: "OTHER", name: "其他", kind: "platform" }).returning();
  await db.insert(s.userDataScopes).values({ userId: other.id, scopeKind: "channel", targetId: ch.id, createdBy: other.id });
  await expect(generate(0, other)).rejects.toMatchObject({ status: 404 });
});

it("hook continues after one line fails and later retry fills only the missing line", async () => {
  await db.insert(s.sysParams).values({ scope: "global", key: "auto_wo_on_bh", value: "1" }).onConflictDoUpdate({ target: [s.sysParams.scope, s.sysParams.key], set: { value: "1" } });
  await client.exec(`CREATE FUNCTION fail_middle_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.bh_line_id = ${lines[1]} THEN RAISE EXCEPTION 'middle line fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_middle_line BEFORE INSERT ON bh_wo_generations FOR EACH ROW EXECUTE FUNCTION fail_middle_line();`);
  await hookAfterBhApprove(actor, bhId, db);
  expect((await db.select().from(s.bhWoGenerations).orderBy(s.bhWoGenerations.bhLineId)).map(r => r.bhLineId)).toEqual([lines[0], lines[2]]);
  expect((await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, "auto_wo_failed")))[0].after).toMatchObject({ count: 2, failed: [{ bhLineId: lines[1] }] });
  await client.exec("DROP TRIGGER fail_middle_line ON bh_wo_generations; DROP FUNCTION fail_middle_line();");
  await hookAfterBhApprove(actor, bhId, db);
  expect(await db.select().from(s.bhWoGenerations)).toHaveLength(3);
  expect(await db.select().from(s.woDocs)).toHaveLength(3);
});
