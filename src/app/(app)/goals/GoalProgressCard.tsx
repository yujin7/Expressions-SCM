"use client";

/** 第 4 屏「供应链目标」卡：只 fetch /api/goals?scope=summary（驾驶舱 cockpit 屏 4 装配同一数据块） */
import { Card, Col, Row, Skeleton, Statistic, Typography } from "antd";
import { roleLabel } from "@/components/dictionary";
import ContextHelp from "@/components/ContextHelp";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { useDocumentRead } from "@/components/useDocumentRead";

export interface GoalsBlock {
  generatedAt: string;
  periods: { month: string; quarter: string };
  byDept: { deptKey: string; total: number; withActual: number; attained: number; attainmentRate: string | null; editable: boolean }[];
  caliber: string;
  href: string;
}

export default function GoalProgressCard({ refreshKey }: { refreshKey?: number }) {
  // refresh只标识本页写入后的读取轮次；API仍走相同scope与授权，不是业务筛选。
  const { data, error, phase, retry } = useDocumentRead<GoalsBlock>(`/api/goals?scope=summary&refresh=${refreshKey ?? 0}`);
  const withGoals = (data?.byDept ?? []).filter((d) => d.total > 0);
  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title={`供应链目标（${data ? `${data.periods.month} / ${data.periods.quarter}` : "本月 / 本季"}）`}
      extra={data ? <ContextHelp label="部门目标汇总口径" title="部门目标汇总" content={data.caliber} /> : undefined}
    >
      <LoadErrorAlert error={error} onRetry={retry} subject="目标摘要" />
      {phase === "loading" ? <Skeleton active paragraph={{ rows: 1 }} /> : null}
      {phase === "success" && !withGoals.length ? <Typography.Text type="secondary">本期尚未设置任何部门目标。</Typography.Text> : null}
      <Row gutter={[10, 10]} className="compact-kpi-row">
        {withGoals.map((d) => (
          <Col key={d.deptKey}>
            <Statistic
              title={`${roleLabel(d.deptKey)} · ${d.withActual > 0 ? `${d.attained}/${d.withActual} 达成` : "无可评估目标"}`}
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
