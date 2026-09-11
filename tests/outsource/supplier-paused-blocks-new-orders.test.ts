/**
 * 「整改 · 暂停新订单」必须真的挡住新单。
 *
 * 事故背景（2026-09-04 审计）：供应商生命周期页的「整改」把状态置为 `paused`
 * （`master/supplier-lifecycle.ts` 发起整改时 `set({ status: "paused" })`），
 * 页面上写着「暂停新订单」。但 `createWo` / `generateDocs` / `previewAutoChain`
 * 三处判定都只写了 `status === "blacklisted"`——`paused` 形同虚设：
 * 质量部刚把一家加工厂按下暂停，PMC 转头就能给它开新工单，界面上没有任何提示。
 *
 * 现在三处统一读纯规则 `rules/supplier-status.ts`。本测试走真实服务与 PGlite，
 * 证明的是**行为**（下单被拒），不是「代码里出现了某个字符串」。
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approvalConfigs, bomLines, boms, skus, spus, suppliers, users, woDocs,
} from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { approveWo, createWo, generateDocs, submitWo } from "@/server/modules/outsource/wo";
import { createTestDb, type TestDb } from "../helpers/db";

describe("供应商 paused / blacklisted 禁新单", () => {
  let db: TestDb;
  let creator: SessionUser;
  let approver: SessionUser;
  let finished = 0;
  let raw = 0;
  let factory = 0;
  let materialSupplier = 0;

  beforeEach(async () => {
    ({ db } = await createTestDb());
    const [creatorRow, approverRow] = await db.insert(users).values([
      { name: "暂停制单", roles: ["pmc"], isApprover: false },
      { name: "暂停审批", roles: ["pmc"], isApprover: true },
    ]).returning();
    creator = { id: creatorRow.id, name: creatorRow.name, roles: ["pmc"], isApprover: false };
    approver = { id: approverRow.id, name: approverRow.name, roles: ["pmc"], isApprover: true };
    await db.insert(approvalConfigs).values({ docType: "wo", approverRole: "pmc" });

    const [spu] = await db.insert(spus).values({ code: "SPU-PAUSE", nameCn: "暂停测试" }).returning();
    const [fg, rm] = await db.insert(skus).values([
      { code: "FG-PAUSE", name: "成品", spuId: spu.id, skuType: "finished", baseUom: "盒" },
      { code: "RM-PAUSE", name: "原料", spuId: spu.id, skuType: "raw", baseUom: "克" },
    ]).returning();
    finished = fg.id;
    raw = rm.id;
    const [bom] = await db.insert(boms).values({ productSkuId: finished, versionNo: "V1", status: "active" }).returning();
    await db.insert(bomLines).values({ bomId: bom.id, materialSkuId: raw, qtyPer: "2", lossRatePct: "0" });

    const [factoryRow, matRow] = await db.insert(suppliers).values([
      { code: "SUP-PAUSE-FACTORY", name: "整改中的加工厂", kinds: ["processor"], status: "qualified" },
      { code: "SUP-PAUSE-RAW", name: "原料供应商", kinds: ["raw"], status: "qualified" },
    ]).returning();
    factory = factoryRow.id;
    materialSupplier = matRow.id;
  });

  const newWoInput = () => ({ productSkuId: finished, qty: "100", supplierId: factory, feeRatePlan: "1" });

  it("加工厂被置为 paused 后不能再开委外工单（与黑名单同等对待）", async () => {
    // 先证明合格状态下确实开得出来——否则「拒绝」可能来自别的原因
    const ok = await createWo(creator, newWoInput(), db);
    expect(ok.id).toBeGreaterThan(0);

    await db.update(suppliers).set({ status: "paused" }).where(eq(suppliers.id, factory));
    await expect(createWo(creator, newWoInput(), db)).rejects.toThrow(/暂停新订单/);

    await db.update(suppliers).set({ status: "blacklisted" }).where(eq(suppliers.id, factory));
    await expect(createWo(creator, newWoInput(), db)).rejects.toThrow(/黑名单/);

    // 只多了最开始那一张：暂停/黑名单两次都没有落库
    expect(await db.select().from(woDocs)).toHaveLength(1);
  });

  it("生成采购订单时，paused 的物料供应商同样被拒（存量单据仍可收尾）", async () => {
    const wo = await createWo(creator, newWoInput(), db);
    const pending = await submitWo(creator, wo.id, wo.version, db);
    await approveWo(approver, wo.id, { action: "approve", version: pending.version }, db);

    await db.update(suppliers).set({ status: "paused" }).where(eq(suppliers.id, materialSupplier));
    await expect(generateDocs(creator, wo.id, {
      poGroups: [{ supplierId: materialSupplier, lines: [{ materialSkuId: raw, qty: "200", price: "1" }] }],
    }, db)).rejects.toThrow(/暂停新订单/);

    // 恢复合格后同一份入参可以生成，证明拒绝确实由状态引起
    await db.update(suppliers).set({ status: "qualified" }).where(eq(suppliers.id, materialSupplier));
    const generated = await generateDocs(creator, wo.id, {
      poGroups: [{ supplierId: materialSupplier, lines: [{ materialSkuId: raw, qty: "200", price: "1" }] }],
    }, db);
    expect(generated.pos).toHaveLength(1);
  });
});
