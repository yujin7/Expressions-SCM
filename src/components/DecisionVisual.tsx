"use client";

import { useId, useState } from "react";
import {
  BarChartOutlined,
  DownloadOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  ShareAltOutlined,
  TableOutlined,
} from "@ant-design/icons";
import { Alert, App, Button, Card, Empty, Progress, Skeleton, Space, Tag, Tooltip, Typography } from "antd";
import type { CardProps } from "antd";

import DataSourceBadge, { type LineageTier } from "@/components/DataSourceBadge";
import { metric, metricTooltip } from "@/components/metrics";
import ContextHelp from "@/components/ContextHelp";
import {
  coveragePercent,
  coverageText,
  type VisualCoverage,
  type VisualState,
} from "@/components/decision-visuals";

export interface DecisionVisualSource {
  tier: LineageTier;
  source: string;
  asOf?: string | null;
  note?: string;
}

export interface DecisionVisualProps {
  title: React.ReactNode;
  /** 这张图要帮助回答的业务问题。 */
  question: string;
  metricId?: string;
  grain?: string;
  unit?: string;
  source: DecisionVisualSource;
  coverage?: VisualCoverage;
  activeFilters?: string[];
  caveat?: React.ReactNode;
  summary: string;
  state?: VisualState;
  stateDetail?: React.ReactNode;
  height?: number;
  /** KPI/summary content can use its natural height; charts keep a fixed canvas by default. */
  fitContent?: boolean;
  children: React.ReactNode;
  dataView?: React.ReactNode;
  extra?: React.ReactNode;
  onExport?: () => void;
  exportLabel?: string;
  size?: CardProps["size"];
  /** 主内容本身是语义表格时，不把容器声明为图片。 */
  contentIsTable?: boolean;
}

function StateBody({
  state,
  detail,
  height,
}: {
  state: Exclude<VisualState, "ready">;
  detail?: React.ReactNode;
  height: number;
}) {
  if (state === "loading") {
    return <Skeleton active paragraph={{ rows: Math.max(3, Math.floor(height / 64)) }} />;
  }
  if (state === "error") {
    return (
      <Alert
        showIcon
        type="error"
        message="数据加载失败"
        description={detail ?? "请刷新重试；若持续失败，请查看运维面板。"}
      />
    );
  }
  if (state === "insufficient") {
    return (
      <Alert
        showIcon
        type="warning"
        message="数据不足，暂不下结论"
        description={detail ?? "当前样本或覆盖范围不足以支持可靠判断。"}
      />
    );
  }
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detail ?? "当前筛选范围内暂无数据"} />;
}

/**
 * 全系统唯一的决策图卡：
 * 问题 → 指标口径 → 来源/时点/覆盖 → 图或表 → 限制与下一步。
 */
