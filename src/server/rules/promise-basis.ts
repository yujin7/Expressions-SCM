/**
 * 采购承诺口径（原始承诺 vs 当前承诺）——**唯一权威**，纯函数无依赖。
 *
 * 事故形态（W2 审计 1）：`purchase-order-metrics` 与 `supplier-scorecard` 都按
 * `coalesce(行交期, 表头交期)` 判准时，也就是按**当前有效承诺**判。可 `po_promise_revisions`
 * 是供应商自己经确认门户改期时写进去的：供应商把交期从 3 月 1 日改到 3 月 30 日，
 * 3 月 28 日到货，两处读数都记「准时」。于是**改期越勤、分数越高**——OTIF 可以被自己洗白。
 *
 * 口径（沿用 `report/supply-commitment.ts` 已经建立、且已在到货日历上出数的那一套，不新造）：
 * - **原始承诺** = 该 PO 行不可变版本链里第一条**可信**（source ∈ `TRUSTED_PROMISE_SOURCES` 白名单）
 *   修订的 `promised_date`。
 *   为什么不取第一条修订的 `previous_date`：那是买手下单时自己填的预计到货日，不是供应商的承诺；
 *   供应商第一次确认才是第一个真承诺。第一条可信修订因此算「承诺建立」而不算「改期」（revisionCount 减 1）。
 * - **当前承诺** = `coalesce(行交期, 表头交期)`（供应商改过几次就是第几次的值）。
 * - 版本链以 `legacy_backfill` 打头 → 该行是迁移快照，只能标 `backfilled`，**不冒充**原始承诺；
 *   没有任何可信修订 → `missing`。两种情况都不倒推。
 *
 * 消费方必须把两个口径**并列展示并标注**（原始承诺为主、当前承诺为辅），
 * 只出一个数就等于让读者自己去猜他看的是被改期洗过的那一版。
 */

/** 承诺版本链里的一条修订（字段名与 po_promise_revisions 对齐） */
export interface PromiseRevisionFact {
  sequence: number;
  promisedDate: string | null;
  source: string;
}

/** 原始承诺的可信度：可信 / 迁移快照 / 无版本链 */
export type PromiseHistoryState = "trusted" | "backfilled" | "missing";

export interface PromiseBasisFact {
  /** 第一条可信修订的承诺日；不可信 → null（绝不用当前承诺冒充） */
  originalPromisedDate: string | null;
  historyState: PromiseHistoryState;
  /** 真正的**改期**次数（第一条可信修订算承诺建立，不算改期） */
  revisionCount: number;
}

export const LEGACY_PROMISE_SOURCE = "legacy_backfill";

/**
 * **白名单**：哪些来源算得上「供应商自己的承诺」。
 *
 * 此前这里是黑名单（`source !== legacy_backfill`），方向反了：`po_promise_revisions`
 * 的来源集合里还有 `buyer_revision`（买手自己改期）与 `external_observation`（外部系统观察）。
 * 一旦哪天有人接上 `buyer_revision` 写入，**买手自己改的那一笔**就会被当成
 * 「供应商的原始承诺」并标 `trusted`——OTIF 的分母基准由被评价方的对手方随手写定。
 * 新来源要进这个口径必须显式登记在这里（改这一行会被代码评审看见），默认一律不认。
 */
export const TRUSTED_PROMISE_SOURCES: readonly string[] = ["supplier_confirm"];

export function isTrustedPromiseSource(source: string): boolean {
  return TRUSTED_PROMISE_SOURCES.includes(source);
}

/** 判定口径标签（中文界面按此展示；两个口径必须同时出现，不得只标一个） */
export const PROMISE_BASIS_LABELS = {
  original: "原始承诺",
  current: "当前承诺",
} as const;

export type PromiseBasis = keyof typeof PROMISE_BASIS_LABELS;

/** 版本链 → 原始承诺事实。`revisions` 必须按 sequence 升序传入（调用方按主键排序即可）。 */
export function resolvePromiseBasis(revisions: readonly PromiseRevisionFact[]): PromiseBasisFact {
  const startsWithLegacy = revisions[0]?.source === LEGACY_PROMISE_SOURCE;
  const trusted = revisions.filter((r) => isTrustedPromiseSource(r.source));
  const firstTrusted = startsWithLegacy
    ? undefined
    : trusted.find((r) => r.promisedDate != null);
  return {
    originalPromisedDate: firstTrusted?.promisedDate ?? null,
    historyState: startsWithLegacy ? "backfilled" : firstTrusted ? "trusted" : "missing",
    revisionCount: startsWithLegacy ? trusted.length : Math.max(0, trusted.length - 1),
  };
}

/**
 * 判定用的原始承诺日：可信则用原始承诺，否则**回落当前承诺并由调用方标注回落**
 * （回落不是「没有承诺」，是「没有版本链」——分母不能因此凭空缩小，
 *  但读数必须带 historyState，否则读者会以为全量都按原始承诺判过）。
 */
export function promiseDateForBasis(
  basis: PromiseBasis,
  fact: PromiseBasisFact,
  currentPromisedDate: string | null,
): string | null {
  if (basis === "current") return currentPromisedDate;
  return fact.originalPromisedDate ?? currentPromisedDate;
}

/** 原始承诺是否来自真实版本链（false = 本行的「原始承诺」其实是回落的当前承诺） */
export function isTrustedOriginal(fact: PromiseBasisFact): boolean {
  return fact.historyState === "trusted" && fact.originalPromisedDate != null;
}

/** 版本链覆盖率统计桶（各消费方展示「多少行真的按原始承诺判过」） */
export interface PromiseHistoryCoverage {
  trusted: number;
  backfilled: number;
  missing: number;
}

export function emptyPromiseHistoryCoverage(): PromiseHistoryCoverage {
  return { trusted: 0, backfilled: 0, missing: 0 };
}

export function countPromiseHistory(acc: PromiseHistoryCoverage, fact: PromiseBasisFact): void {
  if (isTrustedOriginal(fact)) acc.trusted += 1;
  else if (fact.historyState === "backfilled") acc.backfilled += 1;
  else acc.missing += 1;
}
