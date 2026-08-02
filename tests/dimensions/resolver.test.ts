import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import {
  normalizeAliasText,
  resolveAlias,
  resolveKnownReference,
  resolveKnownOrQueue,
  resolveOrQueue,
  queueException,
  claimAlias,
} from "@/server/modules/dimension/resolver";

/** drizzle 包装报错在 cause 上——沿 cause 链断言唯一约束冲突 */
async function expectUniqueViolation(p: Promise<unknown>): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  const messages: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause as Error | undefined) messages.push(e.message);
  expect(messages.join(" | ")).toMatch(/unique|duplicate/i);
}

describe("normalizeAliasText（纯函数）", () => {
  it("去首尾空白", () => {
    expect(normalizeAliasText("  唯品会  ")).toBe("唯品会");
  });

  it("全角 ASCII → 半角（含全角空格）", () => {
    expect(normalizeAliasText("ＡＢＳ")).toBe("ABS");
    expect(normalizeAliasText("Ｎ００６－００１")).toBe("N006-001");
    expect(normalizeAliasText("天猫　旗舰店")).toBe("天猫 旗舰店");
    expect(normalizeAliasText("（拼多多）")).toBe("(拼多多)");
  });

  it("内部空白折叠为单个空格（含 tab/换行/全角空格混排）", () => {
    expect(normalizeAliasText("调拨  在途")).toBe("调拨 在途");
    expect(normalizeAliasText("a \t\n b　　c")).toBe("a b c");
  });

  it("不做语义变体映射（唯品/多多/在途调拨等由 alias 数据行承载，非代码）", () => {
    expect(normalizeAliasText("唯品")).toBe("唯品");
    expect(normalizeAliasText("在途调拨")).toBe("在途调拨");
  });

  it("空串/纯空白 → 空串", () => {
    expect(normalizeAliasText("   ")).toBe("");
    expect(normalizeAliasText("　")).toBe("");
  });
});

