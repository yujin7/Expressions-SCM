import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import { seedDimensions } from "@/db/seed-dimensions";
import { resolveAlias } from "@/server/modules/dimension/resolver";

describe("seedDimensions 幂等性（PGlite）", () => {
  it("首轮全插入，重跑全跳过且无重复行", async () => {
    const { db } = await createTestDb();

    const first = await seedDimensions(db);
    expect(first.brands).toEqual({ inserted: 8, skipped: 0 });
    expect(first.channels).toEqual({ inserted: 10, skipped: 0 });
    expect(first.aliases.inserted).toBeGreaterThanOrEqual(11); // 7 品牌别名 + 4 渠道别名
    expect(first.aliases.skipped).toBe(0);

    const second = await seedDimensions(db);
    expect(second.brands).toEqual({ inserted: 0, skipped: 8 });
    expect(second.channels).toEqual({ inserted: 0, skipped: 10 });
    expect(second.aliases.inserted).toBe(0);
    expect(second.aliases.skipped).toBe(first.aliases.inserted);

    expect((await db.select().from(schema.brands)).length).toBe(8);
    expect((await db.select().from(schema.channels)).length).toBe(10);
    expect((await db.select().from(schema.aliases)).length).toBe(first.aliases.inserted);
  });

  it("品牌/渠道别名行生效：爱碧生→ABS、国内品牌LYUV→LYUV、唯品→vip、多多→pdd、拼多多-得物→pdd", async () => {
    const { db } = await createTestDb();
    await seedDimensions(db);

    const [abs] = await db.select().from(schema.brands).where(eq(schema.brands.code, "ABS"));
    const [lyuv] = await db.select().from(schema.brands).where(eq(schema.brands.code, "LYUV"));
    expect(await resolveAlias(db, "brand", "爱碧生")).toBe(abs.id);
    expect(await resolveAlias(db, "brand", "国内品牌LYUV")).toBe(lyuv.id);

    const [vip] = await db.select().from(schema.channels).where(eq(schema.channels.code, "vip"));
    const [pdd] = await db.select().from(schema.channels).where(eq(schema.channels.code, "pdd"));
    const [biz] = await db.select().from(schema.channels).where(eq(schema.channels.code, "biz"));
    expect(await resolveAlias(db, "channel", "唯品")).toBe(vip.id);
    expect(await resolveAlias(db, "channel", "多多")).toBe(pdd.id);
    expect(await resolveAlias(db, "channel", "拼多多-得物")).toBe(pdd.id);
    expect(await resolveAlias(db, "channel", "商务达播")).toBe(biz.id);
    expect(vip.kind).toBe("platform");
    expect(biz.kind).toBe("dept");
  });

  it("调拨在途仓已建时，追加 调拨在途/在途调拨 两个仓库别名（数据行，非代码硬编码）", async () => {
    const { db } = await createTestDb();
    const [wh] = await db
      .insert(schema.warehouses)
      .values({ code: "WH-ZT", name: "调拨在途", kind: "transit", accountingMode: "realtime" })
      .returning();

    await seedDimensions(db);
    expect(await resolveAlias(db, "warehouse", "调拨在途")).toBe(wh.id);
    expect(await resolveAlias(db, "warehouse", "在途调拨")).toBe(wh.id);

    // 重跑仍幂等
    const again = await seedDimensions(db);
    expect(again.aliases.inserted).toBe(0);
  });
});
