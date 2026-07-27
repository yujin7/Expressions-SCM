import { beforeAll, describe, expect, it } from "vitest";
import { bhDocs, skus, spus, suppliers, users } from "@/db/schema";
import { matchesRomanizedName, searchAll } from "@/server/modules/inbox/search";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * 全局搜索 API 形状：{groups:[{title, items:[{label, href, tag}]}]}
 * - SKU 编码/名称/拼音/首字母模糊；单据号前缀；供应商编码/名称/拼音
 * - q<2 字符 → 空组
 */
describe("search：全局搜索（SKU/单据/供应商）", () => {
  let db: TestDb;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [u] = await db.insert(users).values({ name: "制单人", roles: ["pmc"], isApprover: false }).returning();
    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    await db.insert(skus).values([
      { code: "CP00001", name: "胶原蛋白肽饮品", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "YL00001", name: "胶原蛋白肽粉", spuId: spu.id, skuType: "raw", baseUom: "kg" },
    ]);
    await db.insert(suppliers).values({ code: "SUP001", name: "原料供应商A", kinds: ["raw"], status: "qualified" });
    await db.insert(bhDocs).values({ docNo: "BH20260701-001", status: "pending", createdBy: u.id });
  });

  it("q<2 字符：返回空组", async () => {
    expect(await searchAll("B", db)).toEqual({ groups: [] });
    expect(await searchAll("  ", db)).toEqual({ groups: [] });
  });

  it("SKU 编码命中：商品组，href 直达库存余额", async () => {
    const r = await searchAll("CP000", db);
    const g = r.groups.find((x) => x.title === "商品");
    expect(g).toBeDefined();
    expect(g!.items[0]).toEqual({
      label: "CP00001 胶原蛋白肽饮品",
      href: "/inventory/balance?q=CP00001",
      tag: "SKU",
    });
  });

  it("SKU 名称命中（中文模糊）：两条都返回", async () => {
    const r = await searchAll("胶原蛋白", db);
    const g = r.groups.find((x) => x.title === "商品");
    expect(g!.items).toHaveLength(2);
  });

  it("SKU 中文名支持连续全拼与首字母，且不把非连续乱序当命中", async () => {
    const full = await searchAll("jiaoyuandanbaitaiyinpin", db);
    expect(full.groups.find((x) => x.title === "商品")?.items[0]?.label).toBe(
      "CP00001 胶原蛋白肽饮品",
    );

    const initials = await searchAll("jydbtyp", db);
    expect(initials.groups.find((x) => x.title === "商品")?.items[0]?.label).toBe(
      "CP00001 胶原蛋白肽饮品",
    );
    expect((await searchAll("jydbt", db)).groups.find((x) => x.title === "商品")?.items).toHaveLength(2);
    expect(matchesRomanizedName("胶原蛋白肽饮品", "jiao-yuan dan-bai-tai-yin-pin")).toBe(true);
    expect(matchesRomanizedName("（微初）水杨酸植萃焕肤面膜(25ml×15片)", "wcsy")).toBe(true);
    expect(matchesRomanizedName("重庆美妆供应链", "cq")).toBe(true);
    expect(matchesRomanizedName("胶原蛋白肽饮品", "jypd")).toBe(false);
  });

  it("单据号前缀命中：单据组带类型 tag 与列表页 href", async () => {
    const r = await searchAll("BH2026", db);
    const g = r.groups.find((x) => x.title === "单据");
    expect(g).toBeDefined();
    expect(g!.items).toEqual([{ label: "BH20260701-001", href: "/outsource/bh", tag: "备货申请" }]);
  });

  it("供应商命中：供应商组 href 直达主数据", async () => {
    const r = await searchAll("原料供应", db);
    const g = r.groups.find((x) => x.title === "供应商");
    expect(g!.items).toEqual([{ label: "SUP001 原料供应商A", href: "/master/supplier?q=SUP001", tag: "供应商" }]);
  });

  it("供应商中文名支持拼音首字母", async () => {
    const r = await searchAll("ylgys", db);
    const g = r.groups.find((x) => x.title === "供应商");
    expect(g?.items[0]).toEqual({
      label: "SUP001 原料供应商A",
      href: "/master/supplier?q=SUP001",
      tag: "供应商",
    });
  });

  it("无命中：不产出空组", async () => {
    const r = await searchAll("ZZZZ不存在", db);
    expect(r.groups).toEqual([]);
  });
});
