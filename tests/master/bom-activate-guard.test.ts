import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, bomLines, boms, skus, spus, stockBalances, suppliers, users, warehouses } from "@/db/schema";
import type { DB } from "@/db";
import { activateBom } from "@/server/modules/master/bom";
import { MAX_BOM_DEPTH } from "@/server/rules/bom-explode";
import { createTestDb, type TestDb } from "../helpers/db";

describe("FEATURE 5 BOM 生效动效检查：被移除物料在委外仓有结存 → 409 / force 放行", () => {
  let db: TestDb;
  let dbx: DB;
  let productId = 0;
  let mA = 0;
  let mB = 0;
  let v2 = 0;
  let approver: { id: number; roles: string[]; isApprover: boolean };

  beforeAll(async () => {
    ({ db } = await createTestDb());
    dbx = db as unknown as DB;
    const [u] = await db.insert(users).values({ name: "PMC审批", roles: ["pmc"], isApprover: true }).returning();
    approver = { id: u.id, roles: ["pmc"], isApprover: true };

    const [spu] = await db.insert(spus).values({ code: "PAG01", nameCn: "动效测试品" }).returning();
    const mk = async (code: string, type: "finished" | "raw") => {
      const [s] = await db.insert(skus).values({ code, name: code, spuId: spu.id, baseUom: "个", skuType: type }).returning();
      return s.id;
    };
    productId = await mk("AG-P1", "finished");
    mA = await mk("AG-MA", "raw");
    mB = await mk("AG-MB", "raw");

    const [sup] = await db.insert(suppliers).values({ code: "GAG1", name: "动效工厂", kinds: ["processor"] }).returning();
    const [wh] = await db
      .insert(warehouses)
      .values({ code: "WWX-AG", name: "动效委外仓", kind: "outsource", supplierId: sup.id })
      .returning();
    // 旧生效版本含 mA+mB；新草稿仅 mA（mB 被移除）
    const [b1] = await db.insert(boms).values({ productSkuId: productId, versionNo: "V1", status: "active" }).returning();
    await db.insert(bomLines).values([
      { bomId: b1.id, materialSkuId: mA, qtyPer: "1.0000", lossRatePct: "0" },
      { bomId: b1.id, materialSkuId: mB, qtyPer: "1.0000", lossRatePct: "0" },
    ]);
    const [b2] = await db.insert(boms).values({ productSkuId: productId, versionNo: "V2", status: "draft" }).returning();
    v2 = b2.id;
    await db.insert(bomLines).values([{ bomId: v2, materialSkuId: mA, qtyPer: "1.0000", lossRatePct: "0" }]);
    // 委外仓仍有 mB 结存（垫料/在制）——测试夹具直插余额（只读校验，不经过账引擎）
    await db.insert(stockBalances).values({ skuId: mB, warehouseId: wh.id, batchId: null, qty: "5.0000" });
  });

  it("默认拦截：409 且列出编码与整改指引", async () => {
    await expect(activateBom(v2, approver, { db: dbx })).rejects.toThrow(
      /AG-MB.*在委外仓仍有结存.*请先核对物料流再生效.*备注注明后重试/,
    );
    const [still] = await db.select().from(boms).where(eq(boms.id, v2));
    expect(still.status).toBe("draft"); // 事务回滚，未切版
  });

  it("force=true 显式放行：生效成功 + activate_forced 审计", async () => {
    const updated = await activateBom(v2, approver, { force: true, db: dbx });
    expect(updated.status).toBe("active");
    const [old] = await db
      .select()
      .from(boms)
      .where(and(eq(boms.productSkuId, productId), eq(boms.versionNo, "V1")));
    expect(old.status).toBe("retired");
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity, "bom"), eq(auditLogs.action, "activate_forced")));
    expect(audits).toHaveLength(1);
    expect((audits[0].after as { stuckCodes: string[] }).stuckCodes).toEqual(["AG-MB"]);
  });

  it("移除物料无委外结存时不拦截", async () => {
    // V3 移除 mA（mA 无委外结存）——直接生效成功
    const [b3] = await db.insert(boms).values({ productSkuId: productId, versionNo: "V3", status: "draft" }).returning();
    await db.insert(bomLines).values([{ bomId: b3.id, materialSkuId: mB, qtyPer: "1.0000", lossRatePct: "0" }]);
    const updated = await activateBom(b3.id, approver, { db: dbx });
    expect(updated.status).toBe("active");
  });
});

