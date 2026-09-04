/**
 * 「先挪后买」统一决策表（W2）——只读装配层，**不新增任何判定**。
 *
 * 解决的问题：计划员每个 SKU 只有一个问题——**在必须下单之前，能不能先从别的仓挪过来？**
 * 而系统把这一个问题拆在两页：`/report/transfer-suggest`（能挪多少）与 `/replenish`（该买多少），
 * 两页的「可销天数」**口径不同且不可比**，于是没人敢把两个数字放在一起看。
 * 本模块把两边的结论按 SKU 并排，**保留两套口径各自的名字**，并给出「先挪之后还差多少要买」。
 *
 * 口径纪律（这是本模块存在的全部理由，不得静默调和）：
 *  - 补货可销天数 `daysCover` = **全网在库 ÷ 近 3 月日均销**（replenish/service，销售口径）；
 *  - 调入仓可销天数 `toCoverBefore/After` = **该仓在库 ÷ 该仓近 N 天出库流水日均**
 *    （report/transfer-suggest，逐仓**发货强度**代理——含调拨出库/盘亏/委外发料，不是纯销量）。
 *  两者分母不同源、分子范围也不同：一个是全网销售、一个是单仓发货。**不能相减、不能相除、
 *  也不能拿一个去"校准"另一个**。页面把两列并排显示并各自带口径标签，服务端不做任何换算。
 *  唯一被合并计算的量是**件数**（建议调拨量与建议补货量都是基础单位整数/decimal），件数是可比的。
 *
 * 排序：**最晚下单日升序**（与 replenish 的缺省序同一权威 `REPLENISH_DEFAULT_SORT_BY`）——
 * 页面回答的是「今天必须动哪几个」，不是「谁最惨」。空值（未触发/无生产周期）一律置底。
 *
 * 写路径：本模块**没有**。页面两个动作复用既有草稿端点：
 *  - 调拨 → `POST /api/inventory/stock-doc`（载荷装配走 `lib/transfer-draft`，与调拨建议页同一函数）；
 *  - 采购 → `POST /api/replenish/draft`（BH 备货申请草稿，人工闸在 service 内）。
 * 不新增任何写入面。
 *
 * 金额：线路单位费用/估算成本走 `report/transfer-routes` 读模型，非 PRICE_VISIBLE_ROLES
 * 由 `stripLaneMoney`（唯一权威）置空；本模块不自己判角色。线路读模型不可用时降级为「无费用线索」，
 * 绝不让整页失败——挪货的决定不依赖费用估算。
 * 行内金额键 `laneMedianUnitFee`/`laneEstCost` 另在 `SENSITIVE_FIELDS`，路由出口再经 `maskSensitive` 兜底。
 *
 * 调拨侧必须取全（W2 修复）：`getTransferSuggestions` 的 pageSize 上限是 500，此前本模块只请求
 * **第一页 500 行**并把 `transfer.total` 读出来又丢掉。生产 620 条调拨建议时，排在第 540 位的那条
 * 对本页不存在——该 SKU 显示 `transferQty = 0`、结论 `buy_only`，计划员在一张专门用来"先挪"的页面上
 * 去买了 400 件本来就躺在另一个仓的货。现按页取满 `total`（`TRANSFER_PAGE_MAX` 页封顶），
 * 仍取不完则在 `summary.transferTruncated` 上**显式说出来**，绝不静默截断。
 */
import { dCmp, dMax, dMoney, dMul, dSub } from "@/server/core/decimal";
import { canSeePrices } from "@/server/core/dto";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import {
  getReplenishSuggestions,
  type ReplenishRow,
  type ReplenishSuppression,
} from "@/server/modules/replenish/service";
import {
  EMPTY_IN_FLIGHT, inFlightWarning, loadInFlightDrafts, type InFlightDrafts,
} from "@/server/modules/replenish/in-flight-drafts";
import {
  getTransferSuggestions,
  type TransferSuggestResult,
  type TransferSuggestRow,
} from "@/server/modules/report/transfer-suggest";
import { loadTransferRoutes, stripLaneMoney, type TransferLaneRow } from "@/server/modules/report/transfer-routes";

/**
 * 本装配层的口径记号（出处守卫 `tests/report/calibre-provenance-guard.test.ts` 认它）。
 * 装配口径变化（取数范围、合并规则）时升版，页面出处文案由此常量派生，不得手抄。
 */
export const MOVE_OR_BUY_CALIBRE_KEY = "move-or-buy/v2";

/** 调拨建议取数的分页上限（每页 500 行；超过即在 summary 上显式标注截断） */
export const TRANSFER_PAGE_MAX = 40;
const TRANSFER_PAGE_SIZE = 500;

