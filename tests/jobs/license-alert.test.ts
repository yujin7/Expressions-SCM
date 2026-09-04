/**
 * license-alert（《02》§5）：30 天窗口含已过期；daysLeft 负数=过期天数。
 * 决策：不写 audit_logs（无系统用户主数据）——纯查询任务，见 src/jobs/license-alert.ts 头注。
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import {
  runLicenseAlert, LICENSE_ALERT_ACTIVE_STATUSES, LICENSE_ALERT_EXPIRED_FLOOR_DAYS,
  LICENSE_ALERT_MAX_ROWS, LICENSE_ALERT_WINDOW_DAYS,
} from "@/jobs/license-alert";

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

/**
 * C6 回归：**首跑不许炸告警墙**。
 *
 * 事故形状：`license_expiry <= today+30` 没有下界、也不看 `suppliers.status`。
 * 导入的 156 家生产主数据里，早已过期若干年的证照、以及暂停/黑名单供应商的证照，
 * 全部 `severity: high` 起告警，每条 open 告警又投影一条采购待办——一批就是几十上百条。
 * 三道边界（状态白名单 / 已过期下界 / 单批上限）都在这里钉住，且截断必须**可见**。
 */
describe("C6 license-alert 的三道体量边界", () => {
  const seedOne = (code: string, over: Record<string, unknown>) => ({
    code, name: code, licenseExpiry: "2026-07-19", ...over,
  });

  it("状态过滤：暂停/黑名单供应商不报（它们本来就不许下新 PO，「去续期」不是一个动作）", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.suppliers).values([
      seedOne("S-QUAL", { status: "qualified" }),
      seedOne("S-PEND", { status: "pending" }),
      seedOne("S-PAUSE", { status: "paused" }),
      seedOne("S-BLACK", { status: "blacklisted" }),
    ]);
    const res = await runLicenseAlert(db, TODAY);
    expect(res.alerts.map((a) => a.code).sort()).toEqual(["S-PEND", "S-QUAL"]);
    expect([...res.statuses].sort()).toEqual([...LICENSE_ALERT_ACTIVE_STATUSES].sort());
  });

  it("已过期下界：过期太久的属于主数据清理，不该每 6 小时叫醒一次采购", async () => {
    const { db } = await createTestDb();
    const dayBefore = (n: number) =>
      new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    await db.insert(schema.suppliers).values([
      seedOne("S-JUST", { status: "qualified", licenseExpiry: dayBefore(LICENSE_ALERT_EXPIRED_FLOOR_DAYS - 1) }),
      seedOne("S-OLD", { status: "qualified", licenseExpiry: dayBefore(LICENSE_ALERT_EXPIRED_FLOOR_DAYS + 1) }),
      seedOne("S-ANCIENT", { status: "qualified", licenseExpiry: "2019-01-01" }),
    ]);
    const res = await runLicenseAlert(db, TODAY);
    expect(res.alerts.map((a) => a.code)).toEqual(["S-JUST"]);
    expect(res.expiredFloorDays).toBe(LICENSE_ALERT_EXPIRED_FLOOR_DAYS);
  });

  it("体量硬闸：一次批量导入把大量证照写成同一个过去日期时，本批条数不超上限且截断可见", async () => {
    const { db } = await createTestDb();
    const many = LICENSE_ALERT_MAX_ROWS + 20;
    await db.insert(schema.suppliers).values(
      Array.from({ length: many }, (_, i) => seedOne(`S-BULK-${String(i).padStart(3, "0")}`, {
        status: "qualified",
        // 过期天数各不相同：最紧的排前面，截断的是最不紧的那些
        licenseExpiry: new Date(Date.parse(`${TODAY}T00:00:00Z`) - (i + 1) * 86_400_000).toISOString().slice(0, 10),
      })),
    );
    const res = await runLicenseAlert(db, TODAY);
    expect(res.alertCount).toBeLessThanOrEqual(LICENSE_ALERT_MAX_ROWS);
    expect(res.alertCount).toBe(LICENSE_ALERT_MAX_ROWS);
    expect(res.totalCandidates, "截断必须可见，不能静默丢").toBe(many);
    expect(res.truncated).toBe(true);
    // 保留的是最紧的那些（daysLeft 升序 = 过期最久的在前）
    expect(res.alerts[0].daysLeft).toBeLessThan(res.alerts[res.alerts.length - 1].daysLeft);
  });

  it("未截断时 truncated=false，且 totalCandidates 与行数一致", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.suppliers).values([seedOne("S-ONE", { status: "qualified" })]);
    const res = await runLicenseAlert(db, TODAY);
    expect(res).toMatchObject({ alertCount: 1, totalCandidates: 1, truncated: false, maxRows: LICENSE_ALERT_MAX_ROWS });
  });
});
