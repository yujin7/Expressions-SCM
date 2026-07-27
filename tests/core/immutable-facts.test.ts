import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  auditLogs,
  planningVersionLines,
  planningVersions,
  skus,
  spus,
  stockLedger,
  users,
  warehouses,
} from "@/db/schema";
import { createTestDb } from "../helpers/db";

const appendOnlyError = /append-only/i;

async function expectAppendOnlyRejection(query: PromiseLike<unknown>) {
  try {
    await query;
    throw new Error("expected the database to reject an immutable fact mutation");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const cause = (error as Error & { cause?: unknown }).cause;
    const messages = [
      (error as Error).message,
      cause instanceof Error ? cause.message : "",
    ].join("\n");
    expect(messages).toMatch(appendOnlyError);
  }
}

describe("immutable fact tables", () => {
  it("rejects UPDATE, DELETE, and TRUNCATE on stock_ledger at the database boundary", async () => {
    const { db, client } = await createTestDb();
    const [spu] = await db
      .insert(spus)
      .values({ code: "P-IMMUTABLE", nameCn: "不可变事实测试" })
      .returning();
    const [sku] = await db
      .insert(skus)
      .values({
        code: "SKU-IMMUTABLE",
        name: "不可变库存",
        spuId: spu.id,
        baseUom: "pcs",
        skuType: "finished",
      })
      .returning();
    const [warehouse] = await db
      .insert(warehouses)
      .values({ code: "WH-IMMUTABLE", name: "不可变仓", kind: "finished" })
      .returning();
    const [ledger] = await db
      .insert(stockLedger)
      .values({
        skuId: sku.id,
        warehouseId: warehouse.id,
        qtyDelta: "1",
        sourceDocType: "invariant_test",
        sourceDocId: 1,
        sourceLineId: 1,
        action: "post",
      })
      .returning();

    await expectAppendOnlyRejection(
      db.update(stockLedger).set({ qtyDelta: "2" }).where(eq(stockLedger.id, ledger.id)),
    );
    await expectAppendOnlyRejection(
      db.delete(stockLedger).where(eq(stockLedger.id, ledger.id)),
    );
    await expectAppendOnlyRejection(client.exec("TRUNCATE TABLE stock_ledger"));

    const [persisted] = await db.select().from(stockLedger).where(eq(stockLedger.id, ledger.id));
    expect(persisted.qtyDelta).toBe("1.0000");
  });

  it("rejects UPDATE, DELETE, and TRUNCATE on audit_logs at the database boundary", async () => {
    const { db, client } = await createTestDb();
    const [audit] = await db
      .insert(auditLogs)
      .values({
        userId: 1,
        entity: "invariant_test",
        entityId: 1,
        action: "create",
        after: { status: "recorded" },
      })
      .returning();

    await expectAppendOnlyRejection(
      db.update(auditLogs).set({ action: "rewrite" }).where(eq(auditLogs.id, audit.id)),
    );
    await expectAppendOnlyRejection(
      db.delete(auditLogs).where(eq(auditLogs.id, audit.id)),
    );
    await expectAppendOnlyRejection(client.exec("TRUNCATE TABLE audit_logs"));

    const [persisted] = await db.select().from(auditLogs).where(eq(auditLogs.id, audit.id));
    expect(persisted.action).toBe("create");
  });

  it("rejects rewriting or deleting immutable planning versions and their evidence lines", async () => {
    const { db, client } = await createTestDb();
    const [user] = await db.insert(users).values({ name: "计划证据员", roles: ["pmc"] }).returning();
    const [spu] = await db.insert(spus).values({ code: "P-PLAN-IMM", nameCn: "计划不可变测试" }).returning();
    const [sku] = await db.insert(skus).values({
      code: "SKU-PLAN-IMM",
      name: "计划不可变成品",
      spuId: spu.id,
      baseUom: "件",
      skuType: "finished",
    }).returning();
    const [version] = await db.insert(planningVersions).values({
      name: "不可变版本",
      weekStart: "2026-07-27",
      engineVersion: "test-v1",
      parameters: {},
      sourceMeta: {},
      lineCount: 1,
      suggestedCount: 1,
      suppressedCount: 0,
      digest: "digest",
      idempotencyKey: "immutable-plan-version",
      createdBy: user.id,
    }).returning();
    const [line] = await db.insert(planningVersionLines).values({
      versionId: version.id,
      skuId: sku.id,
      skuCode: sku.code,
      skuName: sku.name,
      baseUom: sku.baseUom,
      suggestedQty: "10",
      suppressed: false,
      orderWindowMissed: false,
      onHand: "0",
      inTransit: "0",
      daily: "1",
      safetyQty: "7",
      explanation: [],
    }).returning();

    await expectAppendOnlyRejection(
      db.update(planningVersions).set({ name: "被篡改" }).where(eq(planningVersions.id, version.id)),
    );
    await expectAppendOnlyRejection(
      db.delete(planningVersions).where(eq(planningVersions.id, version.id)),
    );
    await expectAppendOnlyRejection(
      db.update(planningVersionLines).set({ suggestedQty: "999" }).where(eq(planningVersionLines.id, line.id)),
    );
    await expectAppendOnlyRejection(
      db.delete(planningVersionLines).where(eq(planningVersionLines.id, line.id)),
    );
    // Include the dependent pegging and S&OP evidence tables so PostgreSQL reaches the
    // append-only trigger instead of rejecting the FK truncate shape first.
    await expectAppendOnlyRejection(
      client.exec("TRUNCATE TABLE sop_decisions, sop_cycles, supply_demand_links, planning_version_lines, planning_versions"),
    );

    const [persistedVersion] = await db.select().from(planningVersions).where(eq(planningVersions.id, version.id));
    const [persistedLine] = await db.select().from(planningVersionLines).where(eq(planningVersionLines.id, line.id));
    expect(persistedVersion.name).toBe("不可变版本");
    expect(persistedLine.suggestedQty).toBe("10.0000");
  });
});
