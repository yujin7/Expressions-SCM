"use client";

/** 第 4 屏「待办跟进进度」卡：只 fetch /api/todo/stats?scope=summary（驾驶舱 cockpit 屏 4 装配同一数据块） */
import { useCallback, useEffect, useState } from "react";
import { Card, Col, Progress, Row, Space, Statistic, Tooltip, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { roleLabel } from "@/components/dictionary";

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

export default function TodoProgressCard({ refreshKey, compact }: { refreshKey?: number; compact?: boolean }) {
  const [data, setData] = useState<TodoProgressBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setData(await fetchJson<TodoProgressBlock>("/api/todo/stats?scope=summary")); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <Card size="small" loading={loading && !data} title={`待办跟进进度（${data?.month ?? "本月"}）`} extra={<a href="/todo">查看全部待办 →</a>}>
      <LoadErrorAlert error={error} onRetry={() => void load()} subject="待办进度" retrying={loading} />
      <Row gutter={[10, 10]} className="compact-kpi-row">
        <Col><a href="/todo?mine_status=active"><Statistic title="指派给我·未完成" value={dash(data?.mine.open)} /></a></Col>
        <Col><a href="/todo?mine_status=active&mine_overdue=1"><Statistic title="我的逾期" value={dash(data?.mine.overdue)} valueStyle={{ color: (data?.mine.overdue ?? 0) > 0 ? "#cf1322" : undefined }} /></a></Col>
        <Col><a href="/todo?all_status=active"><Statistic title="范围内未完成" value={dash(data?.totals.open)} /></a></Col>
        <Col><a href="/todo?all_status=active&all_overdue=1"><Statistic title="范围内逾期" value={dash(data?.totals.overdue)} valueStyle={{ color: (data?.totals.overdue ?? 0) > 0 ? "#cf1322" : undefined }} /></a></Col>
        <Col>
          <Tooltip title={data?.caliber}>
            <Statistic title="本月完成率" value={data?.totals.completionRate ?? "—"} suffix={data?.totals.completionRate != null ? "%" : undefined} />
          </Tooltip>
        </Col>
      </Row>
      {!compact ? (
        <Space direction="vertical" style={{ width: "100%", marginTop: 8 }} size={2}>
          {(data?.byRole ?? []).map((r) => (
            <Row key={r.role} align="middle" gutter={8}>
              <Col flex="90px"><a href={`/todo?all_ownerRole=${r.role}`}>{roleLabel(r.role)}</a></Col>
              <Col flex="auto">
                <Progress
                  percent={r.completionRate ?? 0}
                  size="small"
                  format={() => (r.completionRate == null ? "本月无系统待办" : `${r.completionRate}%`)}
                  status={r.overdue > 0 ? "exception" : undefined}
                />
              </Col>
              <Col flex="160px">
                <Typography.Text type="secondary">
                  未完成 <a href={`/todo?all_ownerRole=${r.role}&all_status=active`}>{r.open}</a> · 逾期 <a href={`/todo?all_ownerRole=${r.role}&all_status=active&all_overdue=1`}>{r.overdue}</a>
                </Typography.Text>
              </Col>
            </Row>
          ))}
        </Space>
      ) : null}
    </Card>
  );
}
