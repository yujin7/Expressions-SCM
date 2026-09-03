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

/** 已是百分数的值（12.3 → "12.3%"）；null → "—" */
export function formatPct(v: string | number | null | undefined, suffix = "%"): string {
  if (v == null || v === "") return "—";
  return `${v}${suffix}`;
}

/**
 * 0–1 比例折成百分数字符串（0.8333 → "83.3"）。
 * 驾驶舱 OTIF 曾把 0.83 直接拼 "%" 显示成 0.83%（审计 #1）——所有比例→百分数只能走这里。
 */
export function ratioToPct(v: string | number | null | undefined, digits = 1): string | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return (n * 100).toFixed(digits);
}

/** ratio → "83.3%"；null → "—" */
export function pctFromRatio(v: string | number | null | undefined, digits = 1): string {
  const p = ratioToPct(v, digits);
  return p == null ? "—" : `${p}%`;
}
