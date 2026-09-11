/**
 * W1：看门狗统一走 alerts/engine.upsertAlerts 之后的**告警契约**（不是各任务的业务判定，那各有专测）。
 *
 * 迁移前这几类告警是手写 insert 的：没有 dedupe_key（数据库部分唯一索引管不到）、
 * 没有 owner_role（待办与通知一律落 admin）、没有 action_href（页面上没有「去处理」）、
 * 没有 source_rule / params_snapshot / why（展开行是空的）、也不进 alert_events 台账（没有历史）。
 * 本测试逐类钉住这六件事，外加两条易回归的语义：
 *  - 一次性 dedupe_key 回填让历史 open 行被"认领"，而不是同一事实双开；
 *  - data_quality 是周期事实，**不因为下个周期没再命中就自动关账**。
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { runDocAging } from "@/jobs/doc-aging";
import { runFreshnessCheck } from "@/jobs/freshness";
import { runJobFailureWatchdog } from "@/jobs/job-failure-watchdog";
import { runJstTokenWatchdog } from "@/jobs/jst-token-watchdog";
import { ALERT_OWNER_ROLE } from "@/server/rules/task-triggers";

const DAY = 86_400_000;
const NOW = new Date("2026-07-24T04:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

type Db = Awaited<ReturnType<typeof createTestDb>>["db"];

async function alertsOf(db: Db, category: string) {
  return db.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.category, category));
}

async function eventsOf(db: Db, alertId: number) {
  return db.select().from(schema.alertEvents).where(eq(schema.alertEvents.alertId, alertId));
}

describe("W1 看门狗告警契约（引擎统一写入）", () => {
  it("单据超时：dedupeKey / ownerRole / actionHref / sourceRule / why 全部落库，并进 alert_events", async () => {
    const { db, client } = await createTestDb();
    try {
      const [bh] = await db.insert(schema.bhDocs).values({ docNo: "BH-OLD", status: "pending", createdBy: 1, updatedAt: daysAgo(5) }).returning();
      const s = await runDocAging(db, { now: NOW });
      expect(s.opened).toBe(1);

      const [alert] = await alertsOf(db, "doc_aging");
      expect(alert.dedupeKey).toBe("doc_aging:BH:BH-OLD");
      expect(alert.ownerRole, "责任角色取 ALERT_OWNER_ROLE，不再落 admin 缺省").toBe(ALERT_OWNER_ROLE.doc_aging);
      expect(alert.actionHref, "页面「去处理」要能精确打开单据").toBe(`/outsource/bh?docId=${bh.id}`);
      expect(alert.sourceRule).toBeTruthy();
      const snap = alert.paramsSnapshot as { docNo?: string; dwellDays?: number; thresholdDays?: number; why?: unknown[] };
      expect(snap).toMatchObject({ docNo: "BH-OLD", thresholdDays: 3 });
      expect(snap.why?.length, "why[] 随参数快照同行落库（展开行才有依据）").toBeGreaterThan(0);
      expect((await eventsOf(db, alert.id)).map((e) => e.event)).toEqual(["open"]);

      // 再跑：不双开，落 refresh 事件（同一上海日只一条）
      const s2 = await runDocAging(db, { now: NOW });
      expect(s2.opened).toBe(0);
      expect(s2.refreshed).toBe(1);
      expect((await eventsOf(db, alert.id)).map((e) => e.event).sort()).toEqual(["open", "refresh"]);

      // 单据流出等待态：不再命中即刻关闭（autoCloseAfterDays=0），并落 close 事件
      await db.update(schema.bhDocs).set({ status: "approved", updatedAt: NOW }).where(eq(schema.bhDocs.docNo, "BH-OLD"));
      const s3 = await runDocAging(db, { now: NOW });
      expect(s3.autoClosed).toBe(1);
      const closed = (await eventsOf(db, alert.id)).filter((e) => e.event === "close");
      expect(closed).toHaveLength(1);
      expect(closed[0].reasonCode).toBe("auto_hysteresis");
    } finally {
      await client.close();
    }
  });

  it("数据过期：历史无 dedupe_key 的 open 行被回填认领，不会同一事实双开", async () => {
    const { db, client } = await createTestDb();
    try {
      const [job] = await db.insert(schema.importJobs)
        .values({ template: "transit", filename: "t.xlsx", status: "done", createdBy: 1 }).returning();
      await db.insert(schema.transitRefs).values({ kind: "stock_summary", sourceJobId: job.id, skuCode: "A", createdAt: daysAgo(10) });
      // 引擎接入前的手写行：只有 category + ref_key
      const [legacy] = await db.insert(schema.systemAlerts).values({
        category: "data_freshness", refKey: "stock_summary", title: "旧版：参考数据过期", severity: "high",
      }).returning();

      const s = await runFreshnessCheck(db, { now: NOW });
      expect(s.backfilled).toBe(1);
      expect(s.opened, "历史行已被认领，不再新开").toBe(0);
      expect(s.refreshed).toBe(1);

      const rows = await alertsOf(db, "data_freshness");
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(legacy.id);
      expect(rows[0]).toMatchObject({
        dedupeKey: "data_freshness:stock_summary",
        ownerRole: ALERT_OWNER_ROLE.data_freshness,
        actionHref: "/import/upload",
      });
      expect(rows[0].title, "标题按本轮事实刷新").toContain("总库存明细");
    } finally {
      await client.close();
    }
  });

  it("任务失败 / 凭据到期：运维类落 admin 责任角色与 /admin/health 动作链接", async () => {
    const { db, client } = await createTestDb();
    try {
      for (const [i, ok] of [false, false, false].entries()) {
        const at = new Date(NOW.getTime() + i * 60_000);
        await db.insert(schema.jobRuns).values({ job: "sync-jst-sales", ok, message: `失败 #${i}`, startedAt: at, finishedAt: at });
      }
      await runJobFailureWatchdog(db, { now: NOW });
      const [jobAlert] = await alertsOf(db, "job_failure");
      expect(jobAlert).toMatchObject({
        dedupeKey: "job_failure:sync-jst-sales",
        ownerRole: ALERT_OWNER_ROLE.job_failure,
        actionHref: "/admin/health",
      });
      expect((jobAlert.paramsSnapshot as { consecutiveFailures?: number }).consecutiveFailures).toBe(3);

      await runJstTokenWatchdog(db, {
        now: NOW,
        env: { JST_ACCESS_TOKEN: "tok", JST_TOKEN_TTL_DAYS: "30", JST_TOKEN_OBTAINED_AT: "2026-06-30T00:00:00Z" } as unknown as NodeJS.ProcessEnv,
      });
      const [tokenAlert] = await alertsOf(db, "integration_token");
      expect(tokenAlert).toMatchObject({
        dedupeKey: "integration_token:jst_access_token",
        ownerRole: ALERT_OWNER_ROLE.integration_token,
        actionHref: "/admin/health",
      });
      const why = (tokenAlert.paramsSnapshot as { why?: { value: string }[] }).why ?? [];
      expect(why.length).toBeGreaterThan(0);
      expect(JSON.stringify(why), "凭据本身绝不进快照").not.toContain("tok");
    } finally {
      await client.close();
    }
  });

  it("凭据未配置时不动既有告警（没授权≠已解决）", async () => {
    const { db, client } = await createTestDb();
    try {
      await runJstTokenWatchdog(db, {
        now: NOW,
        env: { JST_ACCESS_TOKEN: "tok", JST_TOKEN_TTL_DAYS: "30" } as unknown as NodeJS.ProcessEnv,
      });
      expect(await alertsOf(db, "integration_token")).toHaveLength(1);

      const skipped = await runJstTokenWatchdog(db, { now: NOW, env: {} as unknown as NodeJS.ProcessEnv });
      expect(skipped.status).toBe("skipped");
      const open = await db.select().from(schema.systemAlerts).where(and(
        eq(schema.systemAlerts.category, "integration_token"), eq(schema.systemAlerts.status, "open"),
      ));
      expect(open, "跳过检查不得把告警当成已解决关掉").toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
