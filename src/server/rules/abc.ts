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

/* ────────────────────────────────────────────────────────────────────────────
 * D58 四级分层 S/A/B/C（参数化切点，唯一权威）。既有 classifyAbc 三级签名与口径不变。
 *
 * 口径：按 value 降序累计，**加入本项前**累计占比（标准帕累托，与 classifyAbc 同法）
 *   prevPct < sPct → S；< aPct → A；< bPct → B；其余 C；零/负值恒 C。
 * 缺省切点 50/80/95（sys_params grade_s_pct / grade_a_pct / grade_b_pct）。
 * 不变量：tierToAbc(classifyTier(x, {sPct:任意, aPct:80, bPct:95})) === classifyAbc(x)。
 * value 由调用方指定（销量件数或金额均可），本函数只做排名与累计，不做金额运算。
 * ──────────────────────────────────────────────────────────────────────────── */

export type Tier = "S" | "A" | "B" | "C";

export interface TierCuts {
  /** S 级累计占比上界（%） */
  sPct: number;
  /** A 级累计占比上界（%） */
  aPct: number;
  /** B 级累计占比上界（%） */
  bPct: number;
}

export const DEFAULT_TIER_CUTS: Readonly<TierCuts> = Object.freeze({ sPct: 50, aPct: 80, bPct: 95 });

export interface TierInput {
  id: number | string;
  /** 分层依据值（数量或金额；非有限数/负数按 0 处理，恒 C） */
  value: number;
}

function assertCuts(cuts: TierCuts): void {
  const { sPct, aPct, bPct } = cuts;
  const ok = [sPct, aPct, bPct].every((v) => Number.isFinite(v)) && sPct > 0 && sPct < aPct && aPct < bPct && bPct <= 100;
  if (!ok) throw new Error(`invalid tier cuts: 0 < S(${sPct}) < A(${aPct}) < B(${bPct}) <= 100 required`);
}

/** 逐项判定 S/A/B/C（输入无需预排序）；返回 id → tier */
export function classifyTier(items: TierInput[], cuts: TierCuts = DEFAULT_TIER_CUTS): Map<number | string, Tier> {
  assertCuts(cuts);
  const out = new Map<number | string, Tier>();
  const ranked = items
    .map((i) => ({ id: i.id, value: Number.isFinite(i.value) && i.value > 0 ? i.value : 0 }))
    .sort((a, b) => b.value - a.value);
  const total = ranked.reduce((acc, r) => acc + r.value, 0);
  let cum = 0;
  for (const r of ranked) {
    if (r.value <= 0) {
      out.set(r.id, "C");
      continue;
    }
    const prevPct = total > 0 ? (cum / total) * 100 : 100;
    cum += r.value;
    out.set(r.id, prevPct < cuts.sPct ? "S" : prevPct < cuts.aPct ? "A" : prevPct < cuts.bPct ? "B" : "C");
  }
  return out;
}

/** 四级折回三级：S→A，其余原样（补货页等既有三级消费者用） */
export function tierToAbc(tier: Tier): AbcClass {
  return tier === "S" ? "A" : tier;
}

export interface TierBucket {
  count: number;
  /** 该级 value 合计 */
  value: number;
  /** 该级 value 占总量百分比（1dp；总量 0 → 0） */
  valueSharePct: number;
}

/** 四级分布（供分层页导出 S/A/B/C 的 SKU 数与占比，校准 S 边界用） */
export function tierDistribution(items: TierInput[], cuts: TierCuts = DEFAULT_TIER_CUTS): Record<Tier, TierBucket> {
  const tiers = classifyTier(items, cuts);
  const out: Record<Tier, TierBucket> = {
    S: { count: 0, value: 0, valueSharePct: 0 },
    A: { count: 0, value: 0, valueSharePct: 0 },
    B: { count: 0, value: 0, valueSharePct: 0 },
    C: { count: 0, value: 0, valueSharePct: 0 },
  };
  let total = 0;
  for (const i of items) {
    const t = tiers.get(i.id) ?? "C";
    const v = Number.isFinite(i.value) && i.value > 0 ? i.value : 0;
    out[t].count += 1;
    out[t].value += v;
    total += v;
  }
  for (const t of ["S", "A", "B", "C"] as const) {
    out[t].valueSharePct = total > 0 ? Math.round((out[t].value / total) * 1000) / 10 : 0;
  }
  return out;
}
