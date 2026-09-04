/**
 * 三个"引擎在读、页面上没有"的运行参数（2026-09-04 审计 #4）。
 *
 * 事故形态：
 *  - `tier_basis`（qty|value）被 `report/segmentation.ts` 与 `report/replenish-pilot.ts` 读取，
 *    决定分层页把哪一列标为「主口径」，却不在白名单里——只能改 SQL；
 *  - `alert_learned_lead_tolerance_days` 被库存预警与交期学习读取，还被写进给业务看的口径说明，
 *    业务照着说明找参数却找不到；
 *  - `loss_rate_pct`（scope=category）被结算 R2 直接读来扣超耗——**影响金额**，
 *    今天只能靠 SQL 改，且改动无审计。
 *
 * 这里钉住：三个键都已登记、类型/边界正确、写路径可用且权限正确。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, sysParams } from "@/db/schema";
import { PARAM_DEFS, paramDef, textParamFallback } from "@/server/core/param-defs";
import { clearParamCache, getTextParam } from "@/server/core/params";
import { clearScopedParam, listScopedOverrides, setScopedParam } from "@/server/core/scoped-params";
import { listParams, updateParam } from "@/server/modules/admin/params";
import type { SessionUser } from "@/server/modules/master/common";
import { createTestDb } from "../helpers/db";

const admin: SessionUser = { id: 1, name: "管理员", roles: ["admin"], isApprover: true };
const pmc: SessionUser = { id: 2, name: "计划员", roles: ["pmc"], isApprover: false };

describe("#4 参数已登记但无 UI 的三个键", () => {
  it("三个键都在 PARAM_DEFS 里，并带中文标签与说明", () => {
    for (const key of ["tier_basis", "alert_learned_lead_tolerance_days", "loss_rate_pct"]) {
      const def = paramDef(key);
      expect(def, `${key} 未登记`).toBeDefined();
      expect(def!.label.length).toBeGreaterThan(1);
      expect(def!.note.length).toBeGreaterThan(5);
    }
  });

  it("tier_basis 是枚举型（qty|value），缺省 qty，未登记选项被拒", async () => {
    const def = paramDef("tier_basis")!;
    expect(def.kind).toBe("enum");
    if (def.kind !== "enum") throw new Error("unreachable");
    expect(def.options.map((o) => o.value)).toEqual(["qty", "value"]);
    expect(textParamFallback("tier_basis")).toBe("qty");

    const { db } = await createTestDb();
    await updateParam(admin, { key: "tier_basis", value: "value" }, db);
    clearParamCache();
    expect(await getTextParam("tier_basis", undefined, db)).toBe("value");
    await expect(updateParam(admin, { key: "tier_basis", value: "amount" }, db)).rejects.toMatchObject({ status: 400 });
    await expect(updateParam(admin, { key: "tier_basis", value: 1 }, db)).rejects.toMatchObject({ status: 400 });
  });

  it("tier_basis 走 listParams 时按枚举返回字符串值与选项", async () => {
    const { db } = await createTestDb();
    const before = (await listParams(db)).find((r) => r.key === "tier_basis")!;
    expect(before.value).toBe("qty");
    expect(before.isDefault).toBe(true);
    await updateParam(admin, { key: "tier_basis", value: "value" }, db);
    const after = (await listParams(db)).find((r) => r.key === "tier_basis")!;
    expect(after.value).toBe("value");
    expect(after.isDefault).toBe(false);
  });

  it("tier_basis 是全局口径开关，不接受分域覆盖", async () => {
    const { db } = await createTestDb();
    await expect(
      setScopedParam(admin, { key: "tier_basis", scope: { kind: "brand", brandId: 12 }, value: 1 }, db),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("alert_learned_lead_tolerance_days 是数值型、pmc 可改（它是预警口径）", async () => {
    const def = paramDef("alert_learned_lead_tolerance_days")!;
    expect(def.kind).toBe("number");
    const { db } = await createTestDb();
    const row = (await listParams(db)).find((r) => r.key === "alert_learned_lead_tolerance_days")!;
    expect(row.value).toBe(3);
    expect(row.writableBy).toBe("pmc");
    await updateParam(pmc, { key: "alert_learned_lead_tolerance_days", value: 7 }, db);
    expect((await listParams(db)).find((r) => r.key === "alert_learned_lead_tolerance_days")!.value).toBe(7);
  });

  it("loss_rate_pct 只按品类维护：全局层写入被拒，品类层可写并留审计", async () => {
    const { db } = await createTestDb();
    const def = paramDef("loss_rate_pct")!;
    expect(def.scope).toBe("category");

    // 全局层：结算根本不读，写进去只会误导
    await expect(updateParam(admin, { key: "loss_rate_pct", value: 5 }, db)).rejects.toMatchObject({ status: 400 });

    await setScopedParam(admin, { key: "loss_rate_pct", scope: { kind: "category", category: "packaging" }, value: 5 }, db);
    const [row] = await db.select().from(sysParams).where(eq(sysParams.scope, "category:packaging"));
    expect(row.value).toBe("5");

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "sys_param_scoped"));
    expect(audits.length, "分域写必须留审计（结算扣款金额靠它）").toBeGreaterThan(0);

    const list = await listScopedOverrides("loss_rate_pct", db);
    expect(list.map((r) => r.scope)).toEqual(["category:packaging"]);
    expect(list[0].label).toBe("品类 包材");
    // 修改时间取自审计（人名靠 users 左连接，测试库无 users 行时为 null）
    expect(list[0].lastChangedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("loss_rate_pct 影响结算金额：pmc 不得修改，非法品类被拒，可撤销", async () => {
    const { db } = await createTestDb();
    await expect(
      setScopedParam(pmc, { key: "loss_rate_pct", scope: { kind: "category", category: "raw" }, value: 3 }, db),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      setScopedParam(admin, { key: "loss_rate_pct", scope: { kind: "category", category: "finished" }, value: 3 }, db),
    ).rejects.toMatchObject({ status: 400 });
    // 非品类参数不得写到品类层（写了也没有读者）
    await expect(
      setScopedParam(admin, { key: "cover_target_days", scope: { kind: "category", category: "raw" }, value: 30 }, db),
    ).rejects.toMatchObject({ status: 400 });

    await setScopedParam(admin, { key: "loss_rate_pct", scope: { kind: "category", category: "raw" }, value: 3 }, db);
    await clearScopedParam(admin, { key: "loss_rate_pct", scope: { kind: "category", category: "raw" } }, db);
    expect(await listScopedOverrides("loss_rate_pct", db)).toEqual([]);
  });

  it("listParams 在全局行上给出分域覆盖条数（页面据此提示「有 N 处覆盖」）", async () => {
    const { db } = await createTestDb();
    await setScopedParam(admin, { key: "loss_rate_pct", scope: { kind: "category", category: "raw" }, value: 2 }, db);
    await setScopedParam(admin, { key: "loss_rate_pct", scope: { kind: "category", category: "packaging" }, value: 5 }, db);
    await setScopedParam(admin, { key: "cover_target_days", scope: { kind: "brand", brandId: 12 }, value: 30 }, db);
    const rows = await listParams(db);
    expect(rows.find((r) => r.key === "loss_rate_pct")!.overrideCount).toBe(2);
    expect(rows.find((r) => r.key === "cover_target_days")!.overrideCount).toBe(1);
    expect(rows.find((r) => r.key === "slow_days_threshold")!.overrideCount).toBe(0);
  });

  it("白名单里每个 scope=category 的参数都必须能被分域写路径接受", () => {
    for (const def of PARAM_DEFS) {
      if (def.scope !== "category") continue;
      expect(def.kind, `${def.key} 品类参数必须是数值型`).toBe("number");
    }
  });
});
