/**
 * R11 净需求建议（《01》§5）：
 *   建议量 = 毛需求 − 可用库存 − 在途；≤0 则为 0
 *   再按 MOQ 起订量取下限、按订货倍数向上取整；三数并示由采购确认。
 * 数量 scale=4；纯函数，全部经 decimal.ts。
 *
 * 规整留痕（后加）：`suggestQtyDetailed` 在同一套算法上额外输出**每一步调整的 from→to**、
 * 超买折算天数与冲突警告。`suggestQty` 是它的薄封装——**只有一套规整规则**，
 * 避免两处实现分叉后没人知道哪套在生效。
 */
import { dSub, dCmp, dMax, dCeilToMultiple, dQty, dDiv } from "@/server/core/decimal";

export interface SuggestQtyInput {
  /** 毛需求 */
  grossReq: string;
  /** 可用库存 */
  onHand: string;
  /** 在途量（PO 实物行未收量） */
  inTransit: string;
  /** 最小起订量（可空） */
  moq?: string | null;
  /** 订货倍数（可空） */
  orderMultiple?: string | null;
}

export interface LotSizingInput extends SuggestQtyInput {
  /** 单次订货上限（产能或资金约束，可空） */
  maxOrder?: string | null;
  /** 日均需求——用于把超买折算成天数（可空） */
  dailyDemand?: string | null;
  /** 超买超过多少天就提示，默认 90 */
  overshootWarnDays?: number;
}

export type LotAdjustmentType = "moq" | "multiple" | "max_order" | "none";

export interface LotAdjustment {
  type: LotAdjustmentType;
  from: string;
  to: string;
  note: string;
}

export interface LotSizingDetail {
  /** 规整后的可下单量（qty scale=4） */
  qty: string;
  /** 规整前的净需求 */
  rawNet: string;
  /** 逐步调整留痕（按发生顺序）——追溯"37 为什么变成了 504" */
  adjustments: LotAdjustment[];
  /** 比净需求多买的量 */
  overshoot: string;
  /** 超买折算成多少天库存；未提供日均则为 null */
  overshootDays: string | null;
  /** `blocking` 项**不可自动放行**，须人工裁决 */
  warnings: { level: "info" | "warn" | "blocking"; message: string }[];
}

const DEC_RE = /^-?\d+(\.\d+)?$/;
/** 仅当是合法且 > 0 的 decimal 字符串时才当作硬约束——0/负/脏值一律按「未设置」 */
function posDec(v: unknown): string | null {
  if (typeof v !== "string" || !DEC_RE.test(v.trim())) return null;
  const s = v.trim();
  return dCmp(s, "0") > 0 ? s : null;
}

/**
 * 净需求 + 规整，并留下完整调整链条。
 *
 * 顺序有讲究：**先抬到 MOQ，再向上取箱规倍数**。反过来做会得到不是箱规倍数的结果；
 * 按这个顺序，即使 MOQ 本身不是箱规整数倍，结果也同时满足「≥MOQ」和「是箱规倍数」。
 */