export default function DecisionVisual({
  title,
  question,
  metricId,
  grain,
  unit,
  source,
  coverage,
  activeFilters = [],
  caveat,
  summary,
  state = "ready",
  stateDetail,
  height = 300,
  fitContent = false,
  children,
  dataView,
  extra,
  onExport,
  exportLabel = "导出当前视图",
  size = "small",
  contentIsTable = false,
}: DecisionVisualProps) {
  const [showTable, setShowTable] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const { message } = App.useApp();
  const summaryId = useId();
  const metricDef = metricId ? metric(metricId) : undefined;
  const coverageLabel = coverageText(coverage);
  const coverageValue = coveragePercent(coverage);
  const isReady = state === "ready";
  const isShowingData = Boolean(showTable && dataView);
  const contentHeight: number | string = fullscreen ? "calc(100vh - 230px)" : height;
  // 记录/表格在全屏也按内容撑开，否则长内容溢出固定画布并与限制说明重叠。
  const useNaturalHeight = fitContent;
  const preserveCanvasHeight = isReady || state === "loading";
  const minimumContentHeight = preserveCanvasHeight
    ? contentHeight
    : Math.min(height, 140);

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      message.success("已复制当前筛选链接");
    } catch {
      message.warning("浏览器未允许复制；可直接复制地址栏链接");
    }
  };

  const header = (
    <div>
      <Space size={6} wrap>
        <Typography.Text strong>{title}</Typography.Text>
        {metricDef ? (
          <ContextHelp label={`${metricDef.label}口径说明`} title={`${metricDef.label} · 口径说明`}
            content={<span style={{ whiteSpace: "pre-line" }}>{metricTooltip(metricDef.id)}</span>} />
        ) : null}
        <DataSourceBadge
          tier={source.tier}
          source={source.source}
          date={source.asOf}
          note={source.note}
        />
      </Space>
      <Typography.Text
        type="secondary"
        style={{ display: "block", marginTop: 2, fontSize: 12, fontWeight: 400 }}
      >
        {question}
      </Typography.Text>
    </div>
  );

  return (
    <Card
      className="decision-visual"
      size={size}
      title={header}
      extra={
        <Space size={4} wrap>
          {extra}
          {dataView ? (
            <Tooltip title={showTable ? "切换为图形" : "显示可访问的数据表"}>
              <Button
                type="text"
                size="small"
                icon={showTable ? <BarChartOutlined /> : <TableOutlined />}
                aria-pressed={showTable}
                aria-label={showTable ? "切换为图形" : "显示数据表"}
                onClick={() => setShowTable((value) => !value)}
              />
            </Tooltip>
          ) : null}
          {onExport ? (
            <Tooltip title={exportLabel}>
              <Button
                type="text"
                size="small"
                icon={<DownloadOutlined />}
                aria-label={exportLabel}
                onClick={onExport}
              />
            </Tooltip>
          ) : null}
          <Tooltip title="复制当前视图链接">
            <Button
              type="text"
              size="small"
              icon={<ShareAltOutlined />}
              aria-label="复制当前视图链接"
              onClick={() => void share()}
            />
          </Tooltip>
          <Tooltip title={fullscreen ? "退出全屏" : "全屏分析"}>
            <Button
              type="text"
              size="small"
              icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              aria-pressed={fullscreen}
              aria-label={fullscreen ? "退出全屏" : "全屏分析"}
              onClick={() => setFullscreen((value) => !value)}
            />
          </Tooltip>
        </Space>
      }
      styles={{ body: { paddingTop: 12 } }}
      style={fullscreen ? {
        position: "fixed",
        inset: 12,
        zIndex: 1100,
        overflow: "auto",
        boxShadow: "0 24px 80px rgba(15, 23, 42, 0.28)",
      } : undefined}
    >
      <Space size={[6, 4]} wrap style={{ marginBottom: 8 }}>
        {grain ? <Tag bordered={false}>粒度：{grain}</Tag> : null}
        {unit ? <Tag bordered={false}>单位：{unit}</Tag> : null}
        {source.asOf ? <Tag bordered={false}>截至：{source.asOf}</Tag> : null}
        {activeFilters.map((filter) => (
          <Tag color="blue" bordered={false} key={filter}>
            {filter}
          </Tag>
        ))}
      </Space>

      {coverageLabel ? (
        <Tooltip title={`覆盖：${coverageLabel}`}>
          <div
            role="group"
            aria-label={`数据覆盖 ${coverageLabel}`}
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 8 }}
          >
            <Typography.Text type="secondary" style={{ fontSize: 12, overflowWrap: "anywhere", minWidth: 0 }}>
              覆盖 {coverageLabel}
            </Typography.Text>
            {coverageValue != null ? (
              <Progress
                aria-label={`数据覆盖 ${coverageLabel}`}
                percent={coverageValue}
                showInfo={false}
                size="small"
                status={coverageValue < 80 ? "exception" : "normal"}
                style={{ maxWidth: 120, margin: 0 }}
              />
            ) : null}
          </div>
        </Tooltip>
      ) : null}

      <Typography.Paragraph
        id={summaryId}
        type="secondary"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {summary}
      </Typography.Paragraph>

      <div
        role={isShowingData || contentIsTable ? undefined : "img"}
        aria-describedby={summaryId}
        aria-label={isShowingData || contentIsTable ? undefined : `${typeof title === "string" ? title : "决策图表"}。${summary}`}
        style={{
          minHeight: useNaturalHeight ? undefined : minimumContentHeight,
          height: useNaturalHeight || !isReady || isShowingData ? undefined : contentHeight,
        }}
      >
        {isShowingData ? dataView : isReady ? children : (
          <StateBody state={state} detail={stateDetail} height={height} />
        )}
      </div>

      {caveat ? (
        <Typography.Text
          type="secondary"
          style={{ display: "block", marginTop: 8, fontSize: 12, lineHeight: 1.5 }}
        >
          限制：{caveat}
        </Typography.Text>
      ) : null}
    </Card>
  );
}
