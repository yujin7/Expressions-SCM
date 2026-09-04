/**
 * SKU 主档表单的加工周期（2026-09-04 审计 #12）。
 *
 * 事故形态：`skuSchema` 已经接受 `normalLeadDays`，但 `createSku` / `updateSku` 只写
 * `logisticsLeadDays`——传进来的加工周期被**静默丢弃**。表单上看着填了，库里没有，
 * 补货与预警阈值继续按运行参数缺省跑。而两者本来就是 `sku_params` 的同一行。
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLogs, skuParams, spus, users } from "@/db/schema";
import { createSku, updateSku } from "@/server/modules/master/sku";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb } from "../helpers/db";

async function world() {
  const { db } = await createTestDb();
  const [u] = await db.insert(users).values({ name: "计划", roles: ["pmc"], isApprover: false }).returning();
  const actor: SessionUser = { id: u.id, name: u.name, roles: ["pmc"], isApprover: false };
  const [spu] = await db.insert(spus).values({ code: "P90001", nameCn: "周期表单" }).returning();
  return { db, actor, spu };
}

const base = (spuId: number) => ({
  name: "周期测试品",
  spuId,
  skuType: "finished" as const,
  baseUom: "盒",
  commercialRole: "retail" as const,
});

describe("#12 SKU 主档表单同时维护加工周期与物流周期", () => {
  it("新建：加工周期与物流周期落进同一行 sku_params，审计带两者", async () => {
    const { db, actor, spu } = await world();
    const created = await createSku({ ...base(spu.id), normalLeadDays: 25, logisticsLeadDays: 6 }, actor, db);
    const [params] = await db.select().from(skuParams).where(eq(skuParams.skuId, created.id));
    expect(params, "两个字段必须写同一行——它们本来就是 sku_params 的同一行").toMatchObject({
      normalLeadDays: 25,
      logisticsLeadDays: 6,
    });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "create"));
    expect(audit.after).toMatchObject({ normalLeadDays: 25, logisticsLeadDays: 6 });
  });

  it("只填加工周期也要落库（此前只有 logisticsLeadDays 才触发写入）", async () => {
    const { db, actor, spu } = await world();
    const created = await createSku({ ...base(spu.id), normalLeadDays: 33 }, actor, db);
    const [params] = await db.select().from(skuParams).where(eq(skuParams.skuId, created.id));
    expect(params.normalLeadDays).toBe(33);
    expect(params.logisticsLeadDays).toBeNull();
  });

  it("修改：只改其中一个字段不会把另一个抹掉，审计 before/after 都带加工周期", async () => {
    const { db, actor, spu } = await world();
    const created = await createSku({ ...base(spu.id), normalLeadDays: 25, logisticsLeadDays: 6 }, actor, db);
    await updateSku(created.id, { ...base(spu.id), code: created.code, normalLeadDays: 40 }, actor, db);
    const [params] = await db.select().from(skuParams).where(eq(skuParams.skuId, created.id));
    expect(params).toMatchObject({ normalLeadDays: 40, logisticsLeadDays: 6 });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "update"));
    expect(audit.before).toMatchObject({ normalLeadDays: 25, logisticsLeadDays: 6 });
    expect(audit.after).toMatchObject({ normalLeadDays: 40 });
  });

  it("列表 select 带上加工周期（表单回填要能读到现值，否则一保存就把它清空）", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.resolve(__dirname, "../../src/server/modules/master/sku.ts"), "utf8");
    expect(src).toContain("normalLeadDays: schema.skuParams.normalLeadDays");
  });
});
