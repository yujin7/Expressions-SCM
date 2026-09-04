/**
 * C2 回归：**补录的跨月盘点必须挡住它所属的那个月**的月结清单。
 *
 * 死锁形状（红队实证）：
 *  1. `inventory/count.ts` 按 `pd_docs.biz_date` 落账（8/31 的盘点 9/4 审批也归 8 月）；
 *  2. 可 `settlement/month-close.ts` 的 `inventory_count` 检查按 `created_at` 圈月；
 *  3. 于是 7/31 盘、8/2 才录进来的那张单，在 7 月清单上**根本不存在** → 7 月照常关账；
 *  4. 再去审批它，`post()` 撞期间锁 CLOSED_PERIOD 整笔回滚，而 `occurredAt` 由 biz_date 决定、
 *     改不了 → **这张盘点单永久无法审批**。
 *
 * 两条断言就是这条链的两端：清单必须看见它（挡住关账），以及万一还是关了，
 * 审批要给出说得清下一步的 409 而不是一个不知所云的错误。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  approvalConfigs, pdDocs, periodLocks, skus, spus, stockDocs, users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { approveStockDoc, createStockDoc, submitStockDoc } from "@/server/modules/inventory/stock-doc";
import {
  approveCountTask, createCountTask, getCountTask, submitCountTask, updateCounts,
} from "@/server/modules/inventory/count";
import { getMonthCloseChecklist } from "@/server/modules/settlement/month-close";
import { ApiError } from "@/server/modules/master/common";
import { createTestDb, type TestDb } from "../helpers/db";

/** 盘点期落在 7 月，录入/创建时间落在 8 月——`created_at` 与 `biz_date` 分属两个月，正是事故形状 */
const COUNT_BIZ_DATE = "2026-07-31";
const ENTERED_AT = new Date("2026-08-02T03:00:00Z");

describe("C2 补录的跨月盘点挡住它所属月份的关账", () => {
  let db: TestDb;
  let creator: SessionUser;
  let finance: SessionUser;
  let whId = 0;
  let skuId = 0;
  let pdId = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const mkUser = async (name: string, roles: string[]): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover: true }).returning();
      return { id: u.id, name: u.name, roles, isApprover: true };
    };
    creator = await mkUser("仓库制单员", ["warehouse"]);
    finance = await mkUser("财务审批人", ["finance", "admin"]);
    await db.insert(approvalConfigs).values([
      { docType: "stock_doc", approverRole: "warehouse" },
      { docType: "opening", approverRole: "finance" },
      { docType: "count", approverRole: "finance" },
    ]);
    const [spu] = await db.insert(spus).values({ code: "C2SPU", nameCn: "跨月盘点测试品" }).returning();
    const [wh] = await db.insert(warehouses).values({
      code: "WH-C2", name: "跨月盘点仓", kind: "raw", accountingMode: "realtime", active: true,
    }).returning();
    whId = wh.id;
    const [sku] = await db.insert(skus).values({
      code: "C2SKU", name: "跨月盘点物料", spuId: spu.id, baseUom: "个", skuType: "raw",
    }).returning();
    skuId = sku.id;

    const doc = await createStockDoc(creator, { subtype: "opening", warehouseId: whId, lines: [{ skuId, qty: "100" }] }, db);
    const pending = await submitStockDoc(creator, doc.id, doc.version, db);
    await approveStockDoc(finance, pending.id, { action: "approve", version: pending.version }, db);

    // 7/31 的盘点，8/2 才录进系统（把 created_at 直接改成 8 月，重现补录）
    const task = await createCountTask(
      creator,
      { warehouseId: whId, mode: "partial", filters: { skuIds: [skuId] }, bizDate: COUNT_BIZ_DATE },
      db,
    );
    pdId = task.id;
    const detail = await getCountTask(task.id, db);
    await updateCounts(creator, task.id, { version: task.version, lines: [{ lineId: detail.lines[0].id, countedQty: "90" }] }, db);
    const [afterUpd] = await db.select().from(pdDocs).where(eq(pdDocs.id, task.id));
    await submitCountTask(creator, task.id, afterUpd.version, db);
    await db.update(pdDocs).set({ createdAt: ENTERED_AT }).where(eq(pdDocs.id, task.id));
  });

  it("7 月清单必须看见这张待处理盘点并判 blocked（修复前它只出现在 8 月，7 月一路 pass）", async () => {
    const july = await getMonthCloseChecklist("2026-07", db);
    const julyCount = july.checks.find((i) => i.key === "inventory_count")!;
    expect(julyCount.autoState, "按业务日期归月，7 月必须被这张盘点挡住").toBe("blocked");
    expect(julyCount.evidence).toMatchObject({ countTotal: 1, countOpen: 1 });

    // 8 月（录入月）反过来不该再认领它——一张单只属于一个业务月，否则两个月互相推诿
    const august = await getMonthCloseChecklist("2026-08", db);
    const augCount = august.checks.find((i) => i.key === "inventory_count")!;
    expect(augCount.evidence).toMatchObject({ countTotal: 0 });
    expect(augCount.autoState).toBe("attention");
  });

  it("万一 7 月还是被关了：审批给出可执行的 409（说清 biz_date 改不了、要重开期间），不是不知所云的错误", async () => {
    await db.insert(periodLocks).values({ period: "2026-07", closedBy: finance.id, closedAt: new Date() });
    const [cur] = await db.select().from(pdDocs).where(eq(pdDocs.id, pdId));
    await expect(
      approveCountTask(finance, pdId, { action: "approve", version: cur.version }, db),
    ).rejects.toMatchObject({ status: 409 });

    const err = await approveCountTask(finance, pdId, { action: "approve", version: cur.version }, db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toContain("已关账");
    expect((err as ApiError).message).toContain("重开该期间");

    // 整笔回滚：调整单一张也不许留下（差异行的 adjust_doc_id 也不该被回填）
    expect(await db.select().from(stockDocs).where(eq(stockDocs.subtype, "count_adjust"))).toHaveLength(0);
  });
});
