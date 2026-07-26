/**
 * E2-12 FEFO 出库批次分配。
 *
 * 背景：效期数据齐全、临期风险页也建了，但出库时"该先发哪个批次"没有任何规则支撑——
 * 效期管理停在"告警"，没进到"执行"。本模块补上分配算法。
 *
 * 口径与取舍：
 * - **先到期先出**（First-Expired-First-Out）：按 expiryDate 升序消耗，这比 FIFO（按入库日）
 *   更贴合效期业务——先进来的未必先过期（不同供应商保质期不同）。
 * - `expiryDate === null` 的批次**排在最后**：无效期信息不应优先出库（可能是长保质期或未录入），
 *   但也绝不丢弃——否则这些库存会变成永远发不出去的死库存。
 * - 同到期日按 batchId 升序，保证**结果稳定**（同样输入永远同样输出，便于测试与复现）。
 * - 数量不足时返回 `shortBy > 0` 并给出**已能覆盖的部分分配**，绝不静默截断——
 *   调用方必须显式处理缺口（与全系统"不静默截断"的纪律一致）。
 * - 已过期批次**不参与可发分配**：化妆品/食品效期属于安全边界，不能只提示后仍自动推荐。
 *   被排除批次数量会显式返回，若因此不足则 `shortBy` 保留真实缺口。
 *
 * 数量口径：分配结果会成为出库过账数量，因此**全程走 decimal 字符串**（CLAUDE.md 硬规则），
 * 不用浮点——否则会在台账里留下 0.30000000000000004 这类值。
 */
import { dCmp, dQty, dSub } from "@/server/core/decimal";

export interface BatchLot {
  batchId: number;
  batchNo: string;
  /** 到期日 YYYY-MM-DD；null = 未录入效期 */
  expiryDate: string | null;
  /** 该批次在该仓的可用量（decimal 字符串） */
  qty: string;
}

export interface Allocation {
  batchId: number;
  batchNo: string;
  expiryDate: string | null;
  /** 从该批次取用的数量（qty scale=4） */
  qty: string;
}

export interface FefoResult {
  allocations: Allocation[];
  /** 未能满足的缺口（"0.0000" = 完全满足） */
  shortBy: string;
  /** 已分配合计 */
  allocated: string;
  /** 因过期被排除的正库存批次数量 */
  expiredLots: number;
  note: string;
}

/** 合法 decimal 字符串——脏数据不得让整个分配抛错 */
const DEC_RE = /^-?\d+(\.\d+)?$/;
const isDec = (v: unknown): v is string => typeof v === "string" && DEC_RE.test(v.trim());

/** 排序键：有效期升序（null 最后）→ batchId 升序（稳定） */
function compareLots(a: BatchLot, b: BatchLot): number {
  const ax = a.expiryDate;
  const bx = b.expiryDate;
  if (ax == null && bx == null) return a.batchId - b.batchId;
  if (ax == null) return 1; // null 排最后
  if (bx == null) return -1;
  if (ax !== bx) return ax < bx ? -1 : 1;
  return a.batchId - b.batchId;
}

/**
 * 按 FEFO 从批次库存中分配出库量。
 * @param lots  可用批次库存（qty <= 0 或非法值的行会被忽略）
 * @param required 需求量（decimal 字符串）
 * @param today 用于判定"已过期"的基准日（YYYY-MM-DD）；省略则不做过期标注
 */
export function allocateFefo(lots: BatchLot[], required: string, today?: string): FefoResult {
  const need = isDec(required) && dCmp(required, "0") > 0 ? required : "0";
  if (dCmp(need, "0") <= 0) {
    return {
      allocations: [],
      shortBy: dQty("0"),
      allocated: dQty("0"),
      expiredLots: 0,
      note: "需求量为 0，无需分配",
    };
  }

  const positive = (lots ?? [])
    .filter((l) => l && isDec(l.qty) && dCmp(l.qty, "0") > 0)
    .slice();
  const expiredLots = today
    ? positive.filter((l) => l.expiryDate != null && l.expiryDate <= today).length
    : 0;
  const usable = positive
    .filter((l) => !today || l.expiryDate == null || l.expiryDate > today)
    .slice()
    .sort(compareLots);

  const allocations: Allocation[] = [];
  let remaining = need;

  for (const lot of usable) {
    if (dCmp(remaining, "0") <= 0) break;
    // take = min(lot.qty, remaining)
    const take = dCmp(lot.qty, remaining) <= 0 ? lot.qty : remaining;
    if (dCmp(take, "0") <= 0) continue;
    allocations.push({
      batchId: lot.batchId,
      batchNo: lot.batchNo,
      expiryDate: lot.expiryDate,
      qty: dQty(take),
    });
    remaining = dSub(remaining, take, 6);
  }

  const allocated = dQty(dSub(need, remaining, 6));
  const shortBy = dQty(dCmp(remaining, "0") > 0 ? remaining : "0");

  const parts: string[] = [];
  parts.push(
    dCmp(shortBy, "0") > 0
      ? `批次库存不足，尚缺 ${shortBy}（已分配 ${allocated}）`
      : `已按先到期先出分配 ${allocations.length} 个批次`,
  );
  if (expiredLots > 0) parts.push(`已排除 ${expiredLots} 个过期批次，不计入可发库存`);
  if (usable.some((l) => l.expiryDate == null)) parts.push("存在无效期批次，已排在有效期批次之后");

  return { allocations, shortBy, allocated, expiredLots, note: parts.join("；") };
}
