/**
 * system_alerts → 通知发件箱 测试。
 *
 * 背景：runExceptionNotify 只推业务异常；system_alerts（数据过期/单据超时/
 * 凭据到期/任务失败）此前**从不通知任何人**，只躺在 /alerts 页面上。
 * 三方同步挂了会开告警，但没人被告知——监控链路断在最后一米。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { notifications, systemAlerts } from "@/db/schema";
import { runSystemAlertNotify } from "@/jobs/system-alert-notify";
import { createTestDb } from "../helpers/db";

async function openAlert(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  values: { category: string; title: string; detail?: string; severity?: string },
) {
  const [row] = await db.insert(systemAlerts).values({
    category: values.category,
    title: values.title,
    detail: values.detail ?? null,
    severity: values.severity ?? "high",
  }).returning();
  return row;
}

describe("system_alerts 推进通知发件箱", () => {
  it("未处理告警会入队，标题带中文类别前缀", async () => {
    const { db } = await createTestDb();
    await openAlert(db, {
      category: "job_failure",
      title: "定时任务「sync-yonyou」已连续失败 3 次",
      detail: "最近一次错误：连接超时",
    });

    const result = await runSystemAlertNotify(db);
    expect(result).toMatchObject({ enqueued: 1, scanned: 1 });

    const [note] = await db.select().from(notifications);
    expect(note.title).toContain("【任务失败】");
    expect(note.title).toContain("sync-yonyou");
    expect(note.body).toContain("连接超时");
    expect(note.href).toBe("/alerts");
    // 运维/集成问题给 admin，不混进 PMC 的业务待办里稀释信噪比
    expect(note.targetRole).toBe("admin");
  });

  it("同一条告警只推一次（重复跑不刷屏）", async () => {
    const { db } = await createTestDb();
    await openAlert(db, { category: "integration_token", title: "聚水潭 token 还有 5 天过期" });

    await runSystemAlertNotify(db);
    const second = await runSystemAlertNotify(db);

    expect(second.enqueued).toBe(0);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("已解决的告警不再推送", async () => {
    const { db } = await createTestDb();
    const alert = await openAlert(db, { category: "data_freshness", title: "参考数据过期" });
    await db.update(systemAlerts)
      .set({ status: "resolved", autoResolved: true })
      .where(eq(systemAlerts.id, alert.id));

    const result = await runSystemAlertNotify(db);
    expect(result).toMatchObject({ enqueued: 0, scanned: 0 });
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  it("未知类别退化为原样显示，不因缺标签而丢掉通知", async () => {
    const { db } = await createTestDb();
    await openAlert(db, { category: "brand_new_category", title: "某新类别告警" });
    const result = await runSystemAlertNotify(db);
    expect(result.enqueued).toBe(1);
    const [note] = await db.select().from(notifications);
    expect(note.title).toContain("brand_new_category");
  });

  it("多条告警逐条入队", async () => {
    const { db } = await createTestDb();
    await openAlert(db, { category: "job_failure", title: "任务 A 失败" });
    await openAlert(db, { category: "integration_token", title: "凭据将到期" });
    await openAlert(db, { category: "doc_aging", title: "单据超时" });

    const result = await runSystemAlertNotify(db);
    expect(result.enqueued).toBe(3);
    expect(await db.select().from(notifications)).toHaveLength(3);
  });

  it("数据产品门禁降级通知产品责任角色，并直达对应门禁", async () => {
    const { db } = await createTestDb();
    await db.insert(systemAlerts).values({
      category: "data_product_gate",
      refKey: "demand-pulse:41",
      title: "数据产品「需求脉搏」已从 A2 自动降级",
      severity: "medium",
    });

    const result = await runSystemAlertNotify(db);
    expect(result).toMatchObject({ enqueued: 2, scanned: 1 });
    const notes = await db.select().from(notifications);
    expect(notes.map((row) => row.targetRole).sort()).toEqual(["ops", "pmc"]);
    expect(notes.every((row) => row.title.includes("【决策门禁降级】"))).toBe(true);
    expect(notes.every((row) => row.href?.includes("product=demand-pulse"))).toBe(true);
  });

  it("按告警行自己的 ownerRole 与 actionHref 分派（W1 后不再靠类别硬编码表）", async () => {
    const { db } = await createTestDb();
    await db.insert(systemAlerts).values({
      category: "doc_aging",
      refKey: "BH:BH-2026-0001",
      title: "备货申请 BH-2026-0001 停留「待审批」已 5 天",
      severity: "high",
      ownerRole: "pmc",
      actionHref: "/outsource/bh?q=BH-2026-0001",
    });

    const result = await runSystemAlertNotify(db);
    expect(result).toMatchObject({ enqueued: 1, scanned: 1 });
    const [note] = await db.select().from(notifications);
    // 迁移前：doc_aging 一律 admin + /alerts，责任人根本收不到、点进去也不是单据
    expect(note.targetRole).toBe("pmc");
    expect(note.href).toBe("/outsource/bh?q=BH-2026-0001");
  });

  it("行上没有 ownerRole/actionHref 的历史告警回落类别表，不因缺字段丢通知", async () => {
    const { db } = await createTestDb();
    await db.insert(systemAlerts).values({ category: "transfer_cost", refKey: "doc:DB-0001", title: "调拨成本异常", severity: "high" });

    const result = await runSystemAlertNotify(db);
    expect(result.enqueued).toBe(1);
    const [note] = await db.select().from(notifications);
    // 责任角色回落类别表首位（迁移前口径），链接回落类别表
    expect(note.targetRole).toBe("warehouse");
    expect(note.href).toBe("/inventory/transfer-routes?tab=anomalies");
  });

  it("行上的 ownerRole 覆盖类别表回落值（引擎写入的行以行为准）", async () => {
    const { db } = await createTestDb();
    await db.insert(systemAlerts).values({
      category: "inventory_cover", refKey: "SKU-1", title: "S 级 SKU-1 已断货", severity: "high",
      ownerRole: "pmc", actionHref: "/inventory/alerts?tab=cover&cover_q=SKU-1",
    });
    const result = await runSystemAlertNotify(db);
    expect(result.enqueued).toBe(1);
    const [note] = await db.select().from(notifications);
    expect(note.targetRole).toBe("pmc");
    expect(note.href).toBe("/inventory/alerts?tab=cover&cover_q=SKU-1");
  });

  it("没有未处理告警时什么也不做", async () => {
    const { db } = await createTestDb();
    expect(await runSystemAlertNotify(db)).toMatchObject({ enqueued: 0, scanned: 0 });
  });
});
