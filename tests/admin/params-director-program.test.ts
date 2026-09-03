/**
 * 总监需求实施计划参数白名单（D54/D56/D57/D58/D60/D64/D65）：
 * 缺省值钉住决议；边界自洽；listParams 未设值时按缺省返回并标 isDefault。
 */
import { describe, expect, it } from "vitest";
import { PARAM_DEFS, listParams } from "@/server/modules/admin/params";
import { createTestDb } from "../helpers/db";

/** 决议缺省值（program-decisions D50–D66） */
const DIRECTOR_PARAM_DEFAULTS: Record<string, number> = {
  inventory_sales_ratio_target_low: 45,
  inventory_sales_ratio_target_high: 47,
  default_production_lead_days: 30,
  default_logistics_lead_days: 15,
  alert_buffer_days: 5,
  grade_s_pct: 50,
  grade_a_pct: 80,
  grade_b_pct: 95,
  spike_consecutive_days: 3,
  spike_rise_pct: 50,
  spike_min_base_qty: 10,
  transfer_cost_window_days: 180,
  transfer_cost_deviation_pct: 20,
  transfer_qty_deviation_x: 3,
  transfer_batch_max_docs: 4,
  warehouse_max_active: 12,
  payment_term_min_years: 2,
  payment_term_target_min_days: 45,
  payment_term_target_max_days: 60,
  dq_tolerance_pct: 1,
};

describe("PARAM_DEFS：总监计划参数登记", () => {
  it("20 个键全部登记，缺省值与决议一致", () => {
    for (const [key, fallback] of Object.entries(DIRECTOR_PARAM_DEFAULTS)) {
      const def = PARAM_DEFS.find((d) => d.key === key);
      expect(def, `${key} 未登记进 PARAM_DEFS`).toBeDefined();
      expect(def!.fallback, `${key} 缺省值与决议不符`).toBe(fallback);
      expect(def!.label.length, `${key} 缺中文标签`).toBeGreaterThan(0);
      expect(def!.note, `${key} 说明须标 D 号出处`).toMatch(/D\d+/);
    }
  });

  it("键唯一；min ≤ fallback ≤ max", () => {
    const keys = PARAM_DEFS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of PARAM_DEFS) {
      expect(d.min, `${d.key} min > fallback`).toBeLessThanOrEqual(d.fallback);
      expect(d.max, `${d.key} max < fallback`).toBeGreaterThanOrEqual(d.fallback);
    }
  });

  it("成对参数缺省自洽：占比下限<上限、分层 S<A<B、账期下限≤上限", () => {
    const f = (k: string) => PARAM_DEFS.find((d) => d.key === k)!.fallback;
    expect(f("inventory_sales_ratio_target_low")).toBeLessThan(f("inventory_sales_ratio_target_high"));
    expect(f("grade_s_pct")).toBeLessThan(f("grade_a_pct"));
    expect(f("grade_a_pct")).toBeLessThan(f("grade_b_pct"));
    expect(f("payment_term_target_min_days")).toBeLessThanOrEqual(f("payment_term_target_max_days"));
  });

  it("listParams 在未设值的库上按缺省返回并标 isDefault", async () => {
    const { db } = await createTestDb();
    const rows = await listParams(db);
    for (const [key, fallback] of Object.entries(DIRECTOR_PARAM_DEFAULTS)) {
      const row = rows.find((r) => r.key === key);
      expect(row, key).toBeDefined();
      expect(row!.value).toBe(fallback);
      expect(row!.isDefault).toBe(true);
    }
  });
});
