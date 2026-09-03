"use client";

/**
 * 驾驶舱趋势块挂载点：按屏 id 渲染 /api/report/cockpit/trends 里对应屏的块。
 * 与 cockpit-client.tsx 解耦——主装配四屏不动，这里只追加时间维 / 交叉维图卡。
 */
import { Alert, Button, Skeleton, Space } from "antd";
import type { TrendScreen } from "@/server/modules/report/cockpit-trends";
import { Muted, useTrends } from "./shared";
import { DailyFlowCard } from "./screen-s1";
import { AlertPrecisionCard, ExternalDemandCard, PoTrendCard, QuadrantCard } from "./screen-s2";
import { TurnoverWindowsCard } from "./screen-s3";
import { AlertLifecycleCard, GoalHistoryCard, TodoCompletionStrictCard, TodoThroughputCard } from "./screen-s4";
import { ChannelMatrixCard } from "./screen-channels";

export default function CockpitTrends({ screen }: { screen: TrendScreen }) {
  const { data, error, loading, reload } = useTrends();
  if (error && !data) {
    return <Alert type="warning" showIcon message={`趋势块读取失败：${error}`} action={<Button size="small" onClick={reload}>重试</Button>} />;
  }
  if (!data) return <Skeleton active paragraph={{ rows: 4 }} />;
  const s = data.screens;
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Space wrap size={[12, 4]} style={{ justifyContent: "space-between", width: "100%" }}>
        <Muted>趋势与交叉 · 口径 {data.calibreVersion} · 生成 {data.generatedAt.replace("T", " ").slice(0, 16)}</Muted>
        <Button size="small" type="link" onClick={reload} loading={loading}>刷新趋势</Button>
      </Space>
      {screen === "s1" ? <DailyFlowCard block={s.s1.dailyFlow} /> : null}
      {screen === "s2" ? (<>
        <ExternalDemandCard block={s.s2.externalDemand} />
        <PoTrendCard block={s.s2.poTrend} />
        <QuadrantCard block={s.s2.quadrant} />
        <AlertPrecisionCard block={s.s2.alertPrecision} />
      </>) : null}
      {screen === "s3" ? <TurnoverWindowsCard block={s.s3.turnoverWindows} /> : null}
      {screen === "s4" ? (<>
        <TodoThroughputCard block={s.s4.todoThroughput} />
        <TodoCompletionStrictCard block={s.s4.todoCompletionStrict} />
        <AlertLifecycleCard block={s.s4.alertLifecycle} />
        <GoalHistoryCard block={s.s4.goalHistory} />
      </>) : null}
      {screen === "channels" ? <ChannelMatrixCard block={s.channels.brandMatrix} /> : null}
    </Space>
  );
}
