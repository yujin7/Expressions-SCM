/**
 * W2 修复：「自上次访问以来」的快照必须在**打盹过滤之前**取。
 *
 * 事故形态：`getWorkbenchFocus` 把**过滤后**的可见例外清单交给访问标记。
 * 一条被打盹 30 天的例外在这 30 天里不在快照里，于是打盹到期那天它作为
 * 「上次访问后新增」重新飘红——它从来没有消失过，只是被藏起来了。
 * 控制塔的「新增」因此变成"打盹到期提醒"，读者会把一条老问题当成昨夜的新问题。
 *
 * 钉住：打盹期间快照仍记着这条例外（`workbench_visits.last_seen_keys`），
 * 打盹到期后它**不被标为新增**。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { getWorkbenchFocus } from "@/server/modules/workbench/focus";
import { shanghaiDay, snoozeException } from "@/server/modules/workbench/exception-dismissals";
import { parseSeenKeys } from "@/server/modules/workbench/visit-marker";

type Db = Awaited<ReturnType<typeof createTestDb>>["db"];

/** 造一条必然出现的例外：已过期批次库存 → key=expired_stock */
async function seedExpiredStock(db: Db) {
  const [spu] = await db.insert(schema.spus).values({ code: "VP1", nameCn: "访问标记测试" }).returning();
  const [sku] = await db.insert(schema.skus).values({ code: "VS1", name: "VS1", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  const [wh] = await db.insert(schema.warehouses).values({ code: "VW1", name: "主仓", kind: "finished", accountingMode: "realtime", active: true }).returning();
  await db.insert(schema.batchStocks).values({
    skuId: sku.id, warehouseId: wh.id, batchNo: "VB1", qty: "10.0000", expiryDate: "2020-01-01", stocktakeDate: shanghaiDay(),
  });
}

const dayOffset = (n: number): string =>
  new Date(Date.parse(`${shanghaiDay()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("访问标记的快照取在打盹过滤之前", () => {
  it("打盹期间快照仍记着这条例外；打盹到期后它不冒充「上次访问后新增」", async () => {
    const { db, client } = await createTestDb();
    try {
      const [u] = await db.insert(schema.users).values({ name: "总监", roles: ["pmc"] }).returning();
      const user = { id: u.id, name: u.name, roles: ["pmc"], isApprover: false };
      await seedExpiredStock(db);

      // 第 1 次访问（首次）：写下基线
      const first = await getWorkbenchFocus(["pmc"], db, user);
      expect(first.exceptions.map((e) => e.key)).toContain("expired_stock");
      expect(first.sinceLastVisit?.state).toBe("first_visit");

      // 打盹：页面不再显示这一条
      await snoozeException(user, { exceptionKey: "expired_stock", until: dayOffset(30), note: "已排报废评审" }, db);

      // 打盹期间访问：页面看不到它，但快照必须**仍然**记着它
      await db.update(schema.workbenchVisits)
        .set({ lastSeenAt: new Date(Date.now() - 3 * 3600_000), baselineAt: new Date(Date.now() - 4 * 3600_000) });
      const snoozedView = await getWorkbenchFocus(["pmc"], db, user);
      expect(snoozedView.exceptions.map((e) => e.key), "打盹只影响展示").not.toContain("expired_stock");
      const [visit] = await db.select().from(schema.workbenchVisits);
      expect(
        parseSeenKeys(visit.lastSeenKeys),
        "快照必须取自打盹**过滤之前**的清单——否则打盹到期那天这条老例外会冒充新增",
      ).toContain("expired_stock");

      // 打盹到期：这条例外回到页面上，但它对「上次访问」而言不是新的
      await db.update(schema.exceptionDismissals).set({ snoozedUntil: dayOffset(-1) });
      await db.update(schema.workbenchVisits)
        .set({ lastSeenAt: new Date(Date.now() - 3 * 3600_000), baselineAt: new Date(Date.now() - 4 * 3600_000) });
      const afterSnooze = await getWorkbenchFocus(["pmc"], db, user);
      const row = afterSnooze.exceptions.find((e) => e.key === "expired_stock");
      expect(row, "打盹到期后该例外回到页面").toBeDefined();
      expect(row?.newSinceLastVisit, "它从未消失，只是被藏起来了——不得标为「上次访问后新增」").toBe(false);
    } finally {
      await client.close();
    }
  });
});