describe("别名解析器（PGlite）", () => {
  let db: TestDb;
  let vipId: number;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [vip] = await db
      .insert(schema.channels)
      .values({ code: "vip", name: "唯品会", kind: "platform" })
      .returning();
    vipId = vip.id;
    // 变体作为数据行注册（不是硬编码）
    await db.insert(schema.aliases).values([
      { aliasType: "channel", rawValue: "唯品会", targetId: vipId },
      { aliasType: "channel", rawValue: "唯品", targetId: vipId },
    ]);
  });

  it("归一后精确命中：全角/多余空格变体解析到同一 targetId", async () => {
    expect(await resolveAlias(db, "channel", "唯品会")).toBe(vipId);
    expect(await resolveAlias(db, "channel", "  唯品会  ")).toBe(vipId);
    expect(await resolveAlias(db, "channel", "唯品")).toBe(vipId);
    expect(await resolveAlias(db, "channel", "　唯品　")).toBe(vipId); // 全角空格包裹
  });

  it("未注册值 → null；空值 → null 且不入队", async () => {
    expect(await resolveAlias(db, "channel", "得物")).toBeNull();
    expect(await resolveOrQueue(db, "channel", "   ", { f: "x" })).toBeNull();
    const excs = await db.select().from(schema.aliasExceptions);
    expect(excs).toHaveLength(0);
  });

  it("resolveOrQueue：未命中入异常队列恰好一次（重复调用不重复排队）", async () => {
    const ctx = { file: "总库存明细.xlsx", row: 12, value: "拼多多-得物" };
    expect(await resolveOrQueue(db, "channel", "拼多多-得物", ctx)).toBeNull();
    expect(await resolveOrQueue(db, "channel", "拼多多-得物", ctx)).toBeNull();
    // 归一后同值（全角变体）也不新增
    await queueException(db, "channel", "拼多多－得物".replace("－", "－"), ctx);
    const excs = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.aliasType, "channel"));
    const dewu = excs.filter((e) => e.rawValue === "拼多多-得物");
    expect(dewu).toHaveLength(1);
    expect(dewu[0].status).toBe("open");
    expect(dewu[0].context).toEqual(ctx);
  });

  it("claimAlias：写别名行 + 关闭异常，随后解析即命中（一次认领永久生效）", async () => {
    const [u] = await db.insert(schema.users).values({ name: "运营01" }).returning();
    await resolveOrQueue(db, "channel", "商务达播", { row: 1 });

    await claimAlias(db, { aliasType: "channel", rawValue: "商务达播", targetId: vipId, userId: u.id });

    expect(await resolveAlias(db, "channel", "商务达播")).toBe(vipId);
    const [exc] = await db
      .select()
      .from(schema.aliasExceptions)
      .where(
        and(
          eq(schema.aliasExceptions.aliasType, "channel"),
          eq(schema.aliasExceptions.rawValue, "商务达播"),
        ),
      );
    expect(exc.status).toBe("resolved");
    expect(exc.resolvedTargetId).toBe(vipId);
    expect(exc.resolvedBy).toBe(u.id);
    expect(exc.resolvedAt).not.toBeNull();

    // 幂等重复认领可通过；不同目标不能被静默吞掉
    await claimAlias(db, { aliasType: "channel", rawValue: "商务达播", targetId: vipId });
    await expect(
      claimAlias(db, { aliasType: "channel", rawValue: "商务达播", targetId: 999999 }),
    ).rejects.toThrow("不能静默改绑");
    expect(await resolveAlias(db, "channel", "商务达播")).toBe(vipId);
  });

  it("aliasType 维度隔离：同一 rawValue 在不同类型下互不干扰", async () => {
    await db.insert(schema.aliases).values({ aliasType: "warehouse", rawValue: "唯品", targetId: 77 });
    expect(await resolveAlias(db, "channel", "唯品")).toBe(vipId);
    expect(await resolveAlias(db, "warehouse", "唯品")).toBe(77);
  });

  it("UNIQUE(aliasType, scope, rawValue) 阻止同作用域重复，但允许外部系统同码", async () => {
    await expectUniqueViolation(
      db.insert(schema.aliases).values({ aliasType: "channel", rawValue: "唯品", targetId: 123 }),
    );
    await db.insert(schema.aliases).values([
      { aliasType: "channel", scope: "JIANDAOYUN", rawValue: "唯品", targetId: 123 },
      { aliasType: "channel", scope: "YONYOU", rawValue: "唯品", targetId: 456 },
    ]);
    expect(await resolveAlias(db, "channel", "唯品", { scope: "JIANDAOYUN" })).toBe(123);
    expect(await resolveAlias(db, "channel", "唯品", { scope: "YONYOU" })).toBe(456);
  });

  it("外部 SKU 标识按系统 scope 解析；同值可安全归属不同 SKU", async () => {
    const [spu] = await db
      .insert(schema.spus)
      .values({ code: "P-SCOPE", nameCn: "系统作用域" })
      .returning();
    const [jdySku, yonyouSku] = await db
      .insert(schema.skus)
      .values([
        { code: "SCOPE-JDY", name: "简道云货品", spuId: spu.id, baseUom: "件", skuType: "finished" },
        { code: "SCOPE-YY", name: "用友货品", spuId: spu.id, baseUom: "件", skuType: "finished" },
      ])
      .returning();
    await db.insert(schema.skuIdentifiers).values([
      { skuId: jdySku.id, kind: "external", value: "EXT-001", scope: "JIANDAOYUN" },
      { skuId: yonyouSku.id, kind: "external", value: "EXT-001", scope: "YONYOU" },
    ]);

    expect(
      await resolveKnownReference(db, "sku_code", "EXT-001", { scope: "JIANDAOYUN" }),
    ).toBe(jdySku.id);
    expect(
      await resolveKnownReference(db, "sku_code", "EXT-001", { scope: "YONYOU" }),
    ).toBe(yonyouSku.id);
    expect(await resolveKnownReference(db, "sku_code", "EXT-001")).toBeNull();

    await resolveKnownOrQueue(
      db,
      "sku_code",
      "MISSING-001",
      { connector: "jdy" },
      { scope: "JIANDAOYUN" },
    );
    await resolveKnownOrQueue(
      db,
      "sku_code",
      "MISSING-001",
      { connector: "yonyou" },
      { scope: "YONYOU" },
    );
    const queued = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.rawValue, "MISSING-001"));
    expect(queued.map((row) => row.scope).sort()).toEqual(["JIANDAOYUN", "YONYOU"]);
  });

  it("外部 scope 默认严格隔离：不回退 GLOBAL，不用未分 scope 的主档码/名兜底", async () => {
    const [spu] = await db
      .insert(schema.spus)
      .values({ code: "P-JDY-BOUNDARY", nameCn: "简道云身份边界" })
      .returning();
    const [internalSku, otherSystemSku] = await db
      .insert(schema.skus)
      .values([
        { code: "COLLIDE-001", name: "内部同码", spuId: spu.id, baseUom: "件", skuType: "finished" },
        { code: "OTHER-001", name: "其他系统同码", spuId: spu.id, baseUom: "件", skuType: "finished" },
      ])
      .returning();
    const [supplier] = await db
      .insert(schema.suppliers)
      .values({ code: "SUP-COLLIDE", name: "同名供应商" })
      .returning();
    const [warehouse] = await db
      .insert(schema.warehouses)
      .values({ code: "WH-COLLIDE", name: "同名仓", kind: "finished" })
      .returning();
    await db.insert(schema.aliases).values([
      { aliasType: "sku_code", scope: "GLOBAL", rawValue: "COLLIDE-001", targetId: internalSku.id },
      { aliasType: "supplier_oem", scope: "GLOBAL", rawValue: "同名供应商", targetId: supplier.id },
      { aliasType: "warehouse", scope: "GLOBAL", rawValue: "同名仓", targetId: warehouse.id },
    ]);
    await db.insert(schema.skuIdentifiers).values({
      skuId: otherSystemSku.id,
      kind: "external",
      value: "COLLIDE-001",
      scope: "YONYOU",
    });

    const strict = { scope: "JIANDAOYUN" } as const;
    expect(await resolveAlias(db, "sku_code", "COLLIDE-001", strict)).toBeNull();
    expect(await resolveKnownReference(db, "sku_code", "COLLIDE-001", strict)).toBeNull();
    expect(await resolveKnownReference(db, "supplier_oem", "同名供应商", strict)).toBeNull();
    expect(await resolveKnownReference(db, "warehouse", "同名仓", strict)).toBeNull();

    // 历史兼容只能由调用方显式开启，不能成为外部 scope 的默认行为。
    expect(await resolveAlias(db, "sku_code", "COLLIDE-001", {
      ...strict,
      allowGlobalFallback: true,
    })).toBe(internalSku.id);
    expect(await resolveKnownReference(db, "supplier_oem", "同名供应商", {
      ...strict,
      allowUnscopedMasterMatch: true,
    })).toBe(supplier.id);

    expect(await resolveKnownOrQueue(
      db,
      "warehouse",
      "同名仓",
      { connector: "jdy", field: "warehouseName" },
      strict,
    )).toBeNull();
    const [queued] = await db
      .select()
      .from(schema.aliasExceptions)
      .where(and(
        eq(schema.aliasExceptions.aliasType, "warehouse"),
        eq(schema.aliasExceptions.scope, "JIANDAOYUN"),
        eq(schema.aliasExceptions.rawValue, "同名仓"),
      ));
    expect(queued).toMatchObject({
      status: "open",
      context: { connector: "jdy", field: "warehouseName", reason: "not_found", exactMatchCount: 0 },
    });
  });

  it("sku_code 精确命中多主档时按歧义入队，不误报未找到", async () => {
    const [spu] = await db
      .insert(schema.spus)
      .values({ code: "P-AMB", nameCn: "歧义测试" })
      .returning();
    const [first, second] = await db
      .insert(schema.skus)
      .values([
        { code: "AMB-001", name: "A", spuId: spu.id, baseUom: "件", skuType: "finished" },
        { code: "OTHER-001", name: "B", spuId: spu.id, baseUom: "件", skuType: "finished" },
      ])
      .returning();
    await db.insert(schema.skuIdentifiers).values({
      skuId: second.id,
      kind: "external",
      value: first.code,
      scope: "JST",
    });

    expect(
      await resolveKnownOrQueue(db, "sku_code", first.code, { source: "test" }),
    ).toBeNull();
    const [exception] = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.rawValue, first.code));
    expect(exception.context).toMatchObject({
      reason: "exact_master_match_ambiguous",
      exactMatchCount: 2,
    });
  });
});

