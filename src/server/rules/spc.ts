/**
 * E7-09 统计异常带（SPC 控制图，纯函数）。
 *
 * 问题：现有告警用**固定阈值**（低于 X 天库存 = 紧急）。固定阈值不认识"这条 SKU 本来就这么波动"，
 * 于是快消品天天报警、慢销品从不报警——我们实测过一次：128 条紧急告警里 106 条是误报。
 *
 * 本模块改用**统计过程控制**：以序列自身的历史波动定义"正常范围"，只有**统计上确实异常**才出信号。
 * 采用 Western Electric 规则集（工业界 SPC 标准），四条规则严重度递减：
 *   R1 单点越出 ±3σ            → high   （突变：断货、错单、盘点差错）
 *   R2 连续 3 点中 2 点越 ±2σ  → medium （正在恶化）
 *   R3 连续 5 点中 4 点越 ±1σ  → medium （持续偏移）
 *   R4 连续 8 点同侧            → low    （均值漂移：季节转换、渠道结构变化）
 *
 * 关键取舍：
 * - **默认用稳健统计（中位数 + MAD）**而非均值+标准差。原因：异常点自己会把 σ 撑大，
 *   用均值/σ 时一个大异常反而把自己藏进带内（掩蔽效应）。MAD 对离群点免疫。
 * - **σ=0 时不出任何信号**。序列恒定（例如常年零销量）时任何微小变动都会是"无穷倍 σ"，
 *   那不是异常，是没有信息。宁可漏报也不制造噪音——这正是我们要解决的问题。
 * - **样本不足（默认 <8 点）时明确返回"样本不足"而不是硬算**。8 点以下的 σ 估计不可信，
 *   算出来的带只会伪装成有统计依据。
 * - 一个点只报**最严重**的那条规则，不重复刷屏。
 *
 * 本文件不依赖任何项目模块，可独立测试。
 */

export interface SeriesPoint {
  date: string;
  value: number;
}

export type SpcSeverity = "high" | "medium" | "low";

export interface SpcSignal {
  index: number;
  date: string;
  value: number;
  /** 命中的规则编号 */
  rule: "R1" | "R2" | "R3" | "R4";
  severity: SpcSeverity;
  /** 偏离中心多少个 σ（带正负号；R4 无单点偏离时为该点实际值） */
  sigmas: number;
  note: string;
}

export interface SpcBands {
  /** 中心线（稳健模式下为中位数） */
  center: number;
  /** σ 估计（稳健模式下为 MAD × 1.4826） */
  sigma: number;
  /** ±1σ / ±2σ / ±3σ */
  upper1: number; lower1: number;
  upper2: number; lower2: number;
  upper3: number; lower3: number;
}

export interface SpcResult {
  bands: SpcBands | null;
  signals: SpcSignal[];
  /** 可用样本数 */
  samples: number;
  /** 为什么没有带/没有信号——UI 必须把这句话显示出来，不能只画一条空线 */
  note: string;
}

export interface SpcOptions {
  /** 稳健模式（中位数+MAD），默认 true */
  robust?: boolean;
  /** 最少样本数，默认 8 */
  minSamples?: number;
  /** 只用最近 N 点作为基线（0=全序列），默认 0 */
  baselineWindow?: number;
}

/** MAD 到 σ 的一致性系数（正态分布下 MAD×1.4826 ≈ σ） */
const MAD_TO_SIGMA = 1.4826;

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 计算中心线与 σ。稳健模式用中位数/MAD，否则用均值/样本标准差。 */
export function computeBands(values: number[], opts: SpcOptions = {}): SpcBands | null {
  const robust = opts.robust ?? true;
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;

  let center: number;
  let sigma: number;

  if (robust) {
    const sorted = [...vals].sort((a, b) => a - b);
    center = median(sorted);
    const devs = vals.map((v) => Math.abs(v - center)).sort((a, b) => a - b);
    sigma = median(devs) * MAD_TO_SIGMA;
  } else {
    center = vals.reduce((s, v) => s + v, 0) / vals.length;
    const varSum = vals.reduce((s, v) => s + (v - center) ** 2, 0);
    sigma = Math.sqrt(varSum / (vals.length - 1)); // 样本标准差（n-1）
  }

  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    center: r(center),
    sigma: r(sigma),
    upper1: r(center + sigma), lower1: r(center - sigma),
    upper2: r(center + 2 * sigma), lower2: r(center - 2 * sigma),
    upper3: r(center + 3 * sigma), lower3: r(center - 3 * sigma),
  };
}

