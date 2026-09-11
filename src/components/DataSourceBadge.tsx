"use client";

/**
 * #5 字段级数据血缘徽标：点按或键盘打开来源与可信层级，不依赖 hover。
 * 层级（tier）语义与全系统口径纪律一致：
 * - ledger（记账层）：过账台账/实时账，权威可信；
 * - snapshot（快照层）：期初/快照导入，时点权威；
 * - reference（参考层）：transit_refs 等文件登记，只提示不入账；
 * - derived（推导层）：由上述计算得出（可销天数、投影等）。
 * 用法：<DataSourceBadge tier="reference" source="总库存明细" date="2026-07-21" note="全公司口径" />
 */
import ContextHelp from "@/components/ContextHelp";

export type LineageTier = "ledger" | "snapshot" | "reference" | "derived";

const TIER_META: Record<LineageTier, { label: string; color: string; glyph: string }> = {
  ledger: { label: "记账层（权威）", color: "#52c41a", glyph: "账" },
  snapshot: { label: "快照层（时点权威）", color: "#1677ff", glyph: "照" },
  reference: { label: "参考层（只提示不入账）", color: "#fa8c16", glyph: "参" },
  derived: { label: "推导层（计算得出）", color: "#8c8c8c", glyph: "算" },
};

export default function DataSourceBadge({
  tier,
  source,
  date,
  note,
}: {
  tier: LineageTier;
  source?: string;
  date?: string | null;
  note?: string;
}) {
  const m = TIER_META[tier];
  const lines = [
    `口径：${m.label}`,
    `来源：${source || "未提供"}`,
    `数据时点：${date || "未提供，请核对新鲜度"}`,
    note ?? null,
  ].filter(Boolean);
  return (
    <ContextHelp label={`查看数据来源：${source || m.label}`} title="数据来源与时点"
      content={<span style={{ whiteSpace: "pre-line" }}>{lines.join("\n")}</span>}>
      <span className="data-source-glyph" style={{ background: m.color }} aria-hidden>{m.glyph}</span>
    </ContextHelp>
  );
}
