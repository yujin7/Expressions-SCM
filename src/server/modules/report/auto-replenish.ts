/**
 * 自动补货候选（守护式，只读报表层）。
 *
 * 守护式纪律（R13 doctrine）：本页只「预览候选」并由人工点击「生成草稿」——绝不自动提交。
 * 自动候选 = 把「安全且明确」的告急 SKU 挑出来供一键批量生成草稿；其余一律转人工判断。
 *
 * 判定（全部既有口径，不新增数据）：复用两支既有报表——
 * - ABC/XYZ 分层：report/segmentation.getSegmentation（近6月销量）→ 逐 SKU abc/xyz/cell；
 * - R11 补货建议：replenish/service.getReplenishSuggestions → 逐 SKU suggestQty/refGap/leadDays/daysCover。
 * 按 skuId 关联。自动候选 iff 全部成立：
 *   (a) suggestQty != null（低于预警且有明确正建议量、且未被覆盖缺口抑制）；
 *   (b) abc ∈ {A,B}（有意义的销量）；
 *   (c) xyz ∈ {X,Y}（需求稳定，非 Z 波动）；
 *   (d) refGap === false（非覆盖缺口 SKU——覆盖缺口需先核实全口径，防重复下单）；
 *   (e) leadDays != null（有常规生产周期，草稿量口径明确）。
 * 有 suggestQty 但不满足上述者 = 「需人工判断」例外，各带中文原因。
 * 全表无金额字段，免脱敏；只读不写库（唯一写路径为既有 /api/replenish/draft）。
 */
import { getSegmentation } from "@/server/modules/report/segmentation";
import { getReplenishSuggestions } from "@/server/modules/replenish/service";
import { num } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface AutoReplenishCandidate {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  cell: string;
  daysCover: number | null;
  suggestQty: string | null;
  baseUom: string;
  leadDays: number | null;
}

export interface AutoReplenishException {
  skuId: number;
  code: string;
  name: string;
  brand: string | null;
  cell: string;
  daysCover: number | null;
  suggestQty: string | null;
  baseUom: string;
  leadDays: number | null;
  /** 未纳入自动候选的原因（中文，可多条合并） */
  reason: string;
}

export interface AutoReplenishResult {
  candidates: AutoReplenishCandidate[];
  exceptions: AutoReplenishException[];
  summary: {
    candidateCount: number;
    exceptionCount: number;
    /** 候选建议量合计（简单数值求和后转字符串） */
    totalSuggestQty: string;
  };
}

/* 这里曾有一个「60s 模块缓存」（struct#16）。它**从未生效**：变量只有读取与清空，
   函数结尾直接 return 对象字面量，全程没有一次赋值。当初提交信息里的「1.48s→0.099s（15×）」
   是同一进程内 call#1（建连+迁移检查+JIT）与 call#2 之差，不是缓存效果——
   清缓存 105ms、不清缓存 105ms，完全一致。
   实测本报表 105ms（1026 个在售成品 / 441 个有销量 SKU），不需要缓存，故整块删除。
   要再加缓存，先按 skill `measure-first` 拿基线数字。 */
export async function getAutoReplenishCandidates(dbArg?: AnyDb): Promise<AutoReplenishResult> {
  /* ── 复用两支既有报表（大页避免分页丢行，传 db 同事务/同连接） ── */
  const seg = await getSegmentation({ allRows: true }, dbArg);
  const rep = await getReplenishSuggestions({ allRows: true }, dbArg);

  const segBySku = new Map<number, { abc: string; xyz: string; cell: string }>();
  for (const s of seg.rows) segBySku.set(s.skuId, { abc: s.abc, xyz: s.xyz, cell: s.cell });

  const candidates: AutoReplenishCandidate[] = [];
  const exceptions: AutoReplenishException[] = [];

  for (const r of rep.rows) {
    // 只看「告急且有明确正建议量」的 SKU（未触发预警或被抑制的不在本页范围）
    if (r.suggestQty == null) continue;
    const sg = segBySku.get(r.skuId);
    const cell = sg?.cell ?? "—";
    const base = {
      skuId: r.skuId,
      code: r.code,
      name: r.name,
      brand: r.brand,
      cell,
      daysCover: r.daysCover,
      suggestQty: r.suggestQty,
      baseUom: r.baseUom,
      leadDays: r.leadDays,
    };

    const abcOk = sg != null && (sg.abc === "A" || sg.abc === "B");
    const xyzOk = sg != null && (sg.xyz === "X" || sg.xyz === "Y");
    const gapOk = r.refGap === false;
    const leadOk = r.leadDays != null;

    if (abcOk && xyzOk && gapOk && leadOk) {
      candidates.push(base);
      continue;
    }

    /* ── 例外：收集全部未通过原因（中文），合并成一条 reason ── */
    const reasons: string[] = [];
    if (!gapOk) reasons.push("覆盖缺口需先核实全口径");
    if (sg == null) reasons.push("未纳入销售分层");
    else if (!abcOk || !xyzOk) reasons.push(`长尾/波动大(cell ${cell})不宜自动`);
    if (!leadOk) reasons.push("缺生产周期");
    exceptions.push({ ...base, reason: reasons.join("；") });
  }

  /* ── 排序：可销天数升序（越紧急越靠前）；各表封顶 500 ── */
  const byCover = (a: { daysCover: number | null }, b: { daysCover: number | null }) =>
    (a.daysCover ?? Number.POSITIVE_INFINITY) - (b.daysCover ?? Number.POSITIVE_INFINITY);
  candidates.sort(byCover);
  exceptions.sort(byCover);
  const cappedCandidates = candidates.slice(0, 500);
  const cappedExceptions = exceptions.slice(0, 500);

  const totalSuggest = cappedCandidates.reduce((acc, c) => acc + num(c.suggestQty), 0);

  return {
    candidates: cappedCandidates,
    exceptions: cappedExceptions,
    summary: {
      candidateCount: cappedCandidates.length,
      exceptionCount: cappedExceptions.length,
      totalSuggestQty: String(totalSuggest),
    },
  };
}
