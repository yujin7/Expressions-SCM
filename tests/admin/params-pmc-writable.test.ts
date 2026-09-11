import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auditLogs, users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { canWriteParam, listParams, PARAM_DEFS, PMC_WRITABLE_PARAM_KEYS, updateParam } from "@/server/modules/admin/params";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * D59：补货参数写权限下放 pmc（单一规则主体），按键组而非整页；其余键仍仅 admin。
 * 键组只在 PMC_WRITABLE_PARAM_KEYS 登记，页面 writableBy 与 updateParam 同源。
 */
describe("admin/params：pmc 键组写权限", () => {
  let db: TestDb;
  let pmc: SessionUser;
  let admin: SessionUser;
  let purchasing: SessionUser;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    const mk = async (name: string, roles: string[]): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover: false }).returning();
      return { id: u.id, name: u.name, roles, isApprover: false };
    };
    pmc = await mk("生产计划", ["pmc"]);
    admin = await mk("管理员", ["admin"]);
    purchasing = await mk("采购", ["purchasing"]);
  });

  it("键组登记：全部是已登记参数；分层/预警/爆单/提报阈值在组内；调拨/账期/比价/批次闸门不在", () => {
    for (const k of PMC_WRITABLE_PARAM_KEYS) expect(PARAM_DEFS.some((d) => d.key === k), k).toBe(true);
    for (const k of ["grade_s_pct", "grade_a_pct", "grade_b_pct", "default_production_lead_days", "alert_buffer_days", "spike_rise_pct", "ops_demand_diff_pct", "cover_target_days_a"]) {
      expect(canWriteParam(["pmc"], k), k).toBe(true);
    }
    for (const k of ["transfer_cost_window_days", "payment_term_target_min_days", "batch_posting_enabled", "dq_tolerance_pct", "warehouse_max_active"]) {
      expect(canWriteParam(["pmc"], k), k).toBe(false);
      expect(canWriteParam(["admin"], k), k).toBe(true);
    }
    expect(canWriteParam(["purchasing"], "grade_s_pct")).toBe(false);
    expect(canWriteParam([], "grade_s_pct")).toBe(false);
  });

  it("updateParam：pmc 可改组内键并留审计；组外键 403；purchasing 403；范围校验不变", async () => {
    await updateParam(pmc, { key: "grade_s_pct", value: 55 }, db);
    const rows = await listParams(db);
    const s = rows.find((r) => r.key === "grade_s_pct")!;
    expect(s.value).toBe(55);
    expect(s.isDefault).toBe(false);
    expect(s.writableBy).toBe("pmc");
    expect(rows.find((r) => r.key === "transfer_cost_window_days")!.writableBy).toBe("admin");
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "sys_param"));
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[audits.length - 1].userId).toBe(pmc.id);

    await expect(updateParam(pmc, { key: "transfer_cost_window_days", value: 90 }, db)).rejects.toMatchObject({ status: 403 });
    await expect(updateParam(purchasing, { key: "grade_s_pct", value: 40 }, db)).rejects.toMatchObject({ status: 403 });
    await expect(updateParam(pmc, { key: "grade_s_pct", value: 999 }, db)).rejects.toMatchObject({ status: 400 });
    await expect(updateParam(pmc, { key: "nope", value: 1 }, db)).rejects.toMatchObject({ status: 400 });
    await updateParam(admin, { key: "transfer_cost_window_days", value: 90 }, db);
    expect((await listParams(db)).find((r) => r.key === "transfer_cost_window_days")!.value).toBe(90);
  });
});
