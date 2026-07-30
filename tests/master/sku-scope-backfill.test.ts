import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/db/schema";

async function applySql(client: PGlite, sqlText: string): Promise<void> {
  for (const statement of sqlText.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.exec(statement);
  }
}

describe("SKU 外部 scope 迁移", () => {
  it("同 SKU 同义 scope 建立 canonical survivor；跨 SKU 冲突只排队不猜归属", async () => {
    // 必须从 0038 前的真实 schema 开始；在已应用 0040 的模板上重跑 0039 会错误地测试
    // “旧迁移可重复执行”，而不是生产升级顺序 0038 → 0039 → 0040。
    const client = new PGlite();
    const migrationDir = path.resolve(__dirname, "../../drizzle");
    const preScopeFiles = readdirSync(migrationDir)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0039_")
      .sort();
    for (const file of preScopeFiles) {
      await applySql(client, readFileSync(path.join(migrationDir, file), "utf8"));
    }
    const db = drizzle(client, { schema });
    const [spu] = await db.insert(schema.spus).values({ code: "P99804", nameCn: "Scope 迁移" }).returning();
    const [first, second] = await db.insert(schema.skus).values([
      { code: "MIG-A", name: "A", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "MIG-B", name: "B", spuId: spu.id, skuType: "finished", baseUom: "盒" },
    ]).returning();
    await db.insert(schema.skuIdentifiers).values([
      { skuId: first.id, kind: "external", value: "SAFE-001", scope: "JUSHUITAN" },
      { skuId: first.id, kind: "external", value: "SAFE-001", scope: "聚水潭" },
      { skuId: first.id, kind: "external", value: "CONFLICT-001", scope: "JUSHUITAN" },
      { skuId: second.id, kind: "external", value: "CONFLICT-001", scope: "JST" },
    ]);

    for (const file of [
      "0039_canonical_sku_external_scopes.sql",
      "0040_red_metal_master.sql",
    ]) {
      await applySql(client, readFileSync(path.join(migrationDir, file), "utf8"));
    }

    const safe = await db
      .select()
      .from(schema.skuIdentifiers)
      .where(eq(schema.skuIdentifiers.value, "SAFE-001"));
    expect(safe).toHaveLength(2);
    expect(safe.filter((row) => row.scope === "JST")).toHaveLength(1);
    expect(new Set(safe.map((row) => row.skuId))).toEqual(new Set([first.id]));

    const conflict = await db
      .select()
      .from(schema.skuIdentifiers)
      .where(eq(schema.skuIdentifiers.value, "CONFLICT-001"));
    expect(conflict.map((row) => [row.skuId, row.scope])).toEqual(expect.arrayContaining([
      [first.id, "JUSHUITAN"],
      [second.id, "JST"],
    ]));
    const [queued] = await db
      .select()
      .from(schema.aliasExceptions)
      .where(and(
        eq(schema.aliasExceptions.aliasType, "sku_code"),
        eq(schema.aliasExceptions.rawValue, "CONFLICT-001"),
      ));
    expect(queued).toMatchObject({
      scope: "JST",
      status: "open",
      context: {
        reason: "sku_external_scope_conflict",
        canonicalScope: "JST",
        skuCount: 2,
        migration: "0039",
      },
    });
    await client.close();
  });
});