const SEVERITY_RANK: Record<SpcSeverity, number> = { high: 3, medium: 2, low: 1 };

/**
 * 侦测统计异常信号。
 * @param points 时间序列（调用方应已按日期升序排列）
 */
export function detectSignals(points: SeriesPoint[], opts: SpcOptions = {}): SpcResult {
  const minSamples = opts.minSamples ?? 8;
  const baselineWindow = opts.baselineWindow ?? 0;

  const pts = (points ?? []).filter((p) => p && Number.isFinite(p.value));
  if (pts.length < minSamples) {
    return {
      bands: null,
      signals: [],
      samples: pts.length,
      note: `样本不足（${pts.length}/${minSamples} 点），不做统计判定——此时算出的控制带没有统计依据`,
    };
  }

  const baseline = baselineWindow > 0 ? pts.slice(-baselineWindow) : pts;
  const bands = computeBands(baseline.map((p) => p.value), opts);
  if (!bands) {
    return { bands: null, signals: [], samples: pts.length, note: "无法估计控制带" };
  }

  if (!(bands.sigma > 0)) {
    return {
      bands,
      signals: [],
      samples: pts.length,
      note: "序列波动为零（σ=0），不产生信号——恒定序列的任何变动都会被误判为无穷倍偏离",
    };
  }

  const z = pts.map((p) => (p.value - bands.center) / bands.sigma);
  const sideOf = (i: number) => (z[i] > 0 ? 1 : z[i] < 0 ? -1 : 0);
  const best = new Map<number, SpcSignal>();

  const record = (i: number, rule: SpcSignal["rule"], severity: SpcSeverity, note: string) => {
    const cur = best.get(i);
    const next: SpcSignal = {
      index: i,
      date: pts[i].date,
      value: pts[i].value,
      rule,
      severity,
      sigmas: Math.round(z[i] * 100) / 100,
      note,
    };
    if (!cur || SEVERITY_RANK[severity] > SEVERITY_RANK[cur.severity]) best.set(i, next);
  };

  for (let i = 0; i < pts.length; i++) {
    // R1：单点越 3σ
    if (Math.abs(z[i]) >= 3) {
      record(i, "R1", "high", `单点越出 ±3σ（${z[i] > 0 ? "偏高" : "偏低"} ${Math.abs(z[i]).toFixed(1)}σ）`);
      continue; // 已是最高级，本点无需再查
    }
    // R2：连续 3 点中 2 点同侧越 2σ
    if (i >= 2) {
      const w = [i - 2, i - 1, i];
      for (const side of [1, -1]) {
        const hits = w.filter((k) => sideOf(k) === side && Math.abs(z[k]) >= 2).length;
        if (hits >= 2) {
          record(i, "R2", "medium", `连续 3 点中 ${hits} 点越出 ${side > 0 ? "+" : "−"}2σ，正在恶化`);
          break;
        }
      }
    }
    // R3：连续 5 点中 4 点同侧越 1σ
    if (i >= 4) {
      const w = [i - 4, i - 3, i - 2, i - 1, i];
      for (const side of [1, -1]) {
        const hits = w.filter((k) => sideOf(k) === side && Math.abs(z[k]) >= 1).length;
        if (hits >= 4) {
          record(i, "R3", "medium", `连续 5 点中 ${hits} 点越出 ${side > 0 ? "+" : "−"}1σ，持续偏移`);
          break;
        }
      }
    }
    // R4：连续 8 点同侧
    if (i >= 7) {
      const w = Array.from({ length: 8 }, (_, k) => i - 7 + k);
      for (const side of [1, -1]) {
        if (w.every((k) => sideOf(k) === side)) {
          record(i, "R4", "low", `连续 8 点位于中心线${side > 0 ? "上" : "下"}方，均值可能已漂移`);
          break;
        }
      }
    }
  }

  const signals = [...best.values()].sort((a, b) => a.index - b.index);
  return {
    bands,
    signals,
    samples: pts.length,
    note: signals.length
      ? `${pts.length} 点中侦测到 ${signals.length} 个统计异常信号`
      : `${pts.length} 点全部落在控制带内，无统计异常`,
  };
}
