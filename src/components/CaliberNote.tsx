"use client";

/**
 * 统一口径说明（Wave MM 打磨）：一行浅色摘要 + 点击「口径」弹层看全文。
 * 延伸公式收进可键盘/触控操作的帮助层；摘要与影响决策的风险提示保持可见。
 */
import { InfoCircleOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";
import ContextHelp from "@/components/ContextHelp";

export default function CaliberNote({ summary, detail }: { summary: ReactNode; detail?: ReactNode }) {
  return (
    <div className="caliber-note">
      <span className="caliber-note__summary">{summary}</span>
      {detail ? (
        <ContextHelp label="查看口径说明" title="口径说明" content={detail} className="caliber-note__help">
          <InfoCircleOutlined aria-hidden /> 口径
        </ContextHelp>
      ) : null}
    </div>
  );
}
