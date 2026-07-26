"use client";

/**
 * 统一口径说明（Wave MM 打磨）：一行浅色摘要 + 点击「口径」弹层看全文。
 * 终结每页开头 1-3 段 Alert 横幅墙——长口径文案收进 Popover，页面只留一句人话。
 */
import { InfoCircleOutlined } from "@ant-design/icons";
import { Popover } from "antd";
import type { ReactNode } from "react";

export default function CaliberNote({ summary, detail }: { summary: ReactNode; detail?: ReactNode }) {
  return (
    <div className="caliber-note" style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "2px 0 16px", color: "rgba(0,0,0,0.55)", fontSize: 13, lineHeight: 1.6 }}>
      <span>{summary}</span>
      {detail ? (
        <Popover
          content={<div style={{ maxWidth: 440, fontSize: 12, lineHeight: 1.8 }}>{detail}</div>}
          title="口径说明"
          trigger="click"
          placement="bottomLeft"
        >
          <a style={{ fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>
            <InfoCircleOutlined /> 口径
          </a>
        </Popover>
      ) : null}
    </div>
  );
}
