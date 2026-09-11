"use client";

/**
 * 驾驶舱趋势块挂载点：按屏 id 渲染 /api/report/cockpit/trends 里对应屏的块。
 * 与 cockpit-client.tsx 解耦——主装配四屏不动，这里只追加时间维 / 交叉维图卡。
 */
import { Button, Skeleton, Space } from "antd";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { formatAsOf } from "@/components/format";
import type { TrendScreen } from "@/server/modules/report/cockpit-trends";
import { Muted, useTrends } from "./shared";
import { DailyFlowCard, DataFreshnessTrendCard } from "./screen-s1";
import { AlertPrecisionCard, ExternalDemandCard, PoTrendCard, QuadrantCard, SupplierConcentrationCard } from "./screen-s2";
import { ExpiryBucketsCard, TurnoverWindowsCard } from "./screen-s3";
import { AlertLifecycleCard, DataQualityTrendCard, GoalHistoryCard, TierMigrationCard, TodoCompletionStrictCard, TodoThroughputCard } from "./screen-s4";
import { ChannelMatrixCard } from "./screen-channels";

export default function CockpitTrends({ screen }: { screen: TrendScreen }) {
  const { data, error, loading, reload } = useTrends();
  if (error) {
    return <LoadErrorAlert error={error} onRetry={reload} subject="驾驶舱趋势" retrying={loading} />;
  }
  if (!data) return <div role="status" aria-label="正在加载驾驶舱趋势"><Skeleton active paragraph={{ rows: 3 }} /></div>;
  const s = data.screens;
  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Space wrap size={[12, 4]} style={{ justifyContent: "space-between", width: "100%" }}>
        <Muted>趋势与交叉 · 口径 {data.calibreVersion} · 生成 {formatAsOf(data.generatedAt)}（北京时间）</Muted>
        <Button size="small" type="link" aria-label="刷新趋势" aria-busy={loading} onClick={reload} loading={loading}>刷新趋势</Button>
      </Space>
      {screen === "s1" ? (<>
        <DailyFlowCard block={s.s1.dailyFlow} />
        <DataFreshnessTrendCard block={s.s1.freshnessTrend} />
      </>) : null}
      {screen === "s2" ? (<>
        <ExternalDemandCard block={s.s2.externalDemand} />
        <PoTrendCard block={s.s2.poTrend} />
        <SupplierConcentrationCard block={s.s2.supplierConcentration} />
        <QuadrantCard block={s.s2.quadrant} />
        <AlertPrecisionCard block={s.s2.alertPrecision} />
      </>) : null}
      {screen === "s3" ? (<>
        <TurnoverWindowsCard block={s.s3.turnoverWindows} />
        <ExpiryBucketsCard block={s.s3.expiryBuckets} />
      </>) : null}
      {screen === "s4" ? (<>
        <TodoThroughputCard block={s.s4.todoThroughput} />
        <TodoCompletionStrictCard block={s.s4.todoCompletionStrict} />
        <AlertLifecycleCard block={s.s4.alertLifecycle} />
        <GoalHistoryCard block={s.s4.goalHistory} />
        <TierMigrationCard block={s.s4.tierMigration} />
        <DataQualityTrendCard block={s.s4.dataQualityTrend} />
      </>) : null}
      {screen === "channels" ? <ChannelMatrixCard block={s.channels.brandMatrix} /> : null}
    </Space>
  );
}
