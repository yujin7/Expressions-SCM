/**
 * 盘盈亏调整的**业务时点**：按盘点期 `pd_docs.biz_date` 落账，不是按审批那一刻。
 *
 * 事故形态：8/31 的盘点 9/4 才走完审批，`post()` 不传 `occurredAt` 就落 `now()`，
 * 差异全部进 9 月流水——8 月期末数少了这笔、9 月凭空多了一笔，
 * 而库存水位/月末归属/期间对账全按 `stock_ledger.occurred_at` 分月。
 *
 * 口径：取该业务日的**日末**（23:59:59.999+08:00，盘点数是期末数，同日其它流水都在它之前）；
 * 盘点期是今天或未来时退回当前时刻，避免流水时点跑到"现在"之后。
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approvalConfigs, pdDocs, skus, spus, stockLedger, users, warehouses,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { approveStockDoc, createStockDoc, submitStockDoc } from "@/server/modules/inventory/stock-doc";
import {
  approveCountTask, countAdjustOccurredAt, createCountTask, getCountTask, submitCountTask, updateCounts,
} from "@/server/modules/inventory/count";
import { createTestDb, type TestDb } from "../helpers/db";

/** 上海时区的年月（流水归属月按上海日界判定） */
function shanghaiMonthOf(d: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" })
    .format(d).slice(0, 7);
}

describe("盘盈亏调整：业务时点按盘点期，不按审批时刻", () => {
  describe("countAdjustOccurredAt（纯函数）", () => {
    const now = new Date("2026-09-04T10:00:00+08:00");

    it("过去的盘点期 → 取该业务日日末（上海）", () => {
      const at = countAdjustOccurredAt("2026-08-31", now)!;
      expect(at.toISOString()).toBe(new Date("2026-08-31T23:59:59.999+08:00").toISOString());
      expect(shanghaiMonthOf(at)).toBe("2026-08");
    });

    it("盘点期是今天/未来 → 退回当前时刻（不让流水跑到未来）", () => {
      expect(countAdjustOccurredAt("2026-09-04", now)).toEqual(now);
      expect(countAdjustOccurredAt("2026-12-31", now)).toEqual(now);
    });

    it("缺失/脏值 → undefined（沿用过账缺省 now()）", () => {
      expect(countAdjustOccurredAt(null, now)).toBeUndefined();
      expect(countAdjustOccurredAt("", now)).toBeUndefined();
      expect(countAdjustOccurredAt("2026/08/31", now)).toBeUndefined();
    });
  });

  describe("审批过账（PGlite）", () => {
    let db: TestDb;
    let creator: SessionUser;
    let finApprover: SessionUser;
    let whId = 0;
    let skuId = 0;

    beforeAll(async () => {
      ({ db } = await createTestDb());
      const mkUser = async (name: string, roles: string[]): Promise<SessionUser> => {
        const [u] = await db.insert(users).values({ name, roles, isApprover: true }).returning();
        return { id: u.id, name: u.name, roles, isApprover: true };
      };
      creator = await mkUser("仓库制单员", ["warehouse"]);
      finApprover = await mkUser("财务审批人", ["finance"]);
      await db.insert(approvalConfigs).values([
        { docType: "stock_doc", approverRole: "warehouse" },
        { docType: "opening", approverRole: "finance" },
        { docType: "count", approverRole: "finance" },
      ]);
      const [spu] = await db.insert(spus).values({ code: "P70001", nameCn: "期间归属测试品" }).returning();
      const [wh] = await db.insert(warehouses).values({
        code: "WH-PDM", name: "月末盘点仓", kind: "raw", accountingMode: "realtime", active: true,
      }).returning();
      whId = wh.id;
      const [sku] = await db.insert(skus).values({
        code: "PD70001", name: "月末盘点物料", spuId: spu.id, baseUom: "个", skuType: "raw",
      }).returning();
      skuId = sku.id;

      const doc = await createStockDoc(creator, { subtype: "opening", warehouseId: whId, lines: [{ skuId, qty: "10" }] }, db);
      const pending = await submitStockDoc(creator, doc.id, doc.version, db);
      await approveStockDoc(finApprover, pending.id, { action: "approve", version: pending.version }, db);
    });

    it("8/31 的盘点在 9/4 审批：差异流水落 8 月，不落审批当月", async () => {
      const bizDate = "2026-08-31";
      const task = await createCountTask(
        creator,
        { warehouseId: whId, mode: "partial", filters: { skuIds: [skuId] }, bizDate },
        db,
      );
      const detail = await getCountTask(task.id, db);
      await updateCounts(creator, task.id, { version: task.version, lines: [{ lineId: detail.lines[0].id, countedQty: "12" }] }, db);
      const [afterUpd] = await db.select().from(pdDocs).where(eq(pdDocs.id, task.id));
      const pending = await submitCountTask(creator, task.id, afterUpd.version, db);
      const r = await approveCountTask(finApprover, task.id, { action: "approve", version: pending.version }, db);
      expect(r.status).toBe("completed");

      const ledger = await db.select().from(stockLedger).where(eq(stockLedger.sourceDocType, "count_adjust"));
      expect(ledger.length).toBe(1);
      // 修复前：occurredAt = now()（审批当月），差异被记进 9 月
      expect(shanghaiMonthOf(new Date(ledger[0].occurredAt))).toBe("2026-08");
      expect(new Date(ledger[0].occurredAt).toISOString())
        .toBe(new Date(`${bizDate}T23:59:59.999+08:00`).toISOString());
      expect(ledger[0].qtyDelta).toBe("2.0000");
    });
  });
});
