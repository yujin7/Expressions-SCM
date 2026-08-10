/**
 * 同步时间窗：**只在午饭前与傍晚前各一次**（2026-08-04 业务口径）。
 *
 * 为什么钉住：拉数是给人看的——上午下班前、下班前各刷新一次即可。
 * 原来每 6 小时一轮，深夜那两轮无人消费，还白占三方接口配额
 * （简道云单轮 8.5 万行、约 850 次分页往返、耗时约 12 分钟）。
 *
 * 还要钉住**编排顺序**：先拉数（10/16 点），再跑对账与告警投递（11/17 点）。
 * 顺序反了的话，本轮同步暴露的问题要等下一轮才通知到人，
 * 等于把「傍晚发现问题」推迟到「次日上午」。
 */
import { describe, expect, it } from "vitest";
import { INTERVAL_JOBS, shanghaiHourKey, shouldRunAt } from "@/jobs/interval-runner";
import { SCHEDULES } from "@/jobs/scheduler";

/** 从 cron 的小时字段取出所有小时 */
function cronHours(expr: string): number[] {
  const hourField = expr.trim().split(/\s+/)[1] ?? "";
  if (hourField.includes("*")) return [];
  return hourField.split(",").map(Number).filter(Number.isInteger);
}

const PULL_JOBS = [
  "sync-yonyou",
  "sync-jst-sales",
  "sync-jst-inventory",
  "sync-jiandaoyun-forms",
];
/** 依赖同步结果的下游：必须排在拉数之后 */
const DOWNSTREAM_JOBS = [
  // 数据龄检查也算下游：排在拉数之前会在同步刷新前十分钟天天报假"数据过期"
  "snapshot-age",
  "reconcile-jst",
  "job-failure-watchdog",
  "system-alert-notify",
  "notify-dispatch",
];

describe("同步时间窗：午饭前与傍晚前各一次", () => {
  it("拉数任务只在 10 点与 16 点跑，不再每 6 小时空转", () => {
    for (const name of PULL_JOBS) {
      expect(SCHEDULES[name], `${name} 缺 cron`).toBeTruthy();
      expect(cronHours(SCHEDULES[name]), `${name} 的小时窗不对`).toEqual([10, 16]);
    }
  });

  it("下游对账与告警排在拉数之后（11/17 点），否则问题要等下一轮才通知到人", () => {
    for (const name of DOWNSTREAM_JOBS) {
      expect(cronHours(SCHEDULES[name]), `${name} 应在拉数之后`).toEqual([11, 17]);
    }
  });

  it("没有任何同步任务残留 `*/N` 这类高频表达式", () => {
    const offenders = [...PULL_JOBS, ...DOWNSTREAM_JOBS]
      .filter((name) => SCHEDULES[name]?.includes("*/"));
    expect(
      offenders,
      `以下同步任务仍是高频轮转：${offenders.join(", ")}\n`
        + `业务口径是午饭前与傍晚前各一次；高频拉数无人消费还占三方配额。`,
    ).toEqual([]);
  });

  it("PGlite 回退的 interval 任务与 cron 表达同一个窗口", () => {
    const byName = new Map(INTERVAL_JOBS.map((job) => [job.name, job]));
    for (const name of PULL_JOBS) {
      expect(byName.get(name)?.atHours, `${name} 的 interval 窗口应与 cron 一致`).toEqual([10, 16]);
    }
    for (const name of DOWNSTREAM_JOBS) {
      expect(byName.get(name)?.atHours, `${name} 的 interval 窗口应与 cron 一致`).toEqual([11, 17]);
    }
  });

  it("简道云目录每日只拉一次——它变化很慢，跟着业务数据一天两拉是浪费", () => {
    expect(cronHours(SCHEDULES["sync-jiandaoyun-catalog"])).toEqual([10]);
    const job = INTERVAL_JOBS.find((j) => j.name === "sync-jiandaoyun-catalog");
    expect(job?.atHours).toEqual([10]);
  });
});

describe("上海时区小时键", () => {
  it("按 Asia/Shanghai 取小时，而不是服务器本地时区", () => {
    // 2026-08-04T02:30:00Z = 上海 10:30
    const { hour, key } = shanghaiHourKey(new Date("2026-08-04T02:30:00Z"));
    expect(hour).toBe(10);
    expect(key).toBe("2026-08-04T10");
  });

  it("同一小时内键相同（用于防重复跑），跨小时后变化", () => {
    const a = shanghaiHourKey(new Date("2026-08-04T02:05:00Z"));
    const b = shanghaiHourKey(new Date("2026-08-04T02:55:00Z"));
    const c = shanghaiHourKey(new Date("2026-08-04T03:05:00Z"));
    expect(a.key).toBe(b.key);
    expect(c.key).not.toBe(a.key);
  });

  it("跨 UTC 日界时仍按上海日期归属", () => {
    // 2026-08-03T16:30:00Z = 上海次日 00:30
    const { hour, key } = shanghaiHourKey(new Date("2026-08-03T16:30:00Z"));
    expect(hour).toBe(0);
    expect(key).toBe("2026-08-04T00");
  });
});

describe("定点执行判断（shouldRunAt）", () => {
  const job = { name: "sync-jiandaoyun-forms", atHours: [10, 16] };
  const at = (utc: string): Date => new Date(utc);

  it("到点才跑：上海 10 点跑，9 点与 11 点都不跑", () => {
    expect(shouldRunAt(job, at("2026-08-04T02:00:00Z"), new Map()).run).toBe(true);  // 10:00
    expect(shouldRunAt(job, at("2026-08-04T01:00:00Z"), new Map()).run).toBe(false); // 09:00
    expect(shouldRunAt(job, at("2026-08-04T03:00:00Z"), new Map()).run).toBe(false); // 11:00
  });

  it("傍晚窗口同样命中（上海 16 点）", () => {
    expect(shouldRunAt(job, at("2026-08-04T08:00:00Z"), new Map()).run).toBe(true);
  });

  it("同一小时内只跑一次——轮询每 20 分钟一次，不能一小时跑三遍", () => {
    const seen = new Map<string, string>();
    const first = shouldRunAt(job, at("2026-08-04T02:05:00Z"), seen);
    expect(first.run).toBe(true);
    seen.set(job.name, first.hourKey!);

    expect(shouldRunAt(job, at("2026-08-04T02:25:00Z"), seen).run).toBe(false);
    expect(shouldRunAt(job, at("2026-08-04T02:45:00Z"), seen).run).toBe(false);
  });

  it("次日同一小时会重新跑（键含日期，不是只记小时）", () => {
    const seen = new Map<string, string>([[job.name, "2026-08-04T10"]]);
    expect(shouldRunAt(job, at("2026-08-05T02:05:00Z"), seen).run).toBe(true);
  });

  it("没有 atHours 的任务不受影响，照常按 everyMs 跑", () => {
    expect(shouldRunAt({ name: "rollup" }, at("2026-08-04T19:00:00Z"), new Map()))
      .toEqual({ run: true, hourKey: null });
  });
});