describe("BOM 生效图校验：允许合法多层，阻断自引用与跨 BOM 循环", () => {
  let db: TestDb;
  let dbx: DB;
  let approver: { id: number; roles: string[]; isApprover: boolean };
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  let raw = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    dbx = db as unknown as DB;
    const [u] = await db.insert(users).values({ name: "BOM图审批", roles: ["pmc"], isApprover: true }).returning();
    approver = { id: u.id, roles: ["pmc"], isApprover: true };
    const [spu] = await db.insert(spus).values({ code: "BOM-GRAPH-SPU", nameCn: "BOM图校验" }).returning();
    const mk = async (code: string, type: "finished" | "semi" | "raw") => {
      const [sku] = await db.insert(skus).values({
        code,
        name: code,
        spuId: spu.id,
        baseUom: "个",
        skuType: type,
      }).returning();
      return sku.id;
    };
    a = await mk("GRAPH-A", "finished");
    b = await mk("GRAPH-B", "semi");
    c = await mk("GRAPH-C", "finished");
    d = await mk("GRAPH-D", "semi");
    raw = await mk("GRAPH-RAW", "raw");

    const [activeA] = await db.insert(boms).values({
      productSkuId: a,
      versionNo: "V1",
      status: "active",
    }).returning();
    await db.insert(bomLines).values({
      bomId: activeA.id,
      materialSkuId: b,
      qtyPer: "1",
      lossRatePct: "0",
    });
  });

  const draft = async (productSkuId: number, materialSkuId: number, versionNo: string) => {
    const [head] = await db.insert(boms).values({
      productSkuId,
      versionNo,
      status: "draft",
    }).returning();
    await db.insert(bomLines).values({
      bomId: head.id,
      materialSkuId,
      qtyPer: "1",
      lossRatePct: "0",
    });
    return head.id;
  };

  it("A→B 已生效时，B→A 草稿不能生效且事务不写审计", async () => {
    const candidate = await draft(b, a, "V1");
    await expect(activateBom(candidate, approver, { db: dbx })).rejects.toThrow(
      /BOM 不能生效.*GRAPH-B → GRAPH-A → GRAPH-B/,
    );
    const [still] = await db.select().from(boms).where(eq(boms.id, candidate));
    expect(still.status).toBe("draft");
    const audits = await db.select().from(auditLogs).where(and(
      eq(auditLogs.entity, "bom"),
      eq(auditLogs.entityId, candidate),
    ));
    expect(audits).toHaveLength(0);
  });

  it("自引用草稿不能生效", async () => {
    const candidate = await draft(d, d, "V1");
    await expect(activateBom(candidate, approver, { db: dbx })).rejects.toThrow(
      /BOM 不能生效.*GRAPH-D → GRAPH-D/,
    );
    const [still] = await db.select().from(boms).where(eq(boms.id, candidate));
    expect(still.status).toBe("draft");
  });

  it("合法 C→原料可以生效", async () => {
    const candidate = await draft(c, raw, "V1");
    const activated = await activateBom(candidate, approver, { db: dbx });
    expect(activated.status).toBe("active");
  });

  it("候选子树自身未超深、但与既有父链合并后超深时仍阻断，并显示 SKU 编码路径", async () => {
    const [spu] = await db.insert(spus).values({
      code: "BOM-DEEP-SPU",
      nameCn: "BOM深度校验",
    }).returning();
    const chain = await db.insert(skus).values(
      Array.from({ length: MAX_BOM_DEPTH + 9 }, (_, index) => ({
        code: `DEEP-${String(index).padStart(2, "0")}`,
        name: `深度节点${index}`,
        spuId: spu.id,
        baseUom: "个",
        skuType: index === 0 ? "finished" as const : index === MAX_BOM_DEPTH + 8 ? "raw" as const : "semi" as const,
      })),
    ).returning();
    const candidateIndex = 20;
    // 候选上游 20 层已生效。
    for (let index = 0; index < candidateIndex; index++) {
      const [head] = await db.insert(boms).values({
        productSkuId: chain[index].id,
        versionNo: "V1",
        status: "active",
      }).returning();
      await db.insert(bomLines).values({
        bomId: head.id,
        materialSkuId: chain[index + 1].id,
        qtyPer: "1",
      });
    }
    // 候选下游自身只有 20 层，小于上限；合并父链后总深度超过 32。
    for (let index = candidateIndex + 1; index < chain.length - 1; index++) {
      const [head] = await db.insert(boms).values({
        productSkuId: chain[index].id,
        versionNo: "V1",
        status: "active",
      }).returning();
      await db.insert(bomLines).values({
        bomId: head.id,
        materialSkuId: chain[index + 1].id,
        qtyPer: "1",
      });
    }
    const candidate = await draft(chain[candidateIndex].id, chain[candidateIndex + 1].id, "V1");
    await expect(activateBom(candidate, approver, { db: dbx })).rejects.toThrow(
      /层级超过 32 层安全上限 DEEP-00 → DEEP-01.*DEEP-33/,
    );
    const [still] = await db.select().from(boms).where(eq(boms.id, candidate));
    expect(still.status).toBe("draft");
  });
});
