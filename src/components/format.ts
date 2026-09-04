/** 数量显示（UX 走查：200.0000 对"个"类单位是噪音）——去尾零，保留真实小数 */
export function formatQty(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return s;
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** 生命周期标签 */
export const LIFECYCLE_LABELS: Record<string, string> = {
  on_sale: "在售",
  trial: "试销",
  halted: "停售",
  retired: "淘汰",
};

/* ────────────────────────── 驾驶舱 / 报表共享显示格式（展示层，非记账路径） ────────────────────────── */

/** 金额显示：≥1 万折「万」保留 1 位；否则千分位无小数。null/非数 → "—" */
export function formatYuan(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10_000) return `¥${(n / 10_000).toFixed(1)}万`;
  return `¥${n.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}

/** 计数/件数显示：千分位无小数。null/非数 → "—" */
export function formatCount(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) : "—";
}

/**
 * 已是百分数的值 → "12.3%"；null/空 → "—"。
 *
 * **入参必须已经是百分数**：0–1 的比例换算成百分数只能在**服务端**做
 * （`report/cockpit.ts` 的 `otifRatePctOf` / `ratePctNumOf`，decimal 字符串运算不走 float），
 * 客户端不再有第二套换算——驾驶舱 OTIF 曾把 0.83 直接拼 "%" 显示成 0.83%（审计 #1），
 * 而那次修复正是在服务端做的；此处曾另留一对 `ratioToPct`/`pctFromRatio` 自称唯一权威却零调用，
 * 于是仓库同时有三套换算、自称权威的那套是死的（2026-09-04 清理审计 #2）。
 *
 * `digits` 缺省 = 原样拼后缀（服务端已定好小数位）；给了则按固定小数位补齐
 * （趋势层图表统一 1 位：`ratePctNumOf` 折回 number 后 "83.0" 会变成 83）。
 */
export function formatPct(v: string | number | null | undefined, digits?: number): string {
  if (v == null || v === "") return "—";
  if (digits == null) return `${v}%`;
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : "—";
}
