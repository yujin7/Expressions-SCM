import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, departmentGoals, reportReadModelCache, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  AUTO_METRIC_SOURCES,
  computeAttainment,
  createGoal,
  extractAutoValue,
  getGoalsBlock,
  listGoals,
  readPayloadPath,
  refreshAutoActuals,
  refreshableDeptKeys,
  resolveAutoActual,
  updateGoal,
} from "@/server/modules/goals/service";
import { DATA_QUALITY_CACHE_KEY } from "@/server/modules/report/data-quality";
import { EXTERNAL_VELOCITY_CACHE_KEY } from "@/server/modules/report/external-velocity";
import { INVENTORY_SALES_RATIO_CACHE_KEY } from "@/server/modules/report/inventory-sales-ratio";
import { PURCHASE_ORDER_METRICS_KEY } from "@/server/modules/report/purchase-order-metrics";
import { computeSupplierPaymentTerm, SUPPLIER_PAYMENT_TERM_KEY } from "@/server/modules/report/supplier-payment-term";
import { warehouseInventoryCacheKey } from "@/server/modules/report/warehouse-inventory";
import { createTestDb, type TestDb } from "../helpers/db";

describe("goals/service：部门目标 CRUD / auto 实际值（真实读模型键+路径）/ 达成度 / 权限", () => {
  let db: TestDb;
  let admin: SessionUser;
  let pmc: SessionUser;
  let purchasing: SessionUser;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mk = async (name: string, roles: string[]): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover: false }).returning();
      return { id: u.id, name: u.name, roles, isApprover: false };
    };
    admin = await mk("管理员", ["admin"]);
    pmc = await mk("计划", ["pmc"]);
    purchasing = await mk("采购", ["purchasing"]);
    const termBinding = (await computeSupplierPaymentTerm(db)).sourceBinding;
    // 按真实读模型形状写入最小 payload（键 = 读模型模块导出的常量）
    await db.insert(reportReadModelCache).values([
      {
        key: SUPPLIER_PAYMENT_TERM_KEY,
        sourceBinding: termBinding,
        // SupplierPaymentTermModel：summary.attainmentRate 为 0–1 比例；creditTermSpendSharePct 已是百分比字符串
        payload: { key: SUPPLIER_PAYMENT_TERM_KEY, year: 2026, summary: { attainmentRate: 0.4, creditTermSpendSharePct: "35.20" }, rows: [] },
      },
      {
        key: INVENTORY_SALES_RATIO_CACHE_KEY,
        sourceBinding: "test",
        // InventorySalesRatioReadModel：rows[].{yearMonth, ratioMonthEndPct}，current = 最新月
        payload: {
          key: INVENTORY_SALES_RATIO_CACHE_KEY,
          currentMonth: "2026-09",
          rows: [
            { yearMonth: "2026-08", ratioMonthEndPct: 52.1 },
            { yearMonth: "2026-09", ratioMonthEndPct: 48.6 },
          ],
          current: { yearMonth: "2026-09", ratioMonthEndPct: 48.6 },
        },
      },
    ]);
  });

  it("非法期间不能静默扩大查询或回填范围，登记与审计保持不变", async () => {
    const before = await db.select().from(departmentGoals);
    const audits = await db.select().from(auditLogs);
    for (const period of ["2026-13", "2026-Q5", "", "all"]) {
      await expect(listGoals({ period }, admin, db)).rejects.toMatchObject({ status: 400 });
      await expect(refreshAutoActuals(db, { period, actorId: admin.id })).rejects.toMatchObject({ status: 400 });
    }
    expect(await db.select().from(departmentGoals)).toEqual(before);
    expect(await db.select().from(auditLogs)).toEqual(audits);
  });

  it("期间与部门同时限制回填，手工值保留，相同来源重放无重复审计", async () => {
    const { db: isolated } = await createTestDb();
    const [actor] = await isolated.insert(users).values({ name: "回填范围QA", roles: ["admin"] }).returning();
    const user = { ...admin, id: actor.id };
    await isolated.insert(reportReadModelCache).values({ key: INVENTORY_SALES_RATIO_CACHE_KEY, sourceBinding: "qa", payload: {
      rows: [{ yearMonth: "2026-08", ratioMonthEndPct: 20 }, { yearMonth: "2026-09", ratioMonthEndPct: 30 }],
    } });
    const august = await createGoal({ deptKey: "purchasing", period: "2026-08", metricKey: "inventorySalesRatio", targetValue: "50" }, user, isolated);
    const september = await createGoal({ deptKey: "purchasing", period: "2026-09", metricKey: "inventorySalesRatio", targetValue: "50" }, user, isolated);
    const otherDept = await createGoal({ deptKey: "quality", period: "2026-09", metricKey: "inventorySalesRatio", targetValue: "50" }, user, isolated);
    const manual = await createGoal({ deptKey: "purchasing", period: "2026-09", metricKey: "onTimeRate", targetValue: "90", actualSource: "manual" }, user, isolated);
    await updateGoal(manual.id, { actualValue: "77", evidence: "合成证据" }, user, isolated);
    const before = await isolated.select().from(departmentGoals);
    const auditBefore = await isolated.select().from(auditLogs);
    await isolated.update(reportReadModelCache).set({ payload: { rows: [{ yearMonth: "2026-08", ratioMonthEndPct: 80 }, { yearMonth: "2026-09", ratioMonthEndPct: 90 }] } }).where(eq(reportReadModelCache.key, INVENTORY_SALES_RATIO_CACHE_KEY));
    expect(await refreshAutoActuals(isolated, { period: "2026-09", deptKeys: ["purchasing"], actorId: user.id })).toEqual({ scanned: 1, updated: 1, unavailable: 0 });
    const after = await isolated.select().from(departmentGoals);
    for (const id of [august.id, otherDept.id, manual.id]) expect(after.find(r => r.id === id)).toEqual(before.find(r => r.id === id));
    expect(Number(after.find(r => r.id === september.id)!.actualValue)).toBe(90);
    const auditAfter = await isolated.select().from(auditLogs);
    expect(auditAfter).toHaveLength(auditBefore.length + 1);
    expect(auditAfter.at(-1)).toMatchObject({ entity: "department_goal", entityId: september.id, action: "refresh", userId: user.id });
    expect((await refreshAutoActuals(isolated, { period: "2026-09", deptKeys: ["purchasing"], actorId: user.id })).updated).toBe(0);
    expect(await isolated.select().from(auditLogs)).toEqual(auditAfter);
  });

  it("AUTO_METRIC_SOURCES 只引用真实存在的读模型缓存键（不再前缀猜测）", () => {
    // 仓库库存读模型实际落库的键带窗口后缀（/w90）：goals 必须读同一把键（审阅修复：原来读裸前缀永远取不到）
    const real = new Set([INVENTORY_SALES_RATIO_CACHE_KEY, warehouseInventoryCacheKey(90), SUPPLIER_PAYMENT_TERM_KEY, PURCHASE_ORDER_METRICS_KEY, DATA_QUALITY_CACHE_KEY, EXTERNAL_VELOCITY_CACHE_KEY]);
    for (const s of AUTO_METRIC_SOURCES) expect(real.has(s.cacheKey), `${s.metricKey} → ${s.cacheKey}`).toBe(true);
    expect(AUTO_METRIC_SOURCES.map((s) => s.metricKey)).toEqual([
      "inventorySalesRatio", "turns", "dio", "paymentTermAttainment", "creditTermSpendShare", "onTimeRate",
      "salesConsistencyPct", "platformIdentityCoverage", "costSavingYtd",
    ]);
  });

  it("旧表单保存冲突不能覆盖新目标，也不能追加虚假审计", async () => {
    const created = await createGoal({ deptKey: "purchasing", period: "2027-01", metricKey: "onTimeRate", targetValue: "90", note: "原备注" }, admin, db);
    const first = await updateGoal(created.id, { targetValue: "95", expectedUpdatedAt: created.updatedAt }, admin, db);
    const auditBefore = await db.select().from(auditLogs);
    await expect(updateGoal(created.id, { targetValue: "88", note: "旧表单", expectedUpdatedAt: created.updatedAt }, admin, db)).rejects.toMatchObject({ status: 409 });
    expect((await listGoals({ period: "2027-01" }, admin, db)).rows.find(r => r.id === created.id)?.targetValue).toBe(first.targetValue);
    expect(await db.select().from(auditLogs)).toEqual(auditBefore);
  });

  it("同毫秒修改也推进版本；明确清空备注，后续填报保留最新证据与准确before", async () => {
    const now = new Date("2026-09-10T13:00:00.000Z");
    const created = await createGoal({ deptKey: "quality", period: "2027-02", metricKey: "onTimeRate", targetValue: "90", note: "待清空" }, admin, db, { now });
    const cleared = await updateGoal(created.id, { note: null, expectedUpdatedAt: created.updatedAt }, admin, db, { now });
    expect(cleared.note).toBeNull(); expect(cleared.updatedAt).not.toBe(created.updatedAt);
    const first = await updateGoal(created.id, { actualValue: "80", evidence: "证据一", expectedUpdatedAt: cleared.updatedAt }, admin, db, { now });
    const second = await updateGoal(created.id, { actualValue: "85", evidence: "证据二", expectedUpdatedAt: first.updatedAt }, admin, db, { now });
    expect(second.note).toContain("证据一"); expect(second.note).toContain("证据二");
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(new Date(first.updatedAt).getTime());
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "department_goal"), eq(auditLogs.entityId, created.id)));
    expect(logs.at(-1)?.before).toMatchObject({ actualValue: "80.0000", note: first.note });
  });

  it("达成度：up = 实际/目标，down = 目标/实际，decimal 一位小数；分母 0 → null", () => {
    expect(computeAttainment("100", "40", "up")).toBe("40.0");
    expect(computeAttainment("47", "48.6", "down")).toBe("96.7");
    expect(computeAttainment("47", "0", "down")).toBeNull();
    expect(computeAttainment("47", null, "down")).toBeNull();
  });

  it("readPayloadPath：嵌套路径 summary.otif.rate / rows[yearMonth=$period].x；取不到或非数值 → null", () => {
    expect(readPayloadPath({ summary: { otif: { rate: 0.912 } } }, "summary.otif.rate", "2026-Q4")).toBe("0.912");
    expect(readPayloadPath({ summary: { turns: 6.2 } }, "summary.turns", "2026-09")).toBe("6.2");
    const ratio = { rows: [{ yearMonth: "2026-08", ratioMonthEndPct: 52.1 }, { yearMonth: "2026-09", ratioMonthEndPct: null }] };
    expect(readPayloadPath(ratio, "rows[yearMonth=$period].ratioMonthEndPct", "2026-08")).toBe("52.1");
    expect(readPayloadPath(ratio, "rows[yearMonth=$period].ratioMonthEndPct", "2026-09")).toBeNull(); // 值为 null 不编造
    expect(readPayloadPath(ratio, "rows[yearMonth=$period].ratioMonthEndPct", "2026-07")).toBeNull(); // 无该月行
    expect(readPayloadPath({ summary: "x" }, "summary.turns", "2026-09")).toBeNull();
    expect(readPayloadPath("nope", "summary.turns", "2026-09")).toBeNull();
  });

  it("extractAutoValue：when 月/季分流、periodYearField 防串年、scale=100 折百分比；不命中 → null", () => {
    const src = AUTO_METRIC_SOURCES.find((s) => s.metricKey === "inventorySalesRatio")!;
    const ratio = { rows: [{ yearMonth: "2026-08", ratioMonthEndPct: 52.1 }], current: { yearMonth: "2026-08", ratioMonthEndPct: 52.1 } };
    expect(extractAutoValue(ratio, "2026-08", src.paths)).toEqual({ value: "52.1", path: "rows[yearMonth=$period].ratioMonthEndPct" });
    expect(extractAutoValue(ratio, "2026-09", src.paths)).toBeNull(); // 月份不在 rows 里不回退到 current
    // 季度 = 季内最新有值月份（审阅修复：不再读 current，避免把最新月填给任意季度）
    expect(extractAutoValue(ratio, "2026-Q3", src.paths)).toEqual({ value: "52.1", path: "rows[yearMonth=2026-08].ratioMonthEndPct" });
    expect(extractAutoValue(ratio, "2025-Q4", src.paths)).toBeNull();
    const twoMonths = { rows: [{ yearMonth: "2026-07", ratioMonthEndPct: 60 }, { yearMonth: "2026-08", ratioMonthEndPct: 52.1 }], current: { yearMonth: "2026-09", ratioMonthEndPct: 1 } };
    expect(extractAutoValue(twoMonths, "2026-Q3", src.paths)).toEqual({ value: "52.1", path: "rows[yearMonth=2026-08].ratioMonthEndPct" });
    const pay = AUTO_METRIC_SOURCES.find((s) => s.metricKey === "paymentTermAttainment")!;
    expect(extractAutoValue({ year: 2026, summary: { attainmentRate: 0.4 } }, "2026-Q3", pay.paths)).toEqual({ value: "40.0000", path: "summary.attainmentRate" });
    expect(extractAutoValue({ year: 2025, summary: { attainmentRate: 0.4 } }, "2026-Q3", pay.paths)).toBeNull();
    expect(extractAutoValue({ year: 2026, summary: { attainmentRate: null } }, "2026-Q3", pay.paths)).toBeNull();
  });

  it("createGoal：auto 指标从读模型取值（取到 → actual=auto；取不到 → null，不编造）；写审计（含 sourceKey/path）", async () => {
    const g = await createGoal({ deptKey: "purchasing", period: "2026-Q3", metricKey: "paymentTermAttainment", targetValue: "100" }, purchasing, db);
    expect(g).toMatchObject({ direction: "up", actualValue: "40.0000", actualSource: "auto", attainment: "40.0", attained: false, autoStatus: "ok", editable: true });
    const none = await createGoal({ deptKey: "purchasing", period: "2026-Q4", metricKey: "onTimeRate", targetValue: "95" }, admin, db);
    expect(none).toMatchObject({ actualValue: null, actualSource: null, autoStatus: "unavailable", attainment: null });
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "department_goal"), eq(auditLogs.entityId, g.id)));
    expect(audits.map((a) => a.action)).toEqual(["create"]);
    expect(audits[0].after).toMatchObject({ autoValue: "40.0000", autoSourceKey: SUPPLIER_PAYMENT_TERM_KEY, autoPath: "summary.attainmentRate" });
  });

  it("权限：非本部门 403；未登记指标 400；同键重复 → 唯一约束冲突；库存占比按月份行取值", async () => {
    await expect(createGoal({ deptKey: "pmc", period: "2026-09", metricKey: "inventorySalesRatio", targetValue: "47" }, purchasing, db)).rejects.toMatchObject({ status: 403 });
    await expect(createGoal({ deptKey: "pmc", period: "2026-09", metricKey: "notAMetric", targetValue: "1" }, pmc, db)).rejects.toMatchObject({ status: 400 });
    const ok = await createGoal({ deptKey: "pmc", period: "2026-09", metricKey: "inventorySalesRatio", targetValue: "47" }, pmc, db);
    expect(ok).toMatchObject({ direction: "down", actualValue: "48.6000", attained: false, attainment: "96.7" });
    await expect(createGoal({ deptKey: "pmc", period: "2026-09", metricKey: "inventorySalesRatio", targetValue: "45" }, pmc, db)).rejects.toThrow();
  });

  it("updateGoal：手工实际值必附证据（否则 400）；证据落 note 与审计；manual 行不被 auto 回填覆盖", async () => {
    const g = await createGoal({ deptKey: "pmc", period: "2026-Q3", metricKey: "qcPassRate", targetValue: "98", direction: "up" }, pmc, db);
    expect(g.actualSource).toBeNull();
    await expect(updateGoal(g.id, { actualValue: "97.5" }, pmc, db)).rejects.toThrow();
    const u = await updateGoal(g.id, { actualValue: "97.5", evidence: "质检月报 2026-09" }, pmc, db);
    expect(u).toMatchObject({ actualValue: "97.5000", actualSource: "manual", attained: false, attainment: "99.5" });
    expect(u.note).toContain("质检月报 2026-09");
    await expect(updateGoal(g.id, { targetValue: "90" }, purchasing, db)).rejects.toMatchObject({ status: 403 });
    // 把 auto 指标的行改成 manual，再 refresh 不覆盖
    const list = await listGoals({ period: "2026-Q3" }, admin, db);
    const pay = list.rows.find((r) => r.metricKey === "paymentTermAttainment")!;
    await updateGoal(pay.id, { actualValue: "55", evidence: "财务口径修正" }, admin, db);
    const s = await refreshAutoActuals(db, { actorId: admin.id });
    expect(s.scanned).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(departmentGoals).where(eq(departmentGoals.id, pay.id));
    expect(row.actualValue).toBe("55.0000");
    expect(row.actualSource).toBe("manual");
  });

  it("refreshAutoActuals：写入真实键的最小 payload 后回填（OTIF 0–1 比例折百分比 / 周转 / DIO / 账期占比）并写审计 refresh", async () => {
    // 先建目标（此时无缓存 → unavailable），再写缓存，refresh 回填
    await createGoal({ deptKey: "warehouse", period: "2026-Q4", metricKey: "turns", targetValue: "8" }, admin, db);
    await createGoal({ deptKey: "warehouse", period: "2026-Q4", metricKey: "dio", targetValue: "45" }, admin, db);
    await createGoal({ deptKey: "purchasing", period: "2026-Q4", metricKey: "creditTermSpendShare", targetValue: "50" }, admin, db);
    const before = await refreshAutoActuals(db, { period: "2026-Q4", actorId: admin.id });
    // creditTermSpendShare 建目标时已从账期读模型取到（值未变不重写）；onTimeRate / turns / dio 缓存尚不存在 → unavailable
    expect(before).toMatchObject({ scanned: 4, updated: 0, unavailable: 3 });
    await db.insert(reportReadModelCache).values([
      { key: PURCHASE_ORDER_METRICS_KEY, sourceBinding: "t", payload: { key: PURCHASE_ORDER_METRICS_KEY, year: 2026, month: "2026-09", summary: { otif: { evaluable: 125, hit: 114, rate: 0.912 } }, byMonth: [] } },
      { key: warehouseInventoryCacheKey(90), sourceBinding: "t", payload: { key: warehouseInventoryCacheKey(90), asOf: "2026-09-03", windowDays: 90, rows: [], regions: [], summary: { turns: 6.2, dio: 58.9 } } },
    ]);
    const s = await refreshAutoActuals(db, { period: "2026-Q4", actorId: admin.id });
    expect(s).toMatchObject({ scanned: 4, updated: 3, unavailable: 0 });
    const list = await listGoals({ period: "2026-Q4" }, admin, db);
    const byKey = Object.fromEntries(list.rows.map((r) => [r.metricKey, r]));
    expect(byKey.onTimeRate).toMatchObject({ actualValue: "91.2000", actualSource: "auto", attained: false, autoStatus: "ok" });
    expect(byKey.turns).toMatchObject({ actualValue: "6.2000", actualSource: "auto", attained: false });
    expect(byKey.dio).toMatchObject({ actualValue: "58.9000", actualSource: "auto", direction: "down", attained: false });
    expect(byKey.creditTermSpendShare).toMatchObject({ actualValue: "35.2000", actualSource: "auto", attained: false });
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entity, "department_goal"), eq(auditLogs.entityId, byKey.onTimeRate.id)));
    expect(audits.map((a) => a.action)).toEqual(["create", "refresh"]);
    expect(audits[1].after).toMatchObject({ actualValue: "91.2000", sourceKey: PURCHASE_ORDER_METRICS_KEY, path: "summary.otif.rate" });
    // 值未变 → 不再写
    const again = await refreshAutoActuals(db, { period: "2026-Q4", actorId: admin.id });
    expect(again).toMatchObject({ scanned: 4, updated: 0, unavailable: 0 });
    // 串年：读模型年份 ≠ 期间年份 → unavailable，不编造
    expect((await resolveAutoActual(db, "onTimeRate", "2025-Q4"))).toMatchObject({ value: null, sourceKey: PURCHASE_ORDER_METRICS_KEY, path: null });
    expect(await resolveAutoActual(db, "qcPassRate", "2026-Q4")).toEqual({ value: null, sourceKey: null, path: null, builtAt: null });
  });

  it("审阅修复：显式 manual 建目标落库为 manual 且不被 refresh 覆盖；refresh 可按部门限定；受限用户写路径也按范围 403", async () => {
    const g = await createGoal({ deptKey: "warehouse", period: "2026-Q2", metricKey: "turns", targetValue: "9", actualSource: "manual" }, admin, db);
    expect(g.actualSource).toBe("manual");
    expect(g.autoStatus).toBe("n/a");
    const s = await refreshAutoActuals(db, { period: "2026-Q2", actorId: admin.id });
    expect(s).toMatchObject({ scanned: 0, updated: 0 });
    const [row] = await db.select().from(departmentGoals).where(eq(departmentGoals.id, g.id));
    expect(row.actualSource).toBe("manual");
    // deptKeys=[] → 不扫描任何行；deptKeys=["warehouse"] 只扫仓库
    expect(await refreshAutoActuals(db, { period: "2026-Q4", actorId: admin.id, deptKeys: [] })).toEqual({ scanned: 0, updated: 0, unavailable: 0 });
    const onlyWh = await refreshAutoActuals(db, { period: "2026-Q4", actorId: admin.id, deptKeys: ["warehouse"] });
    expect(onlyWh.scanned).toBe(2);
    expect(refreshableDeptKeys(admin)).toBeUndefined();
    expect(refreshableDeptKeys(pmc)).toEqual(["pmc"]);
    const restricted: SessionUser = { ...pmc, roles: ["pmc", "ops"], deptScope: ["ops"] } as SessionUser;
    expect(refreshableDeptKeys(restricted)).toEqual(["ops"]);
    await expect(createGoal({ deptKey: "pmc", period: "2026-Q2", metricKey: "qcPassRate", targetValue: "98" }, restricted, db)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(departmentGoals).where(and(eq(departmentGoals.deptKey, "pmc"), eq(departmentGoals.period, "2026-Q2")))).toHaveLength(0);
  });

  it("listGoals：全员可见全部部门，editableDepts 只含本部门；D62 受限用户只见范围内部门", async () => {
    const view = await listGoals({}, purchasing, db);
    expect(view.deptKeys).toHaveLength(7);
    expect(view.editableDepts).toEqual(["purchasing"]);
    expect(view.rows.some((r) => r.deptKey === "pmc" && r.editable === false)).toBe(true);
    const restricted: SessionUser = { ...purchasing, deptScope: ["purchasing"] };
    const scoped = await listGoals({}, restricted, db);
    expect(scoped.deptKeys).toEqual(["purchasing"]);
    expect(scoped.rows.every((r) => r.deptKey === "purchasing")).toBe(true);
    await expect(listGoals({ deptKey: "pmc" }, restricted, db)).rejects.toMatchObject({ status: 403 });
  });

  it("第 4 屏数据块：本月 + 本季；byDept 汇总与 metricIds", async () => {
    const b = await getGoalsBlock(admin, db, { now: new Date("2026-09-10T02:00:00Z") });
    expect(b.periods).toEqual({ month: "2026-09", quarter: "2026-Q3" });
    expect(b.metricIds).toEqual(["goalAttainment"]);
    const pmcRow = b.byDept.find((d) => d.deptKey === "pmc")!;
    expect(pmcRow).toMatchObject({ total: 2, withActual: 2, attained: 0, attainmentRate: "0.0", editable: true });
    const purch = b.byDept.find((d) => d.deptKey === "purchasing")!;
    expect(purch).toMatchObject({ total: 1, withActual: 1, attained: 0 });
    expect(b.href).toBe("/goals");
  });
});
