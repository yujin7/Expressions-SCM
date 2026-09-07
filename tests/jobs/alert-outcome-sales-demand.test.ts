import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { runAlertOutcome, ALERT_OUTCOME_VERSION } from "@/jobs/alert-outcome";
import { createTestDb } from "../helpers/db";

describe("告警回验不把非销售作业学成销售断货证据", () => {
  it("调拨/发料/盘亏、只有被冲销销售的窗口弃权；真实销售仍可核验", async () => {
    const { db, client } = await createTestDb();
    try {
      const [spu] = await db.insert(schema.spus).values({ code: "OS", nameCn: "销售回验" }).returning();
      const [wh] = await db.insert(schema.warehouses).values({ code: "OS-W", name: "实时仓", kind: "finished" }).returning();
      let seq = 0;
      const scenarios = ["transfer", "fl_issue", "count_adjust", "stable_operations", "reversed", "sales_out"];
      for (const kind of scenarios) {
        const [sku] = await db.insert(schema.skus).values({ code: kind, name: kind, spuId: spu.id, skuType: "finished", baseUom: "件" }).returning();
        const put = (qtyDelta: string, sourceDocType: string, day: string, action = "post") => db.insert(schema.stockLedger).values({
          skuId: sku.id, warehouseId: wh.id, qtyDelta, sourceDocType, sourceDocId: ++seq, action,
          occurredAt: new Date(`${day}T00:00:00+08:00`),
        });
        await put("10", "opening", "2026-08-01");
        if (kind === "reversed") {
          // 销售在观察窗前30天，红字在观察窗内；不能各窗取正再 OR 出需求。
          await put("-10", "sales_out", "2026-08-10");
          await put("10", "stock_doc", "2026-08-22", `reverse:sales_out#${seq}`);
        } else {
          await put(kind === "stable_operations" ? "-5" : "-10", kind === "stable_operations" ? "transfer" : kind, "2026-08-22");
        }
        await db.insert(schema.systemAlerts).values({
          category: "inventory_cover", dedupeKey: `inventory_cover:${sku.id}`, refKey: sku.code,
          title: kind, status: "resolved", createdAt: new Date("2026-08-20T00:00:00+08:00"), resolvedAt: new Date("2026-08-25T00:00:00+08:00"),
        });
      }
      const result = await runAlertOutcome(db, { now: new Date("2026-09-08T00:00:00+08:00") });
      expect(result).toMatchObject({ verified: 6, truePositive: 1, falsePositive: 0, unverifiable: 5 });
      const events = await db.select().from(schema.alertEvents);
      expect(events.filter((e) => (e.evidenceRef as Record<string, unknown>).reason === "no_net_sales_demand")).toHaveLength(5);
      expect(events.every((e) => (e.evidenceRef as Record<string, unknown>).version === ALERT_OUTCOME_VERSION)).toBe(true);
      expect(await runAlertOutcome(db, { now: new Date("2026-09-08T00:00:00+08:00") })).toMatchObject({ scanned: 0, verified: 0 });
    } finally { await client.close(); }
  });
});
