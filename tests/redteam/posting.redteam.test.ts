/**
 * RED TEAM — 过账引擎并发/幂等/冲销攻击。
 * 约定：断言【正确】行为；用例失败 = 漏洞证实。
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { skus, spus, stockBalances, stockLedger, warehouses } from "@/db/schema";
import { dCmp } from "@/server/core/decimal";
import { getBalance, post, reverse, type PostingEvent } from "@/server/posting/post";
import { createTestDb, type TestDb } from "../helpers/db";

describe("redteam/posting", () => {
  let db: TestDb;
  let wh1: number;
  let wh2: number;
  let whOut: number; // 委外仓（可负）
  let skuA: number;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const [spu] = await db.insert(spus).values({ code: "P80001", nameCn: "过账红队" }).returning();
    const [s] = await db.insert(skus).values({ code: "PT00001", name: "物料A", spuId: spu.id, baseUom: "个", skuType: "raw" }).returning();
    skuA = s.id;
    const [w1] = await db.insert(warehouses).values({ code: "WH-PT-1", name: "PT一仓", kind: "raw" }).returning();
    const [w2] = await db.insert(warehouses).values({ code: "WH-PT-2", name: "PT二仓", kind: "raw" }).returning();
    const [w3] = await db.insert(warehouses).values({ code: "WH-PT-O", name: "PT委外仓", kind: "outsource" }).returning();
    wh1 = w1.id;
    wh2 = w2.id;
    whOut = w3.id;
  });

  let docSeq = 1000;
  const nextDocId = () => ++docSeq;

  it("[BUG?] 并发双过账同一事件：应一 posted:true 一 posted:false，绝不抛 unique violation", async () => {
    const docId = nextDocId();
    const ev: PostingEvent = {
      sourceDocType: "opening", sourceDocId: docId, action: "post",
      lines: [{ sourceLineId: 1, skuId: skuA, warehouseId: wh1, qtyDelta: "5" }],
    };
    const results = await Promise.allSettled([post(db, ev), post(db, ev)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ posted: boolean }>[];
    // 正确行为：两个都优雅返回，其中恰好一个 posted:true
    expect(fulfilled).toHaveLength(2);
    expect(fulfilled.filter((r) => r.value.posted).length).toBe(1);
    // 余额只加一次
    expect(dCmp(await getBalance(db, skuA, wh1), "5")).toBe(0);
    const rows = await db.select().from(stockLedger).where(and(
      eq(stockLedger.sourceDocType, "opening"), eq(stockLedger.sourceDocId, docId),
    ));
    expect(rows).toHaveLength(1);
  });

  it("同单不同 action（js_loss_writeoff: post + writeoff）各自过账，不互相幂等吞掉", async () => {
    const docId = nextDocId();
    const mk = (action: string, qty: string): PostingEvent => ({
      sourceDocType: "js_loss_writeoff", sourceDocId: docId, action,
      lines: [{ sourceLineId: 1, skuId: skuA, warehouseId: whOut, qtyDelta: qty }],
    });
    const r1 = await post(db, mk("post", "-3"));
    const r2 = await post(db, mk("writeoff", "-2"));
    expect(r1.posted).toBe(true);
    expect(r2.posted).toBe(true); // 不同 action = 不同幂等键，正确放行
    expect(dCmp(await getBalance(db, skuA, whOut), "-5")).toBe(0); // 委外仓可负
  });

  it("reverse() 调拨事件：两腿同时取负，余额复原", async () => {
    const docId = nextDocId();
    // 先垫底库存
    await post(db, {
      sourceDocType: "opening", sourceDocId: nextDocId(), action: "post",
      lines: [{ sourceLineId: 1, skuId: skuA, warehouseId: wh1, qtyDelta: "10" }],
    });
    const before1 = await getBalance(db, skuA, wh1);
    const transferEv: PostingEvent = {
      sourceDocType: "transfer", sourceDocId: docId, action: "post",
      lines: [
        { sourceLineId: 11, skuId: skuA, warehouseId: wh1, qtyDelta: "-4" },
        { sourceLineId: -11, skuId: skuA, warehouseId: wh2, qtyDelta: "4" },
      ],
    };
    await post(db, transferEv);
    const revId = nextDocId();
    const r = await reverse(db, transferEv, revId);
    expect(r.posted).toBe(true);
    expect(dCmp(await getBalance(db, skuA, wh1), before1)).toBe(0);
    expect(dCmp(await getBalance(db, skuA, wh2), "0")).toBe(0);
    // 冲销流水两条、方向与原单相反
    const revRows = await db.select().from(stockLedger).where(and(
      eq(stockLedger.sourceDocType, "stock_doc"), eq(stockLedger.sourceDocId, revId),
    ));
    expect(revRows).toHaveLength(2);
    const deltas = revRows.map((x) => x.qtyDelta).sort();
    expect(dCmp(deltas[0], "-4")).toBe(0);
    expect(dCmp(deltas[1], "4")).toBe(0);
  });

  it("[FINDING-MINOR 特征化] [已修] 引擎层双冲防线：同一原始事件第二次 reverse（不同红字单 id）→ {posted:false}，余额只回补一次", async () => {
    // 幂等键 = (sourceDocType=stock_doc, sourceDocId=红字单id, action=reverse)；
    // 不同红字单 id → 两次都过账。引擎不知两张红字针对同一原单。
    // 唯一防线在 stock-doc 模块（reverseStockDoc 查非 void 红字→409）。
    // 本用例记录引擎裸调用的真实（危险）行为：第二次仍 posted:true，余额被多减 7。
    const origId = nextDocId();
    const ev: PostingEvent = {
      sourceDocType: "opening", sourceDocId: origId, action: "post",
      lines: [{ sourceLineId: 1, skuId: skuA, warehouseId: whOut, qtyDelta: "7" }],
    };
    await post(db, ev);
    const balAfterPost = await getBalance(db, skuA, whOut);
    await reverse(db, ev, nextDocId());
    const r2 = await reverse(db, ev, nextDocId()); // 第二次冲销，另一个红字单 id
    expect(r2.posted).toBe(false); // 防线生效：action 编码原单身份，先查已冲即拒
    // 余额只回补一次 = 入库后 − 7
    const { dSub } = await import("@/server/core/decimal");
    expect(dCmp(await getBalance(db, skuA, whOut), dSub(balAfterPost, "7"))).toBe(0);
  });

  it("reverse 的 reverse（套娃）在引擎层同样放行——特征化", async () => {
    const origId = nextDocId();
    const ev: PostingEvent = {
      sourceDocType: "opening", sourceDocId: origId, action: "post",
      lines: [{ sourceLineId: 1, skuId: skuA, warehouseId: whOut, qtyDelta: "2" }],
    };
    await post(db, ev);
    const rev1Id = nextDocId();
    await reverse(db, ev, rev1Id);
    // 把红字事件再冲销一次（模块层禁止，引擎层放行）
    const revEv: PostingEvent = {
      sourceDocType: "stock_doc", sourceDocId: rev1Id, action: "reverse",
      lines: [{ sourceLineId: 1, skuId: skuA, warehouseId: whOut, qtyDelta: "-2" }],
    };
    const r = await reverse(db, revEv, nextDocId());
    // 特征化当前行为：引擎允许（true）；防线只在 stock-doc 模块（"红字单不可再冲销"）
    expect(r.posted).toBe(true);
  });

  it("负库存原子性：多行事件中最后一行超扣 → 全事件回滚（前面行也不留痕）", async () => {
    const docId = nextDocId();
    await post(db, {
      sourceDocType: "opening", sourceDocId: nextDocId(), action: "post",
      lines: [{ sourceLineId: 1, skuId: skuA, warehouseId: wh2, qtyDelta: "1" }],
    });
    const before1 = await getBalance(db, skuA, wh1);
    await expect(post(db, {
      sourceDocType: "issue_out", sourceDocId: docId, action: "post",
      lines: [
        { sourceLineId: 1, skuId: skuA, warehouseId: wh1, qtyDelta: "-1" }, // 足够
        { sourceLineId: 2, skuId: skuA, warehouseId: wh2, qtyDelta: "-999" }, // 超扣
      ],
    })).rejects.toMatchObject({ name: "PostingError", code: "NEGATIVE_STOCK" });
    expect(dCmp(await getBalance(db, skuA, wh1), before1)).toBe(0); // 第一行也回滚
    const rows = await db.select().from(stockLedger).where(and(
      eq(stockLedger.sourceDocType, "issue_out"), eq(stockLedger.sourceDocId, docId),
    ));
    expect(rows).toHaveLength(0);
  });

  it("qtyDelta 精度炸弹：超 4 位小数被半进位规格化而非报错——特征化", async () => {
    const docId = nextDocId();
    await post(db, {
      sourceDocType: "opening", sourceDocId: docId, action: "post",
      lines: [{ sourceLineId: 1, skuId: skuA, warehouseId: wh1, qtyDelta: "0.00005" }],
    });
    const rows = await db.select().from(stockLedger).where(and(
      eq(stockLedger.sourceDocType, "opening"), eq(stockLedger.sourceDocId, docId),
    ));
    expect(dCmp(rows[0].qtyDelta, "0.0001")).toBe(0); // dQty 半进位到 4 位
  });
});
