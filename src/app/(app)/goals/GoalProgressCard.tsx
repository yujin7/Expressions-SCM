"use client";

/** 第 4 屏「供应链目标」卡：只 fetch /api/goals?scope=summary（驾驶舱 cockpit 屏 4 装配同一数据块） */
import { useEffect, useState } from "react";
import { Card, Col, Row, Statistic, Tooltip, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";

export interface GoalsBlock {
  generatedAt: string;
  periods: { month: string; quarter: string };
  byDept: { deptKey: string; total: number; withActual: number; attained: number; attainmentRate: string | null; editable: boolean }[];
  caliber: string;
  href: string;
}

const ROLE_LABEL: Record<string, string> = {
  ops: "运营", purchasing: "采购", warehouse: "仓管", quality: "质量合规", pmc: "生产计划", finance: "财务", admin: "管理员",
};

export default function GoalProgressCard({ refreshKey }: { refreshKey?: number }) {
  const [data, setData] = useState<GoalsBlock | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchJson<GoalsBlock>("/api/goals?scope=summary").then(setData).catch((e: Error) => setError(e.message));
  }, [refreshKey]);
  const withGoals = (data?.byDept ?? []).filter((d) => d.total > 0);
  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title={`供应链目标（${data ? `${data.periods.month} / ${data.periods.quarter}` : "本月 / 本季"}）`}
      extra={<Tooltip title={data?.caliber}><Typography.Text type="secondary">口径</Typography.Text></Tooltip>}
    >
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {!withGoals.length && !error ? <Typography.Text type="secondary">本期尚未设置任何部门目标。</Typography.Text> : null}
      <Row gutter={[10, 10]} className="compact-kpi-row">
        {withGoals.map((d) => (
          <Col key={d.deptKey}>
            <Statistic
              title={`${ROLE_LABEL[d.deptKey] ?? d.deptKey} · ${d.attained}/${d.withActual} 达成`}
              value={d.attainmentRate ?? "—"}
              suffix={d.attainmentRate != null ? "%" : undefined}
              valueStyle={{ color: d.attainmentRate == null ? undefined : Number(d.attainmentRate) >= 100 ? "#3f8600" : "#cf1322" }}
            />
            {d.total > d.withActual ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{d.total - d.withActual} 项暂无实际值</Typography.Text> : null}
          </Col>
        ))}
      </Row>
    </Card>
  );
}
