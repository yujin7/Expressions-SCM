/**
 * license-alert（《02》§5）：30 天窗口含已过期；daysLeft 负数=过期天数。
 * 决策：不写 audit_logs（无系统用户主数据）——纯查询任务，见 src/jobs/license-alert.ts 头注。
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import { runLicenseAlert, LICENSE_ALERT_WINDOW_DAYS } from "@/jobs/license-alert";

const TODAY = "2026-07-24";

describe("runLicenseAlert", () => {
  it("过期/15天/90天 三档 → 返回 2 条，daysLeft 正确且升序", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.suppliers).values([
      { code: "S-EXP", name: "已过期供应商", licenseExpiry: "2026-07-19" }, // -5
      { code: "S-15D", name: "15天到期供应商", licenseExpiry: "2026-08-08" }, // 15
      { code: "S-90D", name: "90天到期供应商", licenseExpiry: "2026-10-22" }, // 90 → 不报
      { code: "S-NUL", name: "无资质日期供应商", licenseExpiry: null }, // 不报
    ]);

    const res = await runLicenseAlert(db, TODAY);
    expect(res.today).toBe(TODAY);
    expect(res.windowDays).toBe(LICENSE_ALERT_WINDOW_DAYS);
    expect(res.alertCount).toBe(2);
    expect(res.alerts.map((a) => [a.code, a.licenseExpiry, a.daysLeft])).toEqual([
      ["S-EXP", "2026-07-19", -5],
      ["S-15D", "2026-08-08", 15],
    ]);
    expect(res.alerts[0]).toMatchObject({ name: "已过期供应商", supplierId: expect.any(Number) });
  });

  it("边界：恰好 30 天到期入报；31 天不入", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.suppliers).values([
      { code: "S-30D", name: "恰30天", licenseExpiry: "2026-08-23" },
      { code: "S-31D", name: "31天", licenseExpiry: "2026-08-24" },
    ]);
    const res = await runLicenseAlert(db, TODAY);
    expect(res.alerts.map((a) => a.code)).toEqual(["S-30D"]);
    expect(res.alerts[0].daysLeft).toBe(30);
  });

  it("today 非法格式抛错", async () => {
    const { db } = await createTestDb();
    await expect(runLicenseAlert(db, "2026/7/24")).rejects.toThrow();
  });
});
