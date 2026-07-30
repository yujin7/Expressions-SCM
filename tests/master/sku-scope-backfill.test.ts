import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { aliasExceptions, skuIdentifiers, skus, spus } from "@/db/schema";
import { createTestDb } from "../helpers/db";

describe("SKU 外部 scope 迁移", () => {
  it("同 SKU 同义 scope 建立 canonical survivor；跨 SKU 冲突只排队不猜归属", async () => {
    const { db, client } = await createTestDb();
    const [spu] = await db.insert(spus).values({ code: "P99804", nameCn: "Scope 迁移" }).returning();
    const [first, second] = await db.insert(skus).values([
      { code: "MIG-A", name: "A", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "MIG-B", name: "B", spuId: spu.id, skuType: "finished", baseUom: "盒" },
    ]).returning();
    await db.insert(skuIdentifiers).values([
      { skuId: first.id, kind: "external", value: "SAFE-001", scope: "JUSHUITAN" },
      { skuId: first.id, kind: "external", value: "SAFE-001", scope: "聚水潭" },
      { skuId: first.id, kind: "external", value: "CONFLICT-001", scope: "JUSHUITAN" },
      { skuId: second.id, kind: "external", value: "CONFLICT-001", scope: "JST" },
    ]);

    const migration = readFileSync(
      path.resolve(__dirname, "../../drizzle/0039_canonical_sku_external_scopes.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }

    const safe = await db
      .select()
      .from(skuIdentifiers)
      .where(eq(skuIdentifiers.value, "SAFE-001"));
    expect(safe).toHaveLength(2);
    expect(safe.filter((row) => row.scope === "JST")).toHaveLength(1);
    expect(new Set(safe.map((row) => row.skuId))).toEqual(new Set([first.id]));

    const conflict = await db
      .select()
      .from(skuIdentifiers)
      .where(eq(skuIdentifiers.value, "CONFLICT-001"));
    expect(conflict.map((row) => [row.skuId, row.scope])).toEqual(expect.arrayContaining([
      [first.id, "JUSHUITAN"],
      [second.id, "JST"],
    ]));
    const [queued] = await db
      .select()
      .from(aliasExceptions)
      .where(and(
        eq(aliasExceptions.aliasType, "sku_code"),
        eq(aliasExceptions.rawValue, "CONFLICT-001"),
      ));
    expect(queued).toMatchObject({
      status: "open",
      context: {
        reason: "sku_external_scope_conflict",
        canonicalScope: "JST",
        skuCount: 2,
        migration: "0039",
      },
    });
  });
});
