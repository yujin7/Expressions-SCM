"use client";

/** 第 4 屏「待办跟进进度」卡：只 fetch /api/todo/stats?scope=summary（驾驶舱 cockpit 屏 4 装配同一数据块） */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, Progress } from "antd";
import { fetchJson } from "@/components/fetchJson";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { roleLabel } from "@/components/dictionary";
import styles from "./TodoProgressCard.module.css";

export interface TodoProgressBlock {
  generatedAt: string;
  month: string;
  mine: { open: number; overdue: number };
  totals: { open: number; overdue: number; doneThisMonth: number; completionRate: number | null };
  byRole: { role: string; open: number; overdue: number; doneThisMonth: number; completionRate: number | null }[];
  caliber: string;
  href: string;
}

/** 未加载 / 加载失败一律显示 —，不用 0 冒充（与驾驶舱「绝不显示 0」同一纪律） */
const dash = (v: number | null | undefined): number | string => (v == null ? "—" : v);

function activeHref(view: "mine" | "all", role?: string, overdue?: boolean): string {
  const params = new URLSearchParams({ tab: view, [`${view}_status`]: "active" });
  if (role) params.set(`${view}_ownerRole`, role);
  if (overdue) params.set(`${view}_overdue`, "1");
  return `/todo?${params}`;
}

export default function TodoProgressCard({ refreshKey, compact }: { refreshKey?: number; compact?: boolean }) {
  const [data, setData] = useState<TodoProgressBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadRequest = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    loadRequest.current?.abort();
    const request = new AbortController();
    loadRequest.current = request;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchJson<TodoProgressBlock>("/api/todo/stats?scope=summary", { signal: request.signal });
      if (!request.signal.aborted) setData(next);
    }
    catch (e) {
      if (!request.signal.aborted) { setData(null); setError((e as Error).message); }
    }
    finally { if (!request.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    return () => { loadRequest.current?.abort(); };
  }, [load, refreshKey]);

  return (
    <Card
      size="small"
      className={`${styles.card}${compact ? ` ${styles.compact}` : ""}`}
      title="待办跟进进度"
      extra={<div className={styles.actions}><Button type="text" size="small" loading={loading} onClick={() => void load()}>刷新</Button><Link href="/todo?tab=all" prefetch={false}>全部待办 →</Link></div>}
    >
      <LoadErrorAlert error={error} onRetry={() => void load()} subject="待办进度" retrying={loading} />
      <div className={styles.metrics} aria-busy={loading}>
        <section className={styles.metric} aria-label="我的待办摘要">
          <span className={styles.label}>指派给我 · 未完成</span>
          <Link className={styles.value} href={activeHref("mine")} prefetch={false}>{dash(data?.mine.open)}</Link>
        </section>
        <section className={styles.metric} aria-label="我的逾期摘要">
          <span className={styles.label}>我的逾期</span>
          <Link className={`${styles.value}${data && data.mine.overdue > 0 ? ` ${styles.overdue}` : ""}`} href={activeHref("mine", undefined, true)} prefetch={false}>{dash(data?.mine.overdue)}</Link>
        </section>
        <section className={styles.metric} aria-label="可见范围待办摘要">
          <span className={styles.label}>可见范围 · 未完成</span>
          <Link className={styles.value} href={activeHref("all")} prefetch={false}>{dash(data?.totals.open)}</Link>
        </section>
        <section className={styles.metric} aria-label="可见范围逾期摘要">
          <span className={styles.label}>可见范围 · 逾期</span>
          <Link className={`${styles.value}${data && data.totals.overdue > 0 ? ` ${styles.overdue}` : ""}`} href={activeHref("all", undefined, true)} prefetch={false}>{dash(data?.totals.overdue)}</Link>
        </section>
        <section className={styles.metric} aria-label="本月系统待办完成摘要">
          <span className={styles.label}>本月创建 · 已完成</span>
          <span className={styles.value}>{dash(data?.totals.doneThisMonth)}</span>
        </section>
        <section className={styles.metric} aria-label="本月完成率摘要">
          <span className={styles.label}>本月完成率 · 宽</span>
          <span className={styles.value}>{data?.totals.completionRate == null ? "—" : `${data.totals.completionRate}%`}</span>
          <span className={styles.secondary}>{data ? data.totals.completionRate == null ? "无可计算系统待办" : `${data.month} 创建批次` : "数据未加载"}</span>
        </section>
      </div>
      <div className={styles.status} role="status">
        {loading ? data ? "更新中，以上为上次结果" : "正在加载待办进度…" : data ? `统计月份 ${data.month} · 未完成与逾期含手工待办` : error ? "本次统计不可用，指标保持未知" : "数据未加载"}
      </div>
      <details className={styles.details}>
        <summary>角色明细与统计口径{data ? <span className={styles.secondary}> · {data.byRole.length} 个角色</span> : null}</summary>
        {data ? (
          <div className={styles.evidence}>
            <p className={styles.secondary}>本月创建的系统待办中已完成 {data.totals.doneThisMonth} 条；完成率不含手工来源，未完成与逾期按当前状态计。角色明细只展示你的可见范围，不作员工排名。</p>
            {data.byRole.length ? <div className={styles.roles}>
              {data.byRole.map((r) => (
                <section key={r.role} className={styles.role} aria-label={`${roleLabel(r.role)}待办进度`}>
                  <Link className={styles.roleName} href={activeHref("all", r.role)} prefetch={false}>{roleLabel(r.role)}</Link>
                  <div className={styles.roleCounts}>
                    <Link href={activeHref("all", r.role)} prefetch={false}>未完成 {r.open}</Link>
                    <Link className={r.overdue > 0 ? styles.overdue : undefined} href={activeHref("all", r.role, true)} prefetch={false}>逾期 {r.overdue}</Link>
                    <span className={styles.secondary}>本月创建·已完成 {r.doneThisMonth}</span>
                  </div>
                  <div className={styles.roleRate}>
                    {r.completionRate == null ? <span className={styles.secondary}>本月无可计算系统待办</span> : <Progress percent={r.completionRate} size="small" status={r.overdue > 0 ? "exception" : "normal"} />}
                  </div>
                </section>
              ))}
            </div> : <p className={styles.secondary}>当前范围没有角色分组；不代表你的个人待办为零。</p>}
            <p className={styles.caliber}>{data.caliber}</p>
            <p className={styles.secondary}>生成于 {new Date(data.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（上海时间）</p>
          </div>
        ) : <p className={styles.secondary}>{error ? "统计加载失败，请重试后查看明细和口径。" : "统计加载后显示明细和完整口径。"}</p>}
      </details>
    </Card>
  );
}
