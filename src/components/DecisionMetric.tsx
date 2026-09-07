"use client";

import Link from "next/link";
import { ArrowRightOutlined } from "@ant-design/icons";
import { Card, Statistic, Typography } from "antd";

import DataSourceBadge, { type LineageTier } from "@/components/DataSourceBadge";
import { metric, metricTooltip } from "@/components/metrics";
import ContextHelp from "@/components/ContextHelp";

export default function DecisionMetric({
  metricId,
  value,
  suffix,
  prefix,
  source,
  asOf,
  status = "neutral",
  actionHref,
  actionLabel,
  detail,
}: {
  metricId: string;
  value: number | string;
  suffix?: React.ReactNode;
  prefix?: React.ReactNode;
  source: { tier: LineageTier; name: string };
  asOf?: string | null;
  status?: "neutral" | "positive" | "warning" | "critical";
  actionHref?: string;
  actionLabel?: string;
  detail?: React.ReactNode;
}) {
  const definition = metric(metricId);
  if (!definition) return null;
  const color = {
    neutral: undefined,
    positive: "#16803c",
    warning: "#b45309",
    critical: "#c2413b",
  }[status];
  return (
    <Card size="small" className={`decision-metric decision-metric--${status}`}>
      <div className="decision-metric__header">
        <Typography.Text className="decision-metric__title">{definition.label}</Typography.Text>
        <span className="decision-metric__meta">
          <ContextHelp
            label={`${definition.label}口径说明`} title={`${definition.label} · 口径说明`}
            content={
              <div className="decision-metric__tooltip">
                <div style={{ whiteSpace: "pre-line" }}>{metricTooltip(metricId)}</div>
                {detail ? <div className="decision-metric__tooltip-detail">{detail}</div> : null}
              </div>
            }
          />
          <DataSourceBadge tier={source.tier} source={source.name} date={asOf} />
        </span>
      </div>
      <Statistic
        className="decision-metric__statistic"
        value={value}
        suffix={suffix}
        prefix={prefix}
        valueStyle={{ color }}
      />
      <Typography.Paragraph className="decision-metric__description">
        {definition.short}
      </Typography.Paragraph>
      {actionHref && actionLabel ? (
        <div className="decision-metric__action">
          <Link href={actionHref}>
            {actionLabel} <ArrowRightOutlined />
          </Link>
        </div>
      ) : null}
    </Card>
  );
}
