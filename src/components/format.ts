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
