"use client";

import type { ReactNode } from "react";
import { Collapse, Space, Typography } from "antd";

/** Presentation only: available evidence stays open; unavailable analysis remains discoverable.
 * Never derive availability from truthiness of a metric (a real zero is evidence).
 * Collapse lazily mounts its body, avoiding hidden charts and empty tables on initial load.
 */
export default function AnalysisSection({ available, title, reason, children }: {
  available: boolean;
  title: string;
  reason?: string | null;
  children: ReactNode;
}) {
  if (available) return <>{children}</>;
  return (
    <Collapse
      size="small"
      className="analysis-section"
      items={[{
        key: "evidence",
        label: <span><strong>{title}</strong><span className="analysis-section-hint">数据未就绪 · 展开查看</span></span>,
        children: (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {reason ? <Typography.Text type="secondary">{reason}</Typography.Text> : null}
            {children}
          </Space>
        ),
      }]}
    />
  );
}
