/**
 * 短关对「未结供给」的影响（跨实体口径，红队补测）。
 *
 * 这条比"能把状态改掉"重要得多：`getOpenSupplyLines` 只把
 * status ∈ (approved, in_progress) 的 PO 计为在途供给。
 *
 * 短关缺失时的真实后果不只是"单据难看"——供应商少送尾数的 PO 会**永远停在
 * in_progress**，于是那部分永远不会到货的数量被一直当成在途供给计入，
 * 补货算式据此认为"货在路上"，从而**压制本该发出的补货建议**。
 * 也就是说：缺短关 = 会少订货。这条测试钉住短关确实把它从在途里摘掉。
 */
import { describe, expect, it } from "vitest";
import { poDocs, poLines, skus, spus, suppliers, users } from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { getOpenSupplyLines } from "@/server/core/supply";
import { transitionPO } from "@/server/modules/outsource/po";

async function setup() {
  const { db } = await createTestDb();
  const [ops] = await db.insert(users).values({
    username: "sc_ops", name: "运营", roles: ["ops"], isApprover: true,
  }).returning();
  const actor = { id: ops.id, name: ops.name, roles: ["ops"], isApprover: true };
  const [spu] = await db.insert(spus).values({ code: "P88001", nameCn: "短关测试品" }).returning();
  const [sku] = await db.insert(skus).values({
    code: "SC-001", name: "短关测试 SKU", spuId: spu.id, skuType: "finished", baseUom: "盒",
  }).returning();
  const [sup] = await db.insert(suppliers).values({ code: "S880", name: "供应商庚" }).returning();

  // 订 100，只收到 70：剩下 30 供应商不再补——这正是会永久卡住的那种单
  const [po] = await db.insert(poDocs).values({
    docNo: "PO-SC-1", status: "in_progress", supplierId: sup.id,
    expectedDate: "2026-08-01", createdBy: actor.id, version: 1,
  }).returning();
  await db.insert(poLines).values({
    poId: po.id, skuId: sku.id, lineType: "raw", purchaseUom: "盒",
    qty: "100.0000", price: "10.00", receivedQty: "70.0000", uomFactor: "1.0000",
  });
  return { db, actor, po, skuId: sku.id };
}

describe("短关与在途供给", () => {
  it("短关前：未收的 30 仍被算作在途供给", async () => {
    const { db, skuId } = await setup();
    const lines = await getOpenSupplyLines(db, [skuId]);
    const total = lines.reduce((a, l) => a + Number(l.qty ?? 0), 0);
    expect(total).toBe(30);
  });

  it("短关后：那 30 从在途里摘掉——否则补货会以为货在路上而少订", async () => {
    const { db, actor, po, skuId } = await setup();
    await transitionPO(
      actor, po.id,
      { action: "short_close", reason: "供应商少送 30 盒，不再补", version: 1 },
      db,
    );
    const lines = await getOpenSupplyLines(db, [skuId]);
    const total = lines.reduce((a, l) => a + Number(l.qty ?? 0), 0);
    expect(total).toBe(0);
  });

  it("重开后在途恢复——管理员纠偏不能把供给弄丢", async () => {
    const { db, actor, po, skuId } = await setup();
    const admin = { ...actor, roles: ["admin"] };
    await transitionPO(
      actor, po.id, { action: "short_close", reason: "先关掉", version: 1 }, db,
    );
    await transitionPO(admin, po.id, { action: "reopen", version: 2 }, db);
    const lines = await getOpenSupplyLines(db, [skuId]);
    const total = lines.reduce((a, l) => a + Number(l.qty ?? 0), 0);
    expect(total).toBe(30);
  });
});
