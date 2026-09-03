"use client";

/** 第 4 屏「待办跟进进度」卡：只 fetch /api/todo/stats?scope=summary（驾驶舱 cockpit 屏 4 装配同一数据块） */
import { useEffect, useState } from "react";
import { Card, Col, Progress, Row, Space, Statistic, Tooltip, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";

export interface TodoProgressBlock {
  generatedAt: string;
  month: string;
  mine: { open: number; overdue: number };
  totals: { open: number; overdue: number; doneThisMonth: number; completionRate: number | null };
  byRole: { role: string; open: number; overdue: number; doneThisMonth: number; completionRate: number | null }[];
  caliber: string;
  href: string;
}

const ROLE_LABEL: Record<string, string> = {
  ops: "运营", purchasing: "采购", warehouse: "仓管", quality: "质量合规", pmc: "生产计划", finance: "财务", admin: "管理员",
};

export default function TodoProgressCard({ refreshKey, compact }: { refreshKey?: number; compact?: boolean }) {
  const [data, setData] = useState<TodoProgressBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchJson<TodoProgressBlock>("/api/todo/stats?scope=summary").then(setData).catch((e: Error) => setError(e.message));
  }, [refreshKey]);

  return (
    <Card size="small" title={`待办跟进进度（${data?.month ?? "本月"}）`} extra={<a href="/todo">→ /todo</a>}>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      <Row gutter={[10, 10]} className="compact-kpi-row">
        <Col><Statistic title="指派给我·未完成" value={data?.mine.open ?? 0} /></Col>
        <Col><Statistic title="我的逾期" value={data?.mine.overdue ?? 0} valueStyle={{ color: (data?.mine.overdue ?? 0) > 0 ? "#cf1322" : undefined }} /></Col>
        <Col><Statistic title="范围内未完成" value={data?.totals.open ?? 0} /></Col>
        <Col><Statistic title="范围内逾期" value={data?.totals.overdue ?? 0} valueStyle={{ color: (data?.totals.overdue ?? 0) > 0 ? "#cf1322" : undefined }} /></Col>
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
              <Col flex="90px"><a href={`/todo?all_ownerRole=${r.role}`}>{ROLE_LABEL[r.role] ?? r.role}</a></Col>
              <Col flex="auto">
                <Progress
                  percent={r.completionRate ?? 0}
                  size="small"
                  format={() => (r.completionRate == null ? "本月无系统待办" : `${r.completionRate}%`)}
                  status={r.overdue > 0 ? "exception" : undefined}
                />
              </Col>
              <Col flex="140px"><Typography.Text type="secondary">未完成 {r.open} · 逾期 {r.overdue}</Typography.Text></Col>
            </Row>
          ))}
        </Space>
      ) : null}
    </Card>
  );
}
