/**
 * ABC 分层唯一权威（纯函数）——终结分层页与补货页各写一遍、且判定边界不一致的重复。
 *
 * 发现的口径分歧（本次统一前）：
 *  - 分层页：以「加入本项之前」的累计占比判定（prevPct < 80 → A）——标准帕累托口径；
 *  - 补货页：以「含本项」的累计占比判定（share ≤ 0.8 → A）；
 * 边界 SKU 会被两页判成不同类（同一货品两个答案）。现统一取**标准帕累托**（prevPct），
 * 与分层页历史展示一致，避免既有分层看板数字跳动。
 *
 * 规则：按销量降序累计，加入本项前累计占比 <80% 记 A，<95% 记 B，其余 C；零销量恒 C。
 */

export type AbcClass = "A" | "B" | "C";

export interface AbcInput {
  id: number;
  /** 窗口销量（负数按 0 处理） */
  qty: number;
}

/** 逐 SKU 判定 ABC（输入无需预排序）；返回 id → 类别 */
export function classifyAbc(items: AbcInput[]): Map<number, AbcClass> {
  const out = new Map<number, AbcClass>();
  const ranked = items
    .map((i) => ({ id: i.id, qty: Number.isFinite(i.qty) && i.qty > 0 ? i.qty : 0 }))
    .sort((a, b) => b.qty - a.qty);
  const total = ranked.reduce((acc, r) => acc + r.qty, 0);
  let cum = 0;
  for (const r of ranked) {
    if (r.qty <= 0) {
      out.set(r.id, "C"); // 零销量恒 C（不占累计份额语义）
      continue;
    }
    const prevPct = total > 0 ? (cum / total) * 100 : 100;
    cum += r.qty;
    out.set(r.id, prevPct < 80 ? "A" : prevPct < 95 ? "B" : "C");
  }
  return out;
}
