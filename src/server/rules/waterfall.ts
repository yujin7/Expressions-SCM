/**
 * 瀑布图（bridge）分解纯规则：把「两期分组数值」的差额拆成可视化条目。
 *
 * 口径纪律（月度会议第一张图的正确性底线）：
 * - 出现在任一期的键都参与：新增（prev 无）计正、消失（curr 无）计负，不得漏项；
 * - 按 |delta| 降序取 topN 作明细，其余合并入「其他」（othersDelta）；
 * - **首尾恒等式**：Σitems.delta + othersDelta === to − from（total）。瀑布图最易错处即首尾对不上，
 *   本模块以 4 位小数（= sales_monthly.qty 的 decimal(14,4) 精度）收敛，消除浮点尾差。
 * - delta 为 0 的键不占瀑布条目（不影响恒等式）。
 *
 * 纯函数、无 IO；由 modules/report/sales-bridge.ts 喂数。
 */

/** 单个瀑布条目：key=可回跳的业务键（品牌/渠道/SKU 编码），label=中文展示名 */
export interface BridgeItem {
  key: string;
  label: string;
  delta: number;
}

export interface BridgeResult {
  /** 起始期合计 */
  from: number;
  /** 结束期合计 */
  to: number;
  /** 总变化 = to − from */
  total: number;
  /** 明细条目（按 |delta| 降序，最多 topN 条） */
  items: BridgeItem[];
  /** 未进 topN 的其余项合计变化 */
  othersDelta: number;
}

/** 收敛到 qty 精度（decimal(14,4)），消除 0.1+0.2 类浮点尾差 */
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

const sum = (m: Map<string, number>): number => {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
};

/**
 * 把两期的分组数值差分解为瀑布条目：按 |delta| 降序取 topN，其余合并为「其他」。
 *
 * @param prev 起始期 键→数值
 * @param curr 结束期 键→数值
 * @param labelOf 键→中文展示名
 * @param topN 明细条目上限（默认 8；其余进 othersDelta）
 */
export function buildBridge(
  prev: Map<string, number>,
  curr: Map<string, number>,
  labelOf: (k: string) => string,
  topN = 8,
): BridgeResult {
  const from = r4(sum(prev));
  const to = r4(sum(curr));
  const total = r4(to - from);

  /* ── 并集：新增（prev 无）与消失（curr 无）都必须参与 ── */
  const keys = new Set<string>();
  for (const k of prev.keys()) keys.add(k);
  for (const k of curr.keys()) keys.add(k);

  const all: BridgeItem[] = [];
  for (const k of keys) {
    const delta = r4((curr.get(k) ?? 0) - (prev.get(k) ?? 0));
    if (delta === 0) continue; // 无变化不占条目
    all.push({ key: k, label: labelOf(k), delta });
  }
  // |delta| 降序；同幅度按 key 升序，保证结果稳定可比
  all.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const n = Math.max(0, Math.floor(topN));
  const items = all.slice(0, n);
  let others = 0;
  for (const it of all.slice(n)) others += it.delta;

  return { from, to, total, items, othersDelta: r4(others) };
}
