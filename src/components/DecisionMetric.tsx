"use client";

import Link from "next/link";
import { ArrowRightOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { Card, Statistic, Tag, Tooltip, Typography } from "antd";

import DataSourceBadge, { type LineageTier } from "@/components/DataSourceBadge";
import { metric, metricTooltip } from "@/components/metrics";

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
}) {
  const definition = metric(metricId);
  if (!definition) return null;
  const color = {
    neutral: undefined,
    positive: "#16803c",
    warning: "#b45309",
    critical: "#c2413b",
  }[status];
  const body = (
    <Card size="small" className="decision-metric" styles={{ body: { height: "100%" } }}>
      <Statistic
        title={
          <>
            {definition.label}
            <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{metricTooltip(metricId)}</span>}>
              <InfoCircleOutlined
                aria-label={`${definition.label}口径说明`}
                style={{ marginLeft: 5, color: "#64748b" }}
              />
            </Tooltip>
            <DataSourceBadge tier={source.tier} source={source.name} date={asOf} />
          </>
        }
        value={value}
        suffix={suffix}
        prefix={prefix}
        valueStyle={{ color }}
      />
      {actionHref && actionLabel ? (
        <Typography.Text style={{ display: "block", marginTop: 8, fontSize: 12 }}>
          <Link href={actionHref}>
            {actionLabel} <ArrowRightOutlined />
          </Link>
        </Typography.Text>
      ) : (
        <Tag bordered={false} style={{ marginTop: 8 }}>
          {definition.short}
        </Tag>
      )}
    </Card>
  );
  return body;
}