describe("销量维度约束（PGlite）", () => {
  let db: TestDb;
  let skuId: number;
  let channelId: number;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [spu] = await db.insert(schema.spus).values({ code: "P00001", nameCn: "测试SPU" }).returning();
    const [sku] = await db
      .insert(schema.skus)
      .values({ code: "CP00001", name: "测试SKU", spuId: spu.id, baseUom: "盒", skuType: "finished" })
      .returning();
    const [ch] = await db
      .insert(schema.channels)
      .values({ code: "tmall", name: "天猫", kind: "platform" })
      .returning();
    skuId = sku.id;
    channelId = ch.id;
  });

  it("sales_monthly UNIQUE(skuId, channelId, yearMonth)", async () => {
    await db.insert(schema.salesMonthly).values({ skuId, channelId, yearMonth: "2024-06", qty: "100.0000" });
    await expectUniqueViolation(
      db.insert(schema.salesMonthly).values({ skuId, channelId, yearMonth: "2024-06", qty: "1.0000" }),
    );
    // 不同月份可插
    await db.insert(schema.salesMonthly).values({ skuId, channelId, yearMonth: "2024-07", qty: "5.0000" });
  });

  it("sales_velocity UNIQUE NULLS NOT DISTINCT：channelId=null(全渠道) 同日重复被拒", async () => {
    await db
      .insert(schema.salesVelocity)
      .values({ skuId, channelId: null, avg7d: "3.5000", avg90d: "2.0000", computedOn: "2026-07-23" });
    await expectUniqueViolation(
      db
        .insert(schema.salesVelocity)
        .values({ skuId, channelId: null, avg7d: "9.0000", avg90d: "9.0000", computedOn: "2026-07-23" }),
    );
    // 具体渠道与全渠道不冲突
    await db
      .insert(schema.salesVelocity)
      .values({ skuId, channelId, avg7d: "1.0000", avg90d: "1.0000", computedOn: "2026-07-23" });
  });

  it("skus 新增列可写（brandId 为应用层 FK，barcode 不唯一容畸形重复）", async () => {
    const [b] = await db.insert(schema.brands).values({ code: "NING", nameCn: "NING" }).returning();
    await db
      .update(schema.skus)
      .set({ brandId: b.id, barcode: "6901234567892", productType: "跨境品", remark: "备注" })
      .where(eq(schema.skus.id, skuId));
    // 同条码再挂一个 SKU 不报错（真实数据存在畸形重复）
    const [spu2] = await db.select().from(schema.spus);
    await db.insert(schema.skus).values({
      code: "CP00002", name: "重复条码SKU", spuId: spu2.id, baseUom: "盒",
      skuType: "finished", barcode: "6901234567892",
    });
  });
});