/** 两套可销天数的口径标签——页面逐列显示，禁止只写「可销天数」 */
export const COVER_CALIBRES = {
  replenish: {
    label: "全网可销天数",
    basis: "全网在库 ÷ 近 3 月日均销（销售口径，补货建议同源）",
  },
  transfer: {
    label: "调入仓可销天数",
    basis: "该仓在库 ÷ 该仓近 N 天出库流水日均（逐仓发货强度代理，含调拨/盘亏/委外发料，非纯销量）",
  },
  /** 页面必须原样展示这句话：两个口径不可比是结论，不是待办 */
  incomparable:
    "两列可销天数**分母不同源**（全网销售 vs 单仓发货流水），不可相减、相除或互相校准；本页只并排，不做任何换算。",
} as const;

export interface MoveOrBuyTransferOption {
  fromWarehouseId: number;
  fromWarehouse: string;
  toWarehouseId: number;
  toWarehouse: string;
  /** 建议调拨量（基础单位整数，来自 rules/transfer.planTransfers，本模块不再取整） */
  qty: number;
  /** 调出仓调拨前可销天数（逐仓口径；无出库=呆滞积压 → null） */
  fromCoverBefore: number | null;
  /** 调入仓可销天数（逐仓口径） */
  toCoverBefore: number;
  toCoverAfter: number;
  reason: string;
  expiryDriven: boolean;
  minDaysLeft: number | null;
  /** 该线路单位费用中位数（元/件，scale 4；无样本或无金额权限 = null） */
  laneMedianUnitFee: string | null;
  /** 单位费用 × 本次建议量的估算（元，scale 2；无单位费用 = null） */
  laneEstCost: string | null;
  /** 该线路有费用登记的样本数（0 = 没有历史费用，估算不可得） */
  laneSamples: number;
}

/**
 * 「不用买」这一侧此前是一个笼统的 `transfer_only`，两次审计各从里面拆出一档：
 *
 * `buy_suppressed`（C9）：采购建议存在但**被放弃抑制扣着**。不能并进 `transfer_only`——
 * 「先挪即可」是一个结论（不用买），而这里的事实是「系统本来要建议买，被一条抑制窗口扣下了」。
 * 两者的处置完全不同：前者不用管，后者要么确认抑制仍然成立，要么一键解除放行。
 *
 * `none`：既不用买也没货可挪（`suggestQty = "0"` 且无调拨建议）。此前也判成 `transfer_only`
 * 并计入「先挪即可（无需采购）」——一条**一件都挪不了**的行在汇总里冒充「已被调拨覆盖」，
 * `coveredByTransfer` 因此虚高。
 *
 * 剩下的 `transfer_only` 才是它字面的意思：确实有货可挪，且挪完就不用买。
 */
export type MoveOrBuyAction =
  | "transfer_only"
  | "transfer_then_buy"
  | "buy_only"
  | "buy_suppressed"
  | "none";

export interface MoveOrBuyRow {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  baseUom: string;
  /* ── 补货口径（销售）── */
  onHand: number;
  daily: number;
  /** 全网可销天数（COVER_CALIBRES.replenish） */
  daysCover: number | null;
  leadDays: number | null;
  /** 最晚下单日（短缺日 − 生产周期）；本表的排序键 */
  orderByDate: string | null;
  daysToShortage: number | null;
  orderWindowMissed: boolean;
  /** 建议补货量（decimal 字符串；未触发 = null） */
  suggestQty: string | null;
  /* ── 调拨口径（逐仓发货流水）── */
  transfers: MoveOrBuyTransferOption[];
  /** 可从别的仓挪过来的合计件数（基础单位） */
  transferQty: number;
  /* ── 合并结论（只在件数上做，两套可销天数不参与）── */
  /** 先挪之后仍需采购的量；无补货建议 = null */
  residualBuyQty: string | null;
  action: MoveOrBuyAction;
  /**
   * C9：这个 SKU 的采购建议**被「已复核并放弃」抑制着**（`/replenish` 的抑制窗口）。
   *
   * 事故形状：本表此前只收 `suggestQty != null` 的行，被抑制的行 `suggestQty` 恰恰是 null，
   * 于是它要么整行消失、要么以「只能挪」的面目出现——两种都在**隐瞒**「有一笔采购正被扣着」。
   * 抑制绝不静默是全系统的纪律（rules/replenish-suppression），这张表也不例外。
   */
  suppression: ReplenishSuppression | null;
  /** 被抑制而扣下的采购量（`suppression.withheldQty` 的直读；无抑制 = null） */
  withheldBuyQty: string | null;
  /** C10 跨页在途草稿：另一页已经为这个 SKU 起草了多少（只提示，不参与净额） */
  inFlightDrafts: InFlightDrafts;
  inFlightWarning: string | null;
}

