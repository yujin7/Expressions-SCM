/** 分域参数体系（E2-02/E8-06）：作用域继承解析器测试 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import { sysParams, auditLogs } from "@/db/schema";
import {
  resolveNumParam,
  makeResolver,
  setScopedParam,
  clearScopedParam,
  listScopedOverrides,
  encodeScope,
  describeScope,
  FALLBACK_SCOPE,
} from "@/server/core/scoped-params";
import type { SessionUser } from "@/server/modules/master/common";

const KEY = "cover_target_days";
const FB = 45;
const admin: SessionUser = { id: 1, name: "管理员", roles: ["admin"], isApprover: true };
const pmc: SessionUser = { id: 2, name: "计划员", roles: ["pmc"], isApprover: false };
const purchaser: SessionUser = { id: 3, name: "采购", roles: ["purchasing"], isApprover: false };

/** ctx：SKU 401 属品牌 12、分层 AX */
const CTX = { skuId: 401, brandId: 12, segment: "AX" };

describe("scoped-params 作用域继承", () => {
  let db: TestDb;

  beforeEach(async () => {
    ({ db } = await createTestDb());
  });

  const put = async (scope: string, value: number) => {
    await db.insert(sysParams).values({ scope, key: KEY, value: String(value) });
  };

  it("无任何行 → 取 fallback，scope=fallback", async () => {
    const r = await resolveNumParam(KEY, FB, CTX, db);
    expect(r.value).toBe(FB);
    expect(r.scope).toBe(FALLBACK_SCOPE);
  });

  it("只有 global → 取 global", async () => {
    await put("global", 50);
    const r = await resolveNumParam(KEY, FB, CTX, db);
    expect(r.value).toBe(50);
    expect(r.scope).toBe("global");
  });

  it("segment 胜 global", async () => {
    await put("global", 50);
    await put("segment:AX", 30);
    const r = await resolveNumParam(KEY, FB, CTX, db);
    expect(r.value).toBe(30);
    expect(r.scope).toBe("segment:AX");
    // 不同分层的 ctx 落回 global
    const other = await resolveNumParam(KEY, FB, { segment: "CZ" }, db);
    expect(other.value).toBe(50);
    expect(other.scope).toBe("global");
  });

  it("brand 胜 segment", async () => {
    await put("global", 50);
    await put("segment:AX", 30);
    await put("brand:12", 20);
    const r = await resolveNumParam(KEY, FB, CTX, db);
    expect(r.value).toBe(20);
    expect(r.scope).toBe("brand:12");
    // 别的品牌仍走 segment
    const other = await resolveNumParam(KEY, FB, { brandId: 99, segment: "AX" }, db);
    expect(other).toEqual({ value: 30, scope: "segment:AX", layer: "segment" });
  });

  it("sku 胜全部", async () => {
    await put("global", 50);
    await put("segment:AX", 30);
    await put("brand:12", 20);
    await put("sku:401", 10);
    const r = await resolveNumParam(KEY, FB, CTX, db);
    expect(r.value).toBe(10);
    expect(r.scope).toBe("sku:401");
  });

  it("缺项自动跳级：只有 segment 行、ctx 无 sku/brand", async () => {
    await put("segment:BY", 33);
    const r = await resolveNumParam(KEY, FB, { segment: "BY" }, db);
    expect(r).toEqual({ value: 33, scope: "segment:BY", layer: "segment" });
    // 空 ctx → fallback（无 global 行）
    expect(await resolveNumParam(KEY, FB, {}, db)).toEqual({ value: FB, scope: FALLBACK_SCOPE, layer: "fallback" });
  });

  it("makeResolver 批量解析与逐个 resolveNumParam 结果一致", async () => {
    await put("global", 50);
    await put("segment:AX", 30);
    await put("brand:12", 20);
    await put("sku:401", 10);
    const ctxs = [
      CTX,
      { skuId: 402, brandId: 12, segment: "AX" },
      { skuId: 403, brandId: 99, segment: "AX" },
      { skuId: 404, brandId: 99, segment: "CZ" },
      {},
    ];
    const resolver = await makeResolver(KEY, FB, db);
    for (const c of ctxs) {
      expect(resolver(c)).toEqual(await resolveNumParam(KEY, FB, c, db));
    }
    expect(ctxs.map((c) => resolver(c).scope)).toEqual([
      "sku:401",
      "brand:12",
      "segment:AX",
      "global",
      "global",
    ]);
  });

  it("setScopedParam 落库 + 审计 + 可被解析读到", async () => {
    await setScopedParam(admin, { key: KEY, scope: { kind: "segment", cell: "AX" }, value: 30 }, db);
    await setScopedParam(pmc, { key: KEY, scope: { kind: "sku", skuId: 401 }, value: 12 }, db);

    const rows = await db.select().from(sysParams).where(eq(sysParams.key, KEY));
    expect(rows.map((r) => r.scope).sort()).toEqual(["segment:AX", "sku:401"]);

    const r = await resolveNumParam(KEY, FB, CTX, db);
    expect(r).toEqual({ value: 12, scope: "sku:401", layer: "sku" });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "sys_param_scoped"));
    expect(audits.length).toBe(2);

    // 覆写同一 scope：更新而非新增行，且审计留旧值
    await setScopedParam(admin, { key: KEY, scope: { kind: "sku", skuId: 401 }, value: 18 }, db);
    const rows2 = await db.select().from(sysParams).where(eq(sysParams.key, KEY));
    expect(rows2.length).toBe(2);
    expect((await resolveNumParam(KEY, FB, CTX, db)).value).toBe(18);
    const last = (await db.select().from(auditLogs).where(eq(auditLogs.entity, "sys_param_scoped"))).at(-1);
    expect((last?.before as { value: string | null }).value).toBe("12");
  });

  it("setScopedParam 越界被拒", async () => {
    // cover_target_days 区间 7–365
    await expect(
      setScopedParam(admin, { key: KEY, scope: { kind: "segment", cell: "AX" }, value: 3 }, db),
    ).rejects.toThrow(/7/);
    await expect(
      setScopedParam(admin, { key: KEY, scope: { kind: "global" }, value: 999 }, db),
    ).rejects.toThrow(/365/);
    expect((await db.select().from(sysParams).where(eq(sysParams.key, KEY))).length).toBe(0);
  });

  it("未登记 key 被拒；无权角色被拒", async () => {
    await expect(
      setScopedParam(admin, { key: "not_registered_key", scope: { kind: "global" }, value: 1 }, db),
    ).rejects.toThrow(/未登记/);
    await expect(
      setScopedParam(purchaser, { key: KEY, scope: { kind: "global" }, value: 30 }, db),
    ).rejects.toThrow(/管理员/);
  });

  it("listScopedOverrides 返回全部覆盖，按优先级排序", async () => {
    await put("global", 50);
    await put("segment:AX", 30);
    await put("brand:12", 20);
    await put("sku:401", 10);
    const list = await listScopedOverrides(KEY, db);
    expect(list.map((r) => r.scope)).toEqual(["sku:401", "brand:12", "segment:AX", "global"]);
    expect(list.map((r) => r.value)).toEqual([10, 20, 30, 50]);
  });

  it("scope 编码与中文解释", () => {
    expect(encodeScope({ kind: "global" })).toBe("global");
    expect(encodeScope({ kind: "segment", cell: "ax" })).toBe("segment:AX");
    expect(encodeScope({ kind: "brand", brandId: 12 })).toBe("brand:12");
    expect(encodeScope({ kind: "sku", skuId: 401 })).toBe("sku:401");
    expect(describeScope("segment:AX")).toBe("AX 分层");
    expect(describeScope(FALLBACK_SCOPE)).toBe("系统缺省");
  });
});

