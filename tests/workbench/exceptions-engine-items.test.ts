/**
 * 审阅修复：computeExceptions 里 D56/D57 的爆单/断货项曾被写进 `if (docAging > 0)` 分支——
 * 没有单据超时告警时整块消失。钉住：无 doc_aging 也要出现；memoMs 打开时同一 db 60 秒内复用。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { computeExceptions } from "@/server/modules/workbench/focus";
import { createTestDb } from "../helpers/db";

describe("例外清单：预警引擎项独立于单据超时", () => {
  it("只有 inventory_cover / sales_spike open 告警（无 doc_aging）→ 两项都出现且计数为真", async () => {
    const { db, client } = await createTestDb();
    try {
      await db.insert(schema.systemAlerts).values([
        { category: "inventory_cover", refKey: "sku:1", dedupeKey: "sku:1", title: "断货", severity: "high", status: "open" },
        { category: "inventory_cover", refKey: "sku:2", dedupeKey: "sku:2", title: "断货", severity: "high", status: "open" },
        { category: "sales_spike", refKey: "sku:3", dedupeKey: "sku:3", title: "爆单", severity: "critical", status: "open" },
        { category: "sales_spike", refKey: "sku:4", dedupeKey: "sku:4", title: "已关", severity: "critical", status: "resolved" },
      ]);
      const items = await computeExceptions(db);
      expect(items.find((i) => i.key === "doc_aging")).toBeUndefined();
      expect(items.find((i) => i.key === "inventory_cover")?.count).toBe(2);
      expect(items.find((i) => i.key === "sales_spike")?.count).toBe(1);
      // memo：同一 db 60 秒内复用；新增告警不会立刻反映（驾驶舱刷新分钟级足够）
      const memo1 = await computeExceptions(db, { memoMs: 60_000 });
      await db.insert(schema.systemAlerts).values({ category: "sales_spike", refKey: "sku:5", dedupeKey: "sku:5", title: "爆单", severity: "critical", status: "open" });
      const memo2 = await computeExceptions(db, { memoMs: 60_000 });
      expect(memo2).toBe(memo1);
      expect((await computeExceptions(db)).find((i) => i.key === "sales_spike")?.count).toBe(2);
    } finally {
      await client.close();
    }
  });
});