export interface MoveOrBuyResult {
  rows: MoveOrBuyRow[];
  total: number;
  summary: {
    /** 需要动作的 SKU 数（有补货建议或有调拨建议） */
    skuCount: number;
    /** 先挪即可完全覆盖、无需采购的 SKU 数 */
    coveredByTransfer: number;
    /** 挪完仍需采购的 SKU 数 */
    stillNeedBuy: number;
    /** 无调拨可挪、只能买的 SKU 数 */
    buyOnly: number;
    /** C9：采购建议被放弃抑制扣着的 SKU 数（这些行的 suggestQty 是 null，但不是「不用买」） */
    declineSuppressed: number;
    /** 既不用买、也没货可挪的 SKU 数（不计入 coveredByTransfer） */
    noAction: number;
    /** 调拨建议的横向扫描窗口（天）——即调入仓可销天数的分母窗口 */
    horizonDays: number;
    /* ── 调拨侧取数完整性（静默截断会让「先挪」结论反向出错，必须可见）── */
    /** 服务端调拨建议总条数（`getTransferSuggestions` 的 total，不是本页装配后的行数） */
    transferLineTotal: number;
    /** 本次实际读入的调拨建议条数 */
    transferLinesLoaded: number;
    /** true = 调拨建议未取全（超过 TRANSFER_PAGE_MAX × 500 行）；页面必须显式告警 */
    transferTruncated: boolean;
    /** 装配层口径记号（出处守卫用；页面出处文案由它派生） */
    calibreKey: typeof MOVE_OR_BUY_CALIBRE_KEY;
    /** 线路费用是否可见（非 PRICE_VISIBLE_ROLES 一律 false，费用列整列为 —） */
    moneyVisible: boolean;
    /** 线路读模型是否可用（不可用只丢费用线索，不影响调拨/采购结论） */
    laneCostAvailable: boolean;
    calibres: typeof COVER_CALIBRES;
  };
}

export interface MoveOrBuyQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  /** 调拨建议的出库流水窗口（天），与 /report/transfer-suggest 同参 */
  horizonDays?: number;
  /** 当前用户角色（金额可见性；服务端判定，前端隐藏不算） */
  roles?: string[];
}

/**
 * 把分页的调拨建议**取满**：`getTransferSuggestions` 的 pageSize 上限是 500，
 * 只读第一页会让第 501 条之后的建议对本页彻底不存在（该 SKU 显示"无货可挪、只能买"）。
 *
 * 抽成独立函数是为了能被直接钉住：造 620 条的假分页器，就能验证"只读第一页"这个缺陷会变红，
 * 而不需要在 PGlite 里真的种出 620 条调拨建议。
 *
 * @param fetchPage 取第 page 页（1 起）；返回该页的行与**服务端总条数**
 * @param maxPages 分页上限；超出即 `truncated: true`（绝不静默截断）
 */
export async function collectTransferSuggestions(
  fetchPage: (page: number) => Promise<{ rows: TransferSuggestRow[]; total: number }>,
  maxPages: number = TRANSFER_PAGE_MAX,
  pageSize: number = TRANSFER_PAGE_SIZE,
): Promise<{ rows: TransferSuggestRow[]; total: number; truncated: boolean }> {
  const first = await fetchPage(1);
  const rows = [...first.rows];
  let truncated = false;
  if (first.total > rows.length) {
    const pages = Math.ceil(first.total / pageSize);
    for (let p = 2; p <= pages; p++) {
      if (p > maxPages) { truncated = true; break; }
      const next = await fetchPage(p);
      if (next.rows.length === 0) break;
      rows.push(...next.rows);
    }
  }
  return { rows, total: first.total, truncated };
}

/** 最晚下单日升序、空值置底；同日按编码 */
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
export function compareByOrderBy(a: MoveOrBuyRow, b: MoveOrBuyRow): number {
  const av = a.orderByDate;
  const bv = b.orderByDate;
  if (av == null && bv == null) return collator.compare(a.code, b.code);
  if (av == null) return 1;
  if (bv == null) return -1;
  if (av !== bv) return av < bv ? -1 : 1;
  return collator.compare(a.code, b.code);
}

/**
 * 一条 (from,to) 线路的费用线索：同一对仓库可能有多种 transfer_type 各自一条线路，
 * 取**样本数最多且有中位单价**的那条作代表（样本最多 = 最有代表性的常规走法）。
 * 没有任何带单价的样本就返回 null——「没登记过费用」不等于「免费」。
 */