/**
 * 覆盖必须可撤销。一个设得上却撤不掉的覆盖是陷阱：
 * 业务试设一次分层参数后无法回退，只能带着一个自己也解释不清的数字继续跑，
 * 而它正驱动补货建议量。
 */
describe("clearScopedParam：覆盖可撤销并回落上一级", () => {
  it("删除 brand 覆盖后解析回落到 global", async () => {
    const { db } = await createTestDb();
    const admin = { id: 1, name: "管理员", roles: ["admin"], isApprover: true };

    await setScopedParam(admin, { key: "safety_days_fallback", scope: { kind: "global" }, value: 7 }, db);
    await setScopedParam(admin, { key: "safety_days_fallback", scope: { kind: "brand", brandId: 12 }, value: 21 }, db);
    const brandHit = await resolveNumParam("safety_days_fallback", 0, { brandId: 12 }, db);
    expect(brandHit.value).toBe(21);
    // W3：解析结果自带命中层级枚举，消费方（补货行 targetBasis/safetyDaysBasis）不必再各自解析 scope 串
    expect(brandHit.layer).toBe("brand");
    expect((await resolveNumParam("safety_days_fallback", 0, {}, db)).layer).toBe("global");
    expect((await resolveNumParam("no_such_key_for_layer", 3, { skuId: 1 }, db)).layer).toBe("fallback");

    await clearScopedParam(admin, { key: "safety_days_fallback", scope: { kind: "brand", brandId: 12 } }, db);
    const back = await resolveNumParam("safety_days_fallback", 0, { brandId: 12 }, db);
    expect(back.value).toBe(7);
    expect(back.scope).toBe("global"); // 确实回落到上一级，而不是落到 fallback
    expect(back.layer).toBe("global");
  });

  it("global 层拒绝删除（它是兜底底座）；不存在的覆盖报 404", async () => {
    const { db } = await createTestDb();
    const admin = { id: 1, name: "管理员", roles: ["admin"], isApprover: true };
    await expect(
      clearScopedParam(admin, { key: "safety_days_fallback", scope: { kind: "global" } }, db),
    ).rejects.toThrow();
    await expect(
      clearScopedParam(admin, { key: "safety_days_fallback", scope: { kind: "sku", skuId: 999 } }, db),
    ).rejects.toThrow();
  });
});

