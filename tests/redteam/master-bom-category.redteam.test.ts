/* eslint-disable @typescript-eslint/no-explicit-any -- 红队测试刻意用 as any 探查脱敏后的任意嵌套属性：断言的正是「敏感键有没有被剥掉」，写成精确类型反而会让被测对象重新获得类型保护，测不到真实的漏出面。 */
/**
 * RED TEAM — master：BOM 生效并发 & 分类环路守卫。
 * bom.ts/category.ts 用 getDbAsync()（全局单例），无法注入 PGlite；
 * 故此处通过 process.env.DATABASE_URL 指向内存 pglite 并复用其单例。
 * 约定：断言【正确】行为；用例失败 = 漏洞证实。
 */
import { beforeAll, describe, expect, it } from "vitest";

// 让 getDbAsync() 走 PGlite 实例（每进程一个），并在 import 前设置好环境。
// 用 os 临时目录，避免污染仓库（db/index.ts 会 mkdirSync 该路径）。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RT_APPROVER = { id: 0, roles: ["admin"], isApprover: true }; // id 在 beforeAll 回填（approvals FK）
process.env.DATABASE_URL = "pglite:" + mkdtempSync(join(tmpdir(), "scm-redteam-"));

describe("redteam/master bom & category", () => {
  let getDbAsync: typeof import("@/db").getDbAsync;
  let schema: typeof import("@/db").schema;
  let activateBom: typeof import("@/server/modules/master/bom").activateBom;
  let createCategory: typeof import("@/server/modules/master/category").createCategory;
  let updateCategory: typeof import("@/server/modules/master/category").updateCategory;

  let productSku: number;
  let matSku: number;

  beforeAll(async () => {
    const dbMod = await import("@/db");
    getDbAsync = dbMod.getDbAsync;
    schema = dbMod.schema;
    ({ activateBom } = await import("@/server/modules/master/bom"));
    ({ createCategory, updateCategory } = await import("@/server/modules/master/category"));

    const db = await getDbAsync();
    // activateBom SoD 整改后写 approvals（approver_id FK）——需真实用户
    const [u] = await db.insert(schema.users).values({ name: "红队审批人", roles: ["admin"], isApprover: true, username: "rt_approver" }).returning();
    RT_APPROVER.id = u.id;
    const [spu] = await db.insert(schema.spus).values({ code: "PB0001", nameCn: "BOM产品" }).returning();
    const [p] = await db.insert(schema.skus).values({ code: "PBOM01", name: "成品", spuId: spu.id, baseUom: "个", skuType: "finished" }).returning();
    const [m] = await db.insert(schema.skus).values({ code: "PMAT01", name: "料", spuId: spu.id, baseUom: "个", skuType: "raw" }).returning();
    productSku = p.id;
    matSku = m.id;
  });

  async function makeDraftBom(versionNo: string): Promise<number> {
    const db = await getDbAsync();
    const [head] = await db.insert(schema.boms).values({ productSkuId: productSku, versionNo, status: "draft" }).returning();
    await db.insert(schema.bomLines).values({ bomId: head.id, materialSkuId: matSku, qtyPer: "1", lossRatePct: "0" });
    return head.id;
  }

  it("[BUG?] 两个草稿并发生效同一产品：uq_bom_one_active 应确保最终仅 1 个 active，另一个优雅失败", async () => {
    const b1 = await makeDraftBom("v-concurrent-A");
    const b2 = await makeDraftBom("v-concurrent-B");
    const results = await Promise.allSettled([activateBom(b1, RT_APPROVER), activateBom(b2, RT_APPROVER)]);
    const db = await getDbAsync();
    const { eq, and } = await import("drizzle-orm");
    const actives = await db.select().from(schema.boms)
      .where(and(eq(schema.boms.productSkuId, productSku), eq(schema.boms.status, "active")));
    // 正确行为：恰好一个 active（不管过程谁赢）
    expect(actives).toHaveLength(1);
    // 至少一个 activate 成功
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });

  it("串行生效换版：先 active v1，再 active v2 → v1 退役、仅 v2 active", async () => {
    const b1 = await makeDraftBom("v-serial-1");
    await activateBom(b1, RT_APPROVER);
    const b2 = await makeDraftBom("v-serial-2");
    await activateBom(b2, RT_APPROVER);
    const db = await getDbAsync();
    const { eq, and } = await import("drizzle-orm");

    const actives = await db.select().from(schema.boms)
      .where(and(eq(schema.boms.productSkuId, productSku), eq(schema.boms.status, "active")));
    expect(actives).toHaveLength(1);
    expect(actives[0].versionNo).toBe("v-serial-2");
  });

  it("[BUG?] 分类环路守卫：A→B 后把 A 的父设为 B（A→B→A）必须被拒", async () => {
    const a = await createCategory({ name: "环A" });
    const b = await createCategory({ name: "环B", parentId: (a as any).id });
    // 现在 B 的父是 A。尝试把 A 的父设为 B → 形成环 A→B→A
    await expect(
      updateCategory((a as any).id, { name: "环A", parentId: (b as any).id }),
    ).rejects.toMatchObject({ name: "ApiError" });
  });

  it("分类自引用直接拒绝", async () => {
    const c = await createCategory({ name: "自引用" });
    await expect(
      updateCategory((c as any).id, { name: "自引用", parentId: (c as any).id }),
    ).rejects.toMatchObject({ name: "ApiError" });
  });
});
