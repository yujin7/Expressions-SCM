import { beforeEach, describe, expect, it } from "vitest";
import { skus, spus, uomConvs } from "@/db/schema";
import { getSkuSupplyParams } from "@/server/modules/master/sku-supply-params";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * MOQ 的**单位**护栏。
 *
 * `uom_convs` 一行 = 一个采购单位，`factor` 定义是「1 采购单位 = factor 基础单位」，
 * 所以 `moq` / `order_multiple` 是以采购单位计的。而 `rules/netreq` 把它们直接和
 * 毛需求/在库/在途比较——那些全是基础单位。
 *
 * 换算前：「起订 10 箱（1 箱 = 24 支）」会被当成「起订 10 支」，建议量少一个数量级。
 * 真实数据里放行引擎建的行都是 factor=1，所以这是修**潜在**缺陷、不改现有数字；
 * 但 seed 与人工维护的多采购单位行会踩到。
 */
describe("SKU 供应参数：MOQ 必须换算到基础单位", () => {
  let db: TestDb;

  const mkSku = async (code: string): Promise<number> => {
    const [spu] = await db.insert(spus).values({ code: `SPU-${code}`, nameCn: code }).returning();
    const [s] = await db
      .insert(skus)
      .values({ spuId: spu.id, code, name: code, skuType: "finished", baseUom: "支", active: true })
      .returning();
    return s.id;
  };

  beforeEach(async () => { ({ db } = await createTestDb()); });

  it("**按箱采购时 MOQ 乘 factor**：起订 10 箱 × 24 支/箱 = 240 支", async () => {
    const id = await mkSku("BOX");
    await db.insert(uomConvs).values({ skuId: id, purchaseUom: "箱", factor: "24", moq: "10", orderMultiple: "2" });

    const p = (await getSkuSupplyParams([id], db)).get(id)!;
    expect(p.moq).toBe("240.0000");        // 换算前是 10 —— 少一个数量级
    expect(p.orderMultiple).toBe("48.0000"); // 2 箱 = 48 支
    expect(p.moqSourceUom).toBe("箱");
    expect(p.moqAmbiguous).toBe(false);
  });

  it("factor=1（放行引擎建的行）换算前后数值相同——不改现有数字", async () => {
    const id = await mkSku("BASE");
    await db.insert(uomConvs).values({ skuId: id, purchaseUom: "基础单位", factor: "1", moq: "500", orderMultiple: "24" });

    const p = (await getSkuSupplyParams([id], db)).get(id)!;
    expect(p.moq).toBe("500.0000");
    expect(p.orderMultiple).toBe("24.0000");
  });

  it("**多采购单位时优先基础单位行，并把歧义显性化**", async () => {
    const id = await mkSku("MULTI");
    // 先插箱（id 更小），再插基础单位——旧实现「首行按 id」会错取箱
    await db.insert(uomConvs).values({ skuId: id, purchaseUom: "箱", factor: "24", moq: "10" });
    await db.insert(uomConvs).values({ skuId: id, purchaseUom: "支", factor: "1", moq: "100" });

    const p = (await getSkuSupplyParams([id], db)).get(id)!;
    expect(p.moqSourceUom).toBe("支");   // 不是 id 最小的「箱」
    expect(p.moq).toBe("100.0000");
    expect(p.moqAmbiguous).toBe(true);   // 挑哪个采购单位属采购策略，必须让人看见
  });

  it("多行且都不是基础单位时取 id 最小，仍标歧义", async () => {
    const id = await mkSku("NOBASE");
    await db.insert(uomConvs).values({ skuId: id, purchaseUom: "箱", factor: "24", moq: "10" });
    await db.insert(uomConvs).values({ skuId: id, purchaseUom: "托", factor: "240", moq: "1" });

    const p = (await getSkuSupplyParams([id], db)).get(id)!;
    expect(p.moqSourceUom).toBe("箱");
    expect(p.moq).toBe("240.0000");
    expect(p.moqAmbiguous).toBe(true);
  });

  it("无 uom_convs 行 → MOQ 为 null，不兜底成 0（0 会被当成「无起订量约束」）", async () => {
    const id = await mkSku("NONE");
    const p = (await getSkuSupplyParams([id], db)).get(id)!;
    expect(p.moq).toBeNull();
    expect(p.orderMultiple).toBeNull();
    expect(p.moqSourceUom).toBeNull();
    expect(p.moqAmbiguous).toBe(false);
  });

  it("moq 为空但行存在时不臆造数值", async () => {
    const id = await mkSku("EMPTY");
    await db.insert(uomConvs).values({ skuId: id, purchaseUom: "支", factor: "1", moq: null, orderMultiple: null });

    const p = (await getSkuSupplyParams([id], db)).get(id)!;
    expect(p.moq).toBeNull();
    expect(p.moqSourceUom).toBe("支");
  });
});