export function pickLaneCost(
  lanes: readonly TransferLaneRow[],
  fromWarehouseId: number,
  toWarehouseId: number,
): { medianUnitFee: string | null; samples: number } {
  const candidates = lanes.filter(
    (l) => l.fromWarehouseId === fromWarehouseId && l.toWarehouseId === toWarehouseId,
  );
  if (candidates.length === 0) return { medianUnitFee: null, samples: 0 };
  const withFee = candidates.filter((l) => l.medianUnitFee != null && dCmp(l.medianUnitFee, 0) > 0);
  const totalSamples = candidates.reduce((sum, l) => sum + (l.samples ?? 0), 0);
  if (withFee.length === 0) return { medianUnitFee: null, samples: totalSamples };
  const best = withFee.reduce((acc, l) => ((l.samples ?? 0) > (acc.samples ?? 0) ? l : acc));
  return { medianUnitFee: best.medianUnitFee, samples: best.samples ?? 0 };
}

/** 先挪之后仍需采购的量：suggestQty − Σ可调入（不为负）；无补货建议 = null */
export function residualAfterTransfer(suggestQty: string | null, transferQty: number): string | null {
  if (suggestQty == null) return null;
  return dMax(dSub(suggestQty, String(transferQty)), "0");
}

export function actionOf(
  suggestQty: string | null,
  residual: string | null,
  transferQty: number,
  /** C9：采购建议被放弃抑制扣着（`ReplenishRow.suppression` 非空）——优先于其余判定 */
  buySuppressed = false,
): MoveOrBuyAction {
  if (suggestQty == null || dCmp(suggestQty, "0") <= 0) {
    // 抑制优先：它说明「本来要建议买」，和「不用买」是两回事
    if (buySuppressed) return "buy_suppressed";
    // 不用买：有货可挪才是「先挪即可」，一件都挪不了就是「无需动作」，不许冒充被调拨覆盖
    return transferQty > 0 ? "transfer_only" : "none";
  }
  if (transferQty <= 0) return "buy_only";
  return residual != null && dCmp(residual, "0") > 0 ? "transfer_then_buy" : "transfer_only";
}

