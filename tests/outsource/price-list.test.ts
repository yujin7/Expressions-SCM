/**
 * W2 审计 2 回归：采购价目表 `price_lists` 必须有维护入口。
 *
 * 事故形态：`price_lists` 同时是 R1 比价基准的兜底、`/report/price-compare` 的唯一数据源、
 * 委外结算扣款单价的代理（真出钱），而它**唯一的写入者是 seed 脚本**——上线后基准价永远是种子值。
 * 修复前本文件里的 `createPriceList / updatePriceList / deletePriceList` 根本不存在（模块解析即失败）。
 *
 * 钉住四件事：
 *  1) 角色门：非采购/管理员写入 403；
 *  2) 审计：每条写路径都在同事务留 audit_logs；
 *  3) 生效日口径与 `outsource/po.ts` findBaseline 逐字一致（未来价不提前生效、生效后立刻成为基准）；
 *  4) 已生效行不能被采购随手删掉（删了会静默改写 R1 基准与扣款代理价，且无版本链）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, priceLists, skus, spus, suppliers, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import {
  createPriceList, currentPriceListRow, deletePriceList, listPriceLists, updatePriceList,
} from "@/server/modules/outsource/price-list";
import { createTestDb, type TestDb } from "../helpers/db";

const dayOffset = (days: number): string =>
  new Date(Date.parse(`${todayShanghai()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe("采购价目表 CRUD（W2 审计 2）", () => {
  let db: TestDb;
  let buyer: SessionUser;
  let warehouse: SessionUser;
  let admin: SessionUser;
  let skuId = 0;
  let supplierId = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [b] = await db.insert(users).values({ username: "pl_buyer", name: "采购", roles: ["purchasing"] }).returning();
    const [w] = await db.insert(users).values({ username: "pl_wh", name: "仓管", roles: ["warehouse"] }).returning();
    const [a] = await db.insert(users).values({ username: "pl_admin", name: "管理员", roles: ["admin"] }).returning();
    const asUser = (u: { id: number; name: string }, roles: string[]): SessionUser =>
      ({ id: u.id, name: u.name, roles, isApprover: false, channelScope: null });
    buyer = asUser(b, ["purchasing"]);
    warehouse = asUser(w, ["warehouse"]);
    admin = asUser(a, ["admin"]);
    const [spu] = await db.insert(spus).values({ code: "PL-SPU", nameCn: "价目产品" }).returning();
    const [sku] = await db.insert(skus).values({ code: "PL-SKU", name: "原料", spuId: spu.id, baseUom: "支", skuType: "raw" }).returning();
    skuId = sku.id;
    const [sup] = await db.insert(suppliers).values({ code: "PL-SUP", name: "价目供应商", kinds: ["raw"], status: "qualified" }).returning();
    supplierId = sup.id;
  });

  it("仓管无权维护基准价；采购可以，且写审计", async () => {
    await expect(
      createPriceList(warehouse, { skuId, supplierId, price: "10.00", effectiveDate: todayShanghai() }, db),
    ).rejects.toMatchObject({ status: 403 });

    const row = await createPriceList(buyer, { skuId, supplierId, price: "10.00", effectiveDate: todayShanghai() }, db);
    expect(row).toMatchObject({ price: "10.00", currency: "CNY", isCurrent: true, isFuture: false });

    const audits = await db.select().from(auditLogs).where(
      and(eq(auditLogs.entity, "price_list"), eq(auditLogs.action, "create")),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(buyer.id);
  });

  it("生效日口径与 po.ts findBaseline 一致：未来价不提前生效，生效后取最新一条", async () => {
    await createPriceList(buyer, { skuId, supplierId, price: "10.00", effectiveDate: dayOffset(-30) }, db);
    await createPriceList(buyer, { skuId, supplierId, price: "12.00", effectiveDate: dayOffset(30) }, db);

    // 今日取到的是 10.00（未来的 12.00 还没生效）——这正是 R1 比价与扣款代理会读到的行
    expect((await currentPriceListRow(db, { skuId, supplierId }))?.price).toBe("10.00");
    // 到了未来生效日再取，才是 12.00
    expect((await currentPriceListRow(db, { skuId, supplierId, asOf: dayOffset(30) }))?.price).toBe("12.00");

    const { rows } = await listPriceLists(buyer, {}, db);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(rows.find((r) => r.isCurrent)!.price).toBe("10.00");
    expect(rows.find((r) => r.isFuture)!.price).toBe("12.00");
  });

  it("同 SKU×供应商×渠道×生效日唯一：重复录入 409，改价要新增更晚生效日的行", async () => {
    await createPriceList(buyer, { skuId, supplierId, price: "10.00", effectiveDate: dayOffset(-1) }, db);
    await expect(
      createPriceList(buyer, { skuId, supplierId, price: "11.00", effectiveDate: dayOffset(-1) }, db),
    ).rejects.toMatchObject({ status: 409 });
    // 新增更晚生效日 → 成为当前基准
    await createPriceList(buyer, { skuId, supplierId, price: "11.00", effectiveDate: todayShanghai() }, db);
    expect((await currentPriceListRow(db, { skuId, supplierId }))?.price).toBe("11.00");
  });

  it("改价只改价格/币种并写审计；身份字段不可改（schema 不接受）", async () => {
    const row = await createPriceList(buyer, { skuId, supplierId, price: "10.00", effectiveDate: todayShanghai() }, db);
    await updatePriceList(buyer, row.id, { price: "9.50" }, db);
    const [after] = await db.select().from(priceLists).where(eq(priceLists.id, row.id));
    expect(after.price).toBe("9.50");
    const audits = await db.select().from(auditLogs).where(
      and(eq(auditLogs.entity, "price_list"), eq(auditLogs.action, "update")),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toMatchObject({ price: "10.00" });
    // 空补丁被 schema 拒绝（不接受「什么都不改」的写请求）
    await expect(updatePriceList(buyer, row.id, {}, db)).rejects.toBeInstanceOf(Error);
  });

  it("已生效行采购删不掉（会静默改写 R1 基准与扣款代理价），管理员可删；未来行采购可删", async () => {
    const effective = await createPriceList(buyer, { skuId, supplierId, price: "10.00", effectiveDate: dayOffset(-1) }, db);
    const future = await createPriceList(buyer, { skuId, supplierId, price: "12.00", effectiveDate: dayOffset(10) }, db);

    await expect(deletePriceList(buyer, effective.id, db)).rejects.toMatchObject({ status: 409 });
    await deletePriceList(buyer, future.id, db); // 未来行还没影响过任何判定
    await deletePriceList(admin, effective.id, db);
    expect(await db.select().from(priceLists)).toHaveLength(0);
    const audits = await db.select().from(auditLogs).where(
      and(eq(auditLogs.entity, "price_list"), eq(auditLogs.action, "delete")),
    );
    expect(audits).toHaveLength(2);
  });

  it("引用校验：不存在的 SKU / 供应商不落库", async () => {
    await expect(
      createPriceList(buyer, { skuId: 999_999, supplierId, price: "1.00", effectiveDate: todayShanghai() }, db),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      createPriceList(buyer, { skuId, supplierId: 999_999, price: "1.00", effectiveDate: todayShanghai() }, db),
    ).rejects.toBeInstanceOf(ApiError);
    expect(await db.select().from(priceLists)).toHaveLength(0);
  });
});