export function suggestQtyDetailed(i: LotSizingInput): LotSizingDetail {
  const adjustments: LotAdjustment[] = [];
  const warnings: LotSizingDetail["warnings"] = [];

  const rawNet = dQty(dSub(dSub(i.grossReq, i.onHand, 6), i.inTransit, 6));

  // 净需求 ≤ 0 → 不下单。**MOQ 不制造需求。**
  if (dCmp(rawNet, "0") <= 0) {
    return {
      qty: "0.0000",
      rawNet: "0.0000",
      adjustments: [],
      overshoot: "0.0000",
      overshootDays: null,
      warnings: [],
    };
  }

  const moq = posDec(i.moq);
  const multiple = posDec(i.orderMultiple);
  const maxOrder = posDec(i.maxOrder);
  const daily = posDec(i.dailyDemand);
  const warnDays = i.overshootWarnDays ?? 90;

  // 策略自相矛盾：先检出，后面照常算但打阻塞级警告
  const contradictory = moq !== null && maxOrder !== null && dCmp(maxOrder, moq) < 0;

  let qty = rawNet;

  // 1) 抬到 MOQ
  if (moq !== null && dCmp(qty, moq) < 0) {
    const to = dMax(qty, moq, 6);
    adjustments.push({ type: "moq", from: dQty(qty), to: dQty(to), note: `低于最小起订量 ${dQty(moq)}，已抬至 MOQ` });
    qty = to;
  }

  // 2) 向上取箱规整数倍
  if (multiple !== null) {
    const bumped = dCeilToMultiple(qty, multiple, 6);
    if (dCmp(bumped, qty) !== 0) {
      adjustments.push({
        type: "multiple",
        from: dQty(qty),
        to: dQty(bumped),
        note: `按箱规 ${dQty(multiple)} 向上取整（${dDiv(bumped, multiple, 4)} 箱）`,
      });
      qty = bumped;
    }
  }

  // 3) 单次上限
  if (maxOrder !== null && dCmp(qty, maxOrder) > 0) {
    if (contradictory) {
      warnings.push({
        level: "blocking",
        message:
          `策略冲突：单次上限 ${dQty(maxOrder)} < 最小起订量 ${dQty(moq!)}。` +
          `低于 MOQ 供应商不接单，高于上限我们不批——已按 MOQ 出量 ${dQty(qty)}，` +
          `需人工裁决（放宽上限 / 换供应商 / 拆单）`,
      });
      // 刻意不下调：低于 MOQ 的量根本下不出去，下调等于产出一张必然被拒的单
    } else {
      // 下调到上限，但仍需保持箱规倍数（向下取整，避免超限）
      let capped = maxOrder;
      if (multiple !== null) {
        const up = dCeilToMultiple(maxOrder, multiple, 6);
        capped = dCmp(up, maxOrder) > 0 ? dSub(up, multiple, 6) : up; // floor 到倍数
      }
      if (dCmp(capped, "0") <= 0) {
        warnings.push({
          level: "blocking",
          message: `单次上限 ${dQty(maxOrder)} 不足一个箱规 ${dQty(multiple!)}，无法在上限内下单——需人工裁决`,
        });
      } else {
        adjustments.push({
          type: "max_order",
          from: dQty(qty),
          to: dQty(capped),
          note: `超过单次上限 ${dQty(maxOrder)}，已下调` + (multiple !== null ? "（保持箱规倍数）" : ""),
        });
        warnings.push({
          level: "warn",
          message: `本次仅能订 ${dQty(capped)}，仍缺 ${dQty(dSub(rawNet, capped, 6))}——需拆成多次订货`,
        });
        qty = capped;
      }
    }
  }

  if (adjustments.length === 0) {
    adjustments.push({ type: "none", from: rawNet, to: rawNet, note: "净需求已可直接下单" });
  }

  const diff = dSub(qty, rawNet, 6);
  const overshoot = dQty(dCmp(diff, "0") > 0 ? diff : "0");
  const overshootDays = daily !== null ? dDiv(overshoot, daily, 4) : null;

  // 超买显性化——MOQ 驱动的过量采购是呆滞库存头号成因，不能让它藏在数字里
  if (overshootDays !== null && dCmp(overshootDays, String(warnDays)) > 0) {
    const driver = adjustments.some((a) => a.type === "moq") ? "最小起订量" : "箱规取整";
    warnings.push({
      level: "warn",
      message:
        `${driver}导致多买 ${overshoot}，相当于额外 ${dDiv(overshoot, daily!, 0)} 天库存` +
        `（超过 ${warnDays} 天阈值）——确认是否接受呆滞风险`,
    });
  }

  return { qty: dQty(qty), rawNet, adjustments, overshoot, overshootDays, warnings };
}

/** 是否存在必须人工处理的阻塞项 */
export function hasBlockingIssue(d: LotSizingDetail): boolean {
  return d.warnings.some((w) => w.level === "blocking");
}

/** 净需求建议量（qty scale=4）——`suggestQtyDetailed` 的薄封装，保证只有一套规整规则 */
export function suggestQty(i: SuggestQtyInput): string {
  return suggestQtyDetailed(i).qty;
}

/** 供 UI 一行说明用：把调整链条串成人话 */
export function describeAdjustments(d: LotSizingDetail): string {
  if (d.adjustments.length === 1 && d.adjustments[0].type === "none") return d.adjustments[0].note;
  return d.adjustments.map((a) => `${a.from} → ${a.to}（${a.note}）`).join("；");
}

