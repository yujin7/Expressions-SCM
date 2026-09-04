/**
 * 分域覆盖必须有前端入口（2026-09-04 审计 #3）。
 *
 * 事故形态：`core/scoped-params.ts` + `/api/admin/params/scoped` 整套作用域继承实现完备、
 * 单测齐全，但**零前端调用**——`/admin/params` 只 `where scope='global'`，
 * 已经存在的 sku/brand/segment 覆盖在页面上完全不可见。业务在页面上看到 45 天，
 * 引擎对某个品牌用 30 天，两个数互相解释不了，最终没人相信这一页。
 *
 * 本门禁只钉两件事：页面确实调那条路由（读 + 写 + 清除），以及全局层保护没有被前端绕开。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PARAM_DEFS, paramDef } from "@/server/core/param-defs";
import { listParams, scopeKindsFor } from "@/server/modules/admin/params";
import { setScopedParam } from "@/server/core/scoped-params";
import type { SessionUser } from "@/server/modules/master/common";
import { createTestDb } from "../helpers/db";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const paramsClient = read("src/app/(app)/admin/params/params-client.tsx");
const scopedCard = read("src/app/(app)/admin/params/scoped-overrides-card.tsx");

const admin: SessionUser = { id: 1, name: "管理员", roles: ["admin"], isApprover: true };
const pmc: SessionUser = { id: 2, name: "计划员", roles: ["pmc"], isApprover: false };

describe("#3 /admin/params 的分域覆盖入口", () => {
  it("运行参数页挂载了分域覆盖卡片", () => {
    expect(paramsClient).toContain("ScopedOverridesCard");
  });

  it("卡片读、写、清除三个动作都打到 /api/admin/params/scoped", () => {
    expect(scopedCard).toContain("/api/admin/params/scoped?key=");
    expect(scopedCard).toMatch(/method:\s*"POST"[\s\S]{0,200}params\/scoped|params\/scoped[\s\S]{0,200}method:\s*"POST"/);
    expect(scopedCard).toMatch(/method:\s*"DELETE"/);
  });

  it("前端不提供 global 层（全局值仍走 admin-only 的 /api/admin/params）", () => {
    // scopeKinds 由服务端下发且从不含 global；卡片也不得自造一个 global 选项
    expect(scopedCard).not.toMatch(/value:\s*"global"/);
    for (const def of PARAM_DEFS) {
      expect(scopeKindsFor(def)).not.toContain("global");
    }
  });

  it("服务端下发每个参数可维护的层：品类参数只有 category，枚举开关不分域", () => {
    expect(scopeKindsFor(paramDef("loss_rate_pct")!)).toEqual(["category"]);
    expect(scopeKindsFor(paramDef("tier_basis")!)).toEqual([]);
    expect(scopeKindsFor(paramDef("cover_target_days")!)).toEqual(["sku", "brand", "segment"]);
  });

  it("listParams 下发 scopeKinds / categoryOptions，前端无需自写第二份判定", async () => {
    const { db } = await createTestDb();
    const rows = await listParams(db);
    expect(rows.find((r) => r.key === "loss_rate_pct")!.categoryOptions.map((o) => o.value)).toEqual([
      "raw",
      "packaging",
    ]);
    for (const row of rows) {
      expect(row.scopeKinds, `${row.key} 缺 scopeKinds`).toBeDefined();
    }
  });

  it("既有覆盖在页面上不再隐形：全局行给出覆盖条数，覆盖清单给出层/目标/值/人/时间", async () => {
    const { db } = await createTestDb();
    await setScopedParam(pmc, { key: "cover_target_days", scope: { kind: "segment", cell: "AX" }, value: 30 }, db);
    await setScopedParam(admin, { key: "cover_target_days", scope: { kind: "brand", brandId: 12 }, value: 20 }, db);
    const global = (await listParams(db)).find((r) => r.key === "cover_target_days")!;
    expect(global.value, "全局值仍是缺省").toBe(45);
    expect(global.overrideCount, "页面必须能看出「这一行不是全部真相」").toBe(2);

    const { listScopedOverrides } = await import("@/server/core/scoped-params");
    const list = await listScopedOverrides("cover_target_days", db);
    expect(list.map((r) => [r.kind, r.target, r.value])).toEqual([
      ["brand", "品牌#12", 20],
      ["segment", "AX", 30],
    ]);
    expect(list.every((r) => r.lastChangedAt != null), "每条覆盖都要能说出谁在何时改的").toBe(true);
  });
});
