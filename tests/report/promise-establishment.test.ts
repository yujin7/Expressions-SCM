/**
 * C5 回归：**「第一条可信修订」本身不能成为洗白的入口**。
 *
 * 两个独立的漏洞，两组用例：
 *
 * ① 承诺建立行缺失。`po-promise.appendPoPromiseRevisions` 在「确认日期 == 当前有效日期」时
 *    一条行都不写；而 `po-confirm.generateConfirmToken` 会重置 `confirm_token_used_at`，
 *    第二次确认是允许的。于是：
 *      买手期望 03-01 → 供应商确认 03-01（**无行**）→ 重发 token → 供应商改到 03-30（这才是第一条行）
 *    `rules/promise-basis` 读出 `originalPromisedDate = 03-30`、`historyState = "trusted"`，
 *    03-28 到货算 OTIF **命中**——在号称「洗不白」的口径下洗白成功。
 *    修法：供应商第一次确认必写一条**承诺建立行**，即使日期没变。
 *
 * ② 可信来源用的是**黑名单**（`source !== legacy_backfill`）。`po_promise_revisions` 的
 *    来源集合里还有 `buyer_revision`：哪天接上买手改期的写入，**买手自己填的日期**
 *    就会被当成「供应商的原始承诺」并标 trusted——被评价方的对手方随手写定评分基准。
 *    修法：改成白名单 `TRUSTED_PROMISE_SOURCES`。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { poDocs, poLines, poPromiseRevisions, skus, spus, suppliers, users } from "@/db/schema";
import { generateConfirmToken, submitPoConfirm } from "@/server/modules/outsource/po-confirm";
import type { SessionUser } from "@/server/core/dto";
import { resolvePromiseBasis, TRUSTED_PROMISE_SOURCES } from "@/server/rules/promise-basis";
import { createTestDb, type TestDb } from "../helpers/db";

describe("C5① 供应商首次确认必须留下「承诺建立」行", () => {
  let db: TestDb;
  let buyer: SessionUser;
  let poId = 0;

  const revisionsOf = () => db
    .select().from(poPromiseRevisions)
    .where(eq(poPromiseRevisions.poId, poId))
    .orderBy(asc(poPromiseRevisions.sequence));

  const confirm = async (date: string): Promise<void> => {
    const { token } = await generateConfirmToken(buyer, poId, db);
    await submitPoConfirm(token, { expectedDate: date }, db);
  };

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [b] = await db.insert(users).values({ name: "买手", roles: ["purchasing"], isApprover: true }).returning();
    buyer = { id: b.id, name: b.name, roles: ["purchasing"], isApprover: true, channelScope: null } as SessionUser;
    const [sup] = await db.insert(suppliers).values({ code: "C5-SUP", name: "改期供应商", kinds: ["raw"], status: "qualified" }).returning();
    const [spu] = await db.insert(spus).values({ code: "C5-SPU", nameCn: "承诺测试品" }).returning();
    const [sku] = await db.insert(skus).values({ code: "C5-SKU", name: "原料", spuId: spu.id, baseUom: "kg", skuType: "raw" }).returning();
    // 买手下单时自己填的预计到货日 = 03-01
    const [po] = await db.insert(poDocs).values({
      docNo: "PO-C5-1", status: "approved", supplierId: sup.id, createdBy: b.id, expectedDate: "2026-03-01",
    }).returning();
    poId = po.id;
    await db.insert(poLines).values({
      poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "kg", uomFactor: "1", qty: "10", price: "10.00",
    });
  });

  it("确认日期与买手预填日一致时也写行：previousDate=买手预填日，promisedDate=供应商确认日", async () => {
    await confirm("2026-03-01");
    const rows = await revisionsOf();
    expect(rows, "「没改期」不等于「没承诺过」——建立行必须留痕").toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sequence: 1, previousDate: "2026-03-01", promisedDate: "2026-03-01", source: "supplier_confirm",
    });
  });

  it("确认 03-01 → 重发 token → 改到 03-30：原始承诺仍是 03-01（修复前是 03-30，且标 trusted）", async () => {
    await confirm("2026-03-01");
    await confirm("2026-03-30"); // generateConfirmToken 重置了 used_at，第二次确认是允许的
    const rows = await revisionsOf();
    expect(rows).toHaveLength(2);

    const fact = resolvePromiseBasis(rows.map((r) => ({
      sequence: r.sequence, promisedDate: r.promisedDate, source: r.source,
    })));
    expect(fact.originalPromisedDate, "第一次确认才是供应商的原始承诺").toBe("2026-03-01");
    expect(fact.historyState).toBe("trusted");
    expect(fact.revisionCount, "建立行不算改期；这之后的一次才算").toBe(1);

    // 洗白判据：03-28 到货，按原始承诺 03-01 必须是**未达**
    const arrived = "2026-03-28";
    expect(arrived > fact.originalPromisedDate!).toBe(true);
    // 表头交期已被改成 03-30（当前承诺口径下反而「准时」——这正是要并列展示的那个差额）
    const [doc] = await db.select().from(poDocs).where(eq(poDocs.id, poId));
    expect(doc.expectedDate).toBe("2026-03-30");
  });

  it("同一天再确认一次不重复写建立行（幂等，不制造版本链噪声）", async () => {
    await confirm("2026-03-01");
    await confirm("2026-03-01");
    expect(await revisionsOf()).toHaveLength(1);
  });
});

describe("C5② 可信来源必须是白名单，不是「非 legacy_backfill」黑名单", () => {
  it("buyer_revision 打头的版本链 → missing，绝不冒充供应商的原始承诺", () => {
    expect(TRUSTED_PROMISE_SOURCES).toContain("supplier_confirm");
    expect(TRUSTED_PROMISE_SOURCES).not.toContain("buyer_revision");
    expect(TRUSTED_PROMISE_SOURCES).not.toContain("external_observation");

    // 修复前：黑名单只挡 legacy_backfill，买手自己填的 03-30 会被判 trusted 的「原始承诺」
    expect(resolvePromiseBasis([
      { sequence: 1, promisedDate: "2026-03-30", source: "buyer_revision" },
    ])).toEqual({ originalPromisedDate: null, historyState: "missing", revisionCount: 0 });
  });

  it("买手改期夹在供应商确认之间时，原始承诺仍取供应商那一条，改期计数只数供应商的", () => {
    const fact = resolvePromiseBasis([
      { sequence: 1, promisedDate: "2026-03-01", source: "supplier_confirm" },
      { sequence: 2, promisedDate: "2026-03-15", source: "buyer_revision" },
      { sequence: 3, promisedDate: "2026-03-30", source: "supplier_confirm" },
    ]);
    expect(fact).toEqual({ originalPromisedDate: "2026-03-01", historyState: "trusted", revisionCount: 1 });
  });
});