export async function getMoveOrBuyDecisions(
  query: MoveOrBuyQuery,
  dbArg?: AnyDb,
): Promise<MoveOrBuyResult> {
  const db = await resolveDb(dbArg);
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));
  const q = (query.q ?? "").trim().toLowerCase();
  const roles = query.roles ?? [];
  const moneyVisible = canSeePrices(roles);

  /* 两个既有服务各自取全量（都已内建各自的过滤与口径），本模块只做并表。
     调拨侧的 pageSize 上限是 500，所以按页取满 total——只读第一页会让 #501 之后的
     调拨建议对本页完全不存在，而那正是这页要回答的问题。 */
  let transferSummary: TransferSuggestResult["summary"] | null = null;
  const [replenish, transfer] = await Promise.all([
    getReplenishSuggestions({ allRows: true }, db),
    collectTransferSuggestions(async (page) => {
      const r = await getTransferSuggestions(
        { page, pageSize: TRANSFER_PAGE_SIZE, horizonDays: query.horizonDays },
        db,
      );
      transferSummary = r.summary;
      return { rows: r.rows, total: r.total };
    }),
  ]);
  const transferRows: TransferSuggestRow[] = transfer.rows;
  const transferTruncated = transfer.truncated;

  /* 线路费用（可选线索）：读模型不可用只丢费用列 */
  let lanes: TransferLaneRow[] = [];
  let laneCostAvailable = false;
  try {
    const model = await loadTransferRoutes(db);
    lanes = (moneyVisible ? model : stripLaneMoney(model)).lanes;
    laneCostAvailable = true;
  } catch {
    lanes = [];
    laneCostAvailable = false;
  }

  const transfersBySku = new Map<number, TransferSuggestRow[]>();
  for (const t of transferRows) {
    const list = transfersBySku.get(t.skuId) ?? [];
    list.push(t);
    transfersBySku.set(t.skuId, list);
  }

  const replenishBySku = new Map<number, ReplenishRow>(replenish.rows.map((r) => [r.skuId, r]));

  /* C10：本页起草的是**净额后**的采购量，`/replenish` 起草的是全额——两页对同一个缺口
     各下一次单，多订的正好是调拨量。把另一页已经在飞的草稿摆到行上（只提示，不自动扣减）。 */
  const inFlightBySku = await loadInFlightDrafts(
    db,
    [...new Set([...replenish.rows.map((r) => r.skuId), ...transfersBySku.keys()])],
  );

  /* 需要动作的 SKU：有补货建议、**采购建议被放弃抑制扣着**（C9），或有调拨建议
     （三边并集，任一边有话说就该出现在这张表上）。
     只收 suggestQty != null 会把被抑制的行整行吞掉——而那正是最需要被看见的一类：
     系统扣下了一笔采购，读者却在决策表上看不出任何痕迹。 */
  const skuIds = new Set<number>();
  for (const r of replenish.rows) if (r.suggestQty != null || r.suppression != null) skuIds.add(r.skuId);
  for (const id of transfersBySku.keys()) skuIds.add(id);

  const all: MoveOrBuyRow[] = [];
  for (const skuId of skuIds) {
    const r = replenishBySku.get(skuId);
    const ts = transfersBySku.get(skuId) ?? [];
    /* 只在调拨侧出现（成品之外/未进补货引擎范围）的 SKU：补货列如实留空，不编造 */
    const code = r?.code ?? ts[0]?.code ?? "";
    const name = r?.name ?? ts[0]?.name ?? "";
    const baseUom = r?.baseUom ?? ts[0]?.baseUom ?? "";
    if (q && !(code.toLowerCase().includes(q) || name.toLowerCase().includes(q))) continue;

    const transfers: MoveOrBuyTransferOption[] = ts.map((t) => {
      const cost = pickLaneCost(lanes, t.fromWarehouseId, t.toWarehouseId);
      return {
        fromWarehouseId: t.fromWarehouseId,
        fromWarehouse: t.fromWarehouse,
        toWarehouseId: t.toWarehouseId,
        toWarehouse: t.toWarehouse,
        qty: t.qty,
        fromCoverBefore: t.fromCoverBefore,
        toCoverBefore: t.toCoverBefore,
        toCoverAfter: t.toCoverAfter,
        reason: t.reason,
        expiryDriven: t.expiryDriven,
        minDaysLeft: t.minDaysLeft,
        laneMedianUnitFee: cost.medianUnitFee,
        laneEstCost: cost.medianUnitFee == null ? null : dMoney(dMul(cost.medianUnitFee, String(t.qty), 4)),
        laneSamples: cost.samples,
      };
    });
    const transferQty = transfers.reduce((sum, t) => sum + t.qty, 0);
    const suggestQty = r?.suggestQty ?? null;
    const residualBuyQty = residualAfterTransfer(suggestQty, transferQty);
    const suppression = r?.suppression ?? null;
    const inFlight = inFlightBySku.get(skuId) ?? EMPTY_IN_FLIGHT;

    all.push({
      skuId,
      code,
      name,
      brand: r?.brand ?? null,
      baseUom,
      onHand: r?.onHand ?? 0,
      daily: r?.daily ?? 0,
      daysCover: r?.daysCover ?? null,
      leadDays: r?.leadDays ?? null,
      orderByDate: r?.orderByDate ?? null,
      daysToShortage: r?.daysToShortage ?? null,
      orderWindowMissed: r?.orderWindowMissed ?? false,
      suggestQty,
      transfers,
      transferQty,
      residualBuyQty,
      action: actionOf(suggestQty, residualBuyQty, transferQty, suppression != null),
      suppression,
      withheldBuyQty: suppression?.withheldQty ?? null,
      inFlightDrafts: inFlight,
      /* 本页两侧都做（挪 + 买），提示的是**调拨**侧的在途草稿：
         本页起草的是净额后的 residualBuyQty，而 /replenish 起草的是全额 suggestQty，
         两页对同一个缺口各下一次就是 C10 的多订形态。 */
      inFlightWarning: inFlightWarning(inFlight, "transfer"),
    });
  }

  all.sort(compareByOrderBy);
  const rows = all.slice((page - 1) * pageSize, page * pageSize);

  return {
    rows,
    total: all.length,
    summary: {
      skuCount: all.length,
      coveredByTransfer: all.filter((r) => r.action === "transfer_only").length,
      stillNeedBuy: all.filter((r) => r.action === "transfer_then_buy").length,
      buyOnly: all.filter((r) => r.action === "buy_only").length,
      declineSuppressed: all.filter((r) => r.suppression != null).length,
      noAction: all.filter((r) => r.action === "none").length,
      horizonDays: (transferSummary as TransferSuggestResult["summary"] | null)?.horizonDays ?? 0,
      transferLineTotal: transfer.total,
      transferLinesLoaded: transferRows.length,
      transferTruncated,
      calibreKey: MOVE_OR_BUY_CALIBRE_KEY,
      moneyVisible,
      laneCostAvailable,
      calibres: COVER_CALIBRES,
    },
  };
}