/**
 * 红队实证的提权口子（2026-07-26）：/api/admin/params/scoped 曾接受 scope:{kind:"global"}，
 * 而 global 行与 admin-only 的 admin/params.updateParam 落在**同一个唯一键 (scope,key)** 上。
 * 实测 pmc01 对 /api/admin/params 得 403、对 scoped 路径同 key 得 201 并真的改掉了
 * 超收容差/比价硬门/让步价率/D33 自动链开关。
 */
describe("setScopedParam：global 层的权限边界", () => {
  const pmc = { id: 2, name: "计划员", roles: ["pmc"], isApprover: true };
  const admin = { id: 1, name: "管理员", roles: ["admin"], isApprover: true };

  it("pmc 不能经分域路径改 global（否则绕过 admin-only 闸）", async () => {
    const { db } = await createTestDb();
    await expect(
      setScopedParam(pmc, { key: "over_receive_tolerance_pct", scope: { kind: "global" }, value: 19 }, db),
    ).rejects.toThrow(/仅管理员/);
  });

  it("pmc 仍可维护 sku/brand/segment 三层（分域参数本来的职责）", async () => {
    const { db } = await createTestDb();
    await setScopedParam(pmc, { key: "safety_days_fallback", scope: { kind: "sku", skuId: 259 }, value: 9 }, db);
    expect((await resolveNumParam("safety_days_fallback", 0, { skuId: 259 }, db)).value).toBe(9);
  });

  it("admin 改 global 时审计 entity 必须是 sys_param（否则运行参数页「最近修改人」张冠李戴）", async () => {
    const { db } = await createTestDb();
    await setScopedParam(admin, { key: "safety_days_fallback", scope: { kind: "global" }, value: 8 }, db);
    const rows = await db.select().from(auditLogs);
    const hit = rows.filter((r: { entity: string }) => r.entity === "sys_param");
    expect(hit.length, "global 行与 admin/params 写同一行，审计 entity 必须一致").toBeGreaterThan(0);
  });

  it("畸形 scope 是 400 不是 500（参数错误不该污染 error_logs）", async () => {
    const { db } = await createTestDb();
    for (const bad of [
      { kind: "brand", brandId: "x" },
      { kind: "sku", skuId: -1 },
      { kind: "segment", cell: "  " },
      { kind: "bogus" },
    ]) {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Red-team input bypasses the scope union to verify runtime rejection
        setScopedParam(admin, { key: "safety_days_fallback", scope: bad as any, value: 9 }, db),
      ).rejects.toMatchObject({ status: 400 });
    }
  });
});
