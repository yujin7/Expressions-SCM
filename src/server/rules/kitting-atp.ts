/**
 * E2-09 齐套 ATP-lite。
 *
 * 问题：现有齐套判定（rules/kitting.ts producibleQty）只看**当前**库存，
 * 于是答案永远是"现在不齐套"，而不是运营真正想知道的"**几号能齐套**"。
 *
 * 本模块逐日推演各物料的可用量：某物料的 readyDate = 其累计可用量首次 ≥ 需求量的日期；
 * 整单可齐套日 = **各物料 readyDate 的最大值**（木桶效应——最慢的那个决定）。
 *
 * 口径与取舍：
 * - 只接受**有确认到货日**的到货（无日期的供给无法安放在时间轴上，调用方应先过滤掉，
 *   并在 UI 提示"另有 N 条无到货日的在途"——与到货日历同一诚实原则）。
 * - 今天即满足的物料 readyDate = today（不是 null）。
 * - 视野内始终不足的物料进 blockers，给出 `shortBy`（视野末仍缺多少）——**不静默当作能齐套**。
 * - 空 needs → kitDate = today（无物料约束即无阻碍），note 说明这一点，避免被误读为"已验证齐套"。
 *
 * 数量口径：走 decimal 字符串（CLAUDE.md 硬规则）。浮点比较会让"刚好够"变成"差一点"，
 * 直接影响推演出的日期。
 */
import { dAdd, dCmp, dQty, dSub } from "@/server/core/decimal";

export interface MaterialNeed {
  materialSkuId: number;
  /** 该物料的需求量（毛需求，decimal 字符串） */
  required: string;
  /** 当前在库（decimal 字符串） */
  onHand: string;
  /** 有确认到货日的到货（date: YYYY-MM-DD） */
  arrivals: { date: string; qty: string }[];
}

export interface KitBlocker {
  materialSkuId: number;
  /** 视野末仍缺的量 */
  shortBy: string;
  /** 该物料自身可齐日；视野内不可得 = null */
  readyDate: string | null;
}

export interface KitAtpResult {
  /** 整单最早可齐套日；视野内无法齐套 = null */
  kitDate: string | null;
  /** 距今天数 */
  daysToKit: number | null;
  blockers: KitBlocker[];
  /** 各物料自身可齐日（供 UI 展示木桶短板） */
  perMaterial: { materialSkuId: number; readyDate: string | null; shortBy: string }[];
  note: string;
}

const DAY_MS = 86_400_000;
const DEC_RE = /^-?\d+(\.\d+)?$/;
const dec = (v: unknown, fallback = "0"): string =>
  typeof v === "string" && DEC_RE.test(v.trim()) ? v.trim() : fallback;

const addDays = (ymd: string, d: number): string =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + d * DAY_MS).toISOString().slice(0, 10);
const diffDays = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * 推演最早可齐套日。
 * @param needs 各物料需求与供给
 * @param today 基准日 YYYY-MM-DD
 * @param horizonDays 推演视野（默认 90 天）
 */
export function earliestKitDate(needs: MaterialNeed[], today: string, horizonDays = 90): KitAtpResult {
  const horizon = Math.max(1, Math.min(365, Math.floor(horizonDays)));
  const list = needs ?? [];

  if (list.length === 0) {
    return {
      kitDate: today,
      daysToKit: 0,
      blockers: [],
      perMaterial: [],
      note: "该工单无物料需求行，无齐套约束（非「已验证齐套」）",
    };
  }

  const perMaterial: KitAtpResult["perMaterial"] = [];
  const blockers: KitBlocker[] = [];

  for (const n of list) {
    const required = dec(n.required);
    let available = dec(n.onHand);

    // 今天即满足
    if (dCmp(available, required) >= 0) {
      perMaterial.push({ materialSkuId: n.materialSkuId, readyDate: today, shortBy: dQty("0") });
      continue;
    }

    // 到货按日归并（早于今天的并入今天——已在途即将入仓）
    const byDay = new Map<string, string>();
    for (const a of n.arrivals ?? []) {
      const qty = dec(a?.qty);
      if (!a?.date || dCmp(qty, "0") <= 0) continue;
      const off = Math.max(0, diffDays(today, a.date));
      if (off >= horizon) continue; // 视野外不参与
      const day = addDays(today, off);
      byDay.set(day, dAdd(byDay.get(day) ?? "0", qty, 6));
    }

    let ready: string | null = null;
    for (let i = 0; i < horizon; i++) {
      const date = addDays(today, i);
      const inc = byDay.get(date);
      if (inc) available = dAdd(available, inc, 6);
      if (dCmp(available, required) >= 0) {
        ready = date;
        break;
      }
    }

    const gap = dSub(required, available, 6);
    const shortBy = dQty(ready || dCmp(gap, "0") <= 0 ? "0" : gap);
    perMaterial.push({ materialSkuId: n.materialSkuId, readyDate: ready, shortBy });
    if (!ready) blockers.push({ materialSkuId: n.materialSkuId, shortBy, readyDate: null });
  }

  if (blockers.length > 0) {
    return {
      kitDate: null,
      daysToKit: null,
      blockers,
      perMaterial,
      note: `${horizon} 天视野内无法齐套：${blockers.length} 个物料即使算上在途仍有缺口`,
    };
  }

  // 木桶效应：取最晚的那个物料可齐日
  const dates = perMaterial.map((p) => p.readyDate!).filter(Boolean);
  const kitDate = dates.reduce((max, d) => (d > max ? d : max), dates[0]);
  const daysToKit = diffDays(today, kitDate);

  return {
    kitDate,
    daysToKit,
    blockers: [],
    perMaterial,
    note:
      daysToKit === 0
        ? "当前即可齐套"
        : `预计 ${kitDate} 齐套（${daysToKit} 天后），由最晚到料的物料决定`,
  };
}
