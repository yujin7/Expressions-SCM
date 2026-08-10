/**
 * 单据列表可按 SKU 搜索（试点前置）。
 *
 * 0727 会议定了「选 2 款产品从下单环节开始跑全流程」。此前九个单据列表只能按
 * 单号搜，试点产品的单据无法一次圈出来，只能顺着链路视图一单一单点。
 *
 * 这里用真实服务 + PGlite 验证「搜 SKU 编码/名称能命中单据」，
 * 并且反向确认无关单据不会被误命中（否则等于没筛）。
 */
import { describe, expect, it } from "vitest";
import { bhDocs, bhLines, skus, spus, users } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { listBhs } from "@/server/modules/outsource/bh";

async function setup() {
  const { db } = await createTestDb();
  const [user] = await db.insert(users).values({
    username: "doc_search_actor", name: "试点", roles: ["ops"], isApprover: false,
  }).returning();
  const [spu] = await db.insert(spus).values({ code: "P55001", nameCn: "试点产品" }).returning();
  const mk = async (code: string, name: string) => {
    const [row] = await db.insert(skus).values({
      code, name, spuId: spu.id, skuType: "finished", baseUom: "支",
    }).returning();
    return row;
  };
  const pilot = await mk("E120-000", "(EXPRESSIONS)试点精华乳(100ml)");
  const other = await mk("N999-000", "(NING)无关面膜(20ml)");

  const mkDoc = async (docNo: string, skuId: number) => {
    const [doc] = await db.insert(bhDocs).values({
      docNo, status: "draft", createdBy: user.id,
    }).returning();
    await db.insert(bhLines).values({ bhId: doc.id, skuId, qty: "10.0000" });
    return doc;
  };
  const pilotDoc = await mkDoc("BH-20260806-0001", pilot.id);
  const otherDoc = await mkDoc("BH-20260806-0002", other.id);
  return { db, pilotDoc, otherDoc };
}

const page = { page: 1, pageSize: 50 };

describe("单据列表按 SKU 搜索", () => {
  it("按 SKU 编码搜到对应单据，且不误命中其它单据", async () => {
    const { db, pilotDoc } = await setup();
    const res = await listBhs("E120-000", page, db);
    expect(res.total).toBe(1);
    expect((res.rows as { docNo: string }[])[0].docNo).toBe(pilotDoc.docNo);
  });

  it("按货品名称片段也能搜到（业务同事往往记名字不记编码）", async () => {
    const { db, pilotDoc } = await setup();
    const res = await listBhs("试点精华乳", page, db);
    expect(res.total).toBe(1);
    expect((res.rows as { docNo: string }[])[0].docNo).toBe(pilotDoc.docNo);
  });

  it("按单号搜索的原有行为不受影响", async () => {
    const { db, otherDoc } = await setup();
    const res = await listBhs("BH-20260806-0002", page, db);
    expect(res.total).toBe(1);
    expect((res.rows as { docNo: string }[])[0].docNo).toBe(otherDoc.docNo);
  });

  it("搜不存在的 SKU 返回空，不是全表", async () => {
    const { db } = await setup();
    const res = await listBhs("ZZZ-NOPE", page, db);
    expect(res.total).toBe(0);
  });

  it("空搜索仍返回全部（EXISTS 子查询不能把无搜索时也过滤掉）", async () => {
    const { db } = await setup();
    const res = await listBhs("", page, db);
    expect(res.total).toBe(2);
  });

  it("total 与 rows 同口径收敛——不能只裁当页而 total 仍是全表", async () => {
    const { db } = await setup();
    const res = await listBhs("E120-000", page, db);
    expect(res.total).toBe((res.rows as unknown[]).length);
  });
});
