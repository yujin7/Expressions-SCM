import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, brands, channels, skuParams, skus, spus, users } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { applySkuStandardName, createSku, updateSku } from "@/server/modules/master/sku";

describe("SKU 标准化写路径", () => {
  it("采用服务端建议名时只改名称、稳定主码不变，并同事务审计", async () => {
    const { db } = await createTestDb();
    const [user] = await db.insert(users).values({
      username: "sku_std_actor",
      name: "SKU治理",
      roles: ["pmc"],
      isApprover: true,
    }).returning();
    const actor = { id: user.id, name: user.name, roles: ["pmc"], isApprover: true };
    const [spu] = await db.insert(spus).values({ code: "P99001", nameCn: "胶原蛋白肽饮" }).returning();
    const [brand] = await db.insert(brands).values({ code: "EXP-T", nameCn: "EXPRESSIONS" }).returning();
    const [channel] = await db.insert(channels).values({ code: "tmall-t", name: "天猫", kind: "platform" }).returning();
    const created = await createSku({
      code: "STD-001",
      name: "旧名称",
      spuId: spu.id,
      skuType: "finished",
      baseUom: "盒",
      brandId: brand.id,
      channelId: channel.id,
      shortName: "胶原蛋白肽饮",
      version: "升级版",
      spec: "50ml×10",
      commercialRole: "retail",
      logisticsLeadDays: 4,
    }, actor, db);

    const applied = await applySkuStandardName(created.id, actor, db);
    expect(applied).toMatchObject({
      code: "STD-001",
      name: "EXPRESSIONS 天猫 胶原蛋白肽饮 升级版 50ml×10",
      unchanged: false,
    });
    const [row] = await db.select().from(skus).where(eq(skus.id, created.id));
    expect(row.code).toBe("STD-001");
    expect(row.name).toBe(applied.name);
    const [params] = await db.select().from(skuParams).where(eq(skuParams.skuId, created.id));
    expect(params.logisticsLeadDays).toBe(4);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, created.id));
    expect(audits.map((audit) => audit.action)).toContain("standardize_name");
  });

  it("禁止直接改动已使用的 SKU 主码", async () => {
    const { db } = await createTestDb();
    const [spu] = await db.insert(spus).values({ code: "P99002", nameCn: "稳定码" }).returning();
    const created = await createSku({
      code: "STABLE-001",
      name: "稳定码测试",
      spuId: spu.id,
      skuType: "finished",
      baseUom: "个",
    }, undefined, db);
    await expect(updateSku(created.id, {
      code: "STABLE-002",
      name: "稳定码测试",
      spuId: spu.id,
      skuType: "finished",
      baseUom: "个",
      active: true,
    }, undefined, db)).rejects.toThrow("不可直接改码");
  });
});
