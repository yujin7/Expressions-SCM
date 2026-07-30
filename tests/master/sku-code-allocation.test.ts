import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, brands, docCounters, skus, spus, users } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { createSku, updateSku } from "@/server/modules/master/sku";
import { generateGovernedSkuCode, parseGovernedSkuCode } from "@/server/rules/sku-code";

describe("SKU S1 事务取号", () => {
  it("编码留空时在创建事务内按全局流水生成，历史手工码仍兼容", async () => {
    const { db } = await createTestDb();
    const [spu] = await db.insert(spus).values({ code: "P99101", nameCn: "编码测试" }).returning();
    const [brand] = await db.insert(brands).values({ code: "EXP", nameCn: "EXPRESSIONS" }).returning();

    const first = await createSku({
      name: "自动码成品",
      spuId: spu.id,
      skuType: "finished",
      baseUom: "盒",
      brandId: brand.id,
    }, undefined, db);
    const second = await createSku({
      name: "自动码共享包材",
      spuId: spu.id,
      skuType: "packaging",
      baseUom: "个",
    }, undefined, db);
    const legacy = await createSku({
      code: "N02-003-a",
      name: "历史码",
      spuId: spu.id,
      skuType: "finished",
      baseUom: "盒",
    }, undefined, db);

    expect(parseGovernedSkuCode(first.code)).toMatchObject({ origin: "EXP", skuType: "finished", sequence: 1 });
    expect(parseGovernedSkuCode(second.code)).toMatchObject({ origin: "GEN", skuType: "packaging", sequence: 2 });
    expect(legacy.code).toBe("N02-003-a");
    const [counter] = await db
      .select()
      .from(docCounters)
      .where(eq(docCounters.prefix, "SKU-S1"));
    expect(counter).toMatchObject({ bizDate: "GLOBAL", lastNo: 2 });
  });

  it("计数器落后且生成码已存在时继续取号，不用 MAX+1", async () => {
    const { db } = await createTestDb();
    const [spu] = await db.insert(spus).values({ code: "P99102", nameCn: "碰撞测试" }).returning();
    const collision = generateGovernedSkuCode({ origin: "GEN", skuType: "raw", sequence: 1 });
    await db.insert(skus).values({
      code: collision,
      name: "历史碰撞",
      spuId: spu.id,
      skuType: "raw",
      baseUom: "kg",
    });

    const created = await createSku({
      name: "新原料",
      spuId: spu.id,
      skuType: "raw",
      baseUom: "kg",
    }, undefined, db);
    expect(parseGovernedSkuCode(created.code)).toMatchObject({ sequence: 2 });
  });

  it("S1 只允许系统取号；来源快照不随当前品牌改写，类型仍不可变", async () => {
    const { db } = await createTestDb();
    const [spu] = await db.insert(spus).values({ code: "P99103", nameCn: "校验测试" }).returning();
    const [brand] = await db.insert(brands).values({ code: "NING", nameCn: "NING" }).returning();
    const [newBrand] = await db.insert(brands).values({ code: "EXP", nameCn: "EXPRESSIONS" }).returning();
    const [user] = await db.insert(users).values({
      username: "sku-origin-governor",
      name: "SKU 治理员",
      passwordHash: "x",
      roles: ["admin"],
    }).returning();
    const actor = { id: user.id, name: user.name, roles: ["admin"], isApprover: true };
    const valid = generateGovernedSkuCode({ origin: "NING", skuType: "finished", sequence: 77 });

    await expect(createSku({
      code: valid,
      name: "手工 S1",
      spuId: spu.id,
      skuType: "finished",
      baseUom: "盒",
      brandId: brand.id,
    }, undefined, db)).rejects.toThrow("请将编码留空");

    const created = await createSku({
      name: "系统 S1",
      spuId: spu.id,
      skuType: "finished",
      baseUom: "盒",
      brandId: brand.id,
    }, undefined, db);

    const reassigned = await updateSku(created.id, {
      code: created.code,
      name: created.name,
      spuId: spu.id,
      skuType: "finished",
      baseUom: "盒",
      brandId: newBrand.id,
    }, actor, db);
    expect(reassigned.brandId).toBe(newBrand.id);
    expect(parseGovernedSkuCode(reassigned.code)).toMatchObject({
      origin: "NING",
      skuType: "finished",
    });
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entity, "sku"));
    expect(audit).toMatchObject({
      entityId: created.id,
      userId: user.id,
      action: "update",
    });
    expect((audit.before as { brandId: number }).brandId).toBe(brand.id);
    expect((audit.after as { brandId: number }).brandId).toBe(newBrand.id);

    await expect(updateSku(created.id, {
      code: created.code,
      name: created.name,
      spuId: spu.id,
      skuType: "packaging",
      baseUom: "个",
      brandId: brand.id,
    }, undefined, db)).rejects.toThrow("S1 稳定身份不可变");
  });
});
