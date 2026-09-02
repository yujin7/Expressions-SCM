/**
 * 天猫平台 SKU 身份缺口（按销售额排序）+ 认领建议。
 *
 * 为什么要有这个读模型（2026-09-02 生产只读实测，最新批次 2026-05-01～09-01）：
 *   - 天猫 3 家店 4 个月支付金额 ¥57.5M，落在 2,076 个平台 SKU 上；
 *   - 只有 573 个能经「SKU 对照表 → 商家编码」精确归到系统 SKU，**按金额只覆盖 46.7%**；
 *   - 1,217 个平台 SKU（金额占 44.2%）**根本不在对照表里**——销量最大的睡眠面膜、清洁泥膜都在其中。
 *   既有的身份控制塔只能看见对照表里的行，这一半营收对它是盲区；而外部需求信号、退款驱动、
 *   履约缺口全都建立在"已映射"之上，所以身份缺口就是整条外部数据链的瓶颈。
 *
 * 这里做三件事，且全部是观察口径：
 *   1. 把每个平台 SKU 的销售额、件数、最近售出日与**身份状态**并排列出，按金额倒序——
 *      让人先补最值钱的那几十个，而不是按 ID 顺序清 1,200 个；
 *   2. 给出**建议候选**：按店铺推断品牌，用规格（净含量:220g → 220g）与名称词元和系统成品 SKU
 *      比对打分。建议只是建议——绝不自动写身份，人工确认后才经 claimPlatformSku 落库；
 *   3. 认领落库为 sku_identifiers(kind=external, scope=JIANDAOYUN:TMALL, value=店铺|平台SKU)，
 *      外部需求信号会把它当作对照表之外的第二条身份桥，覆盖率随认领即时上升。
 *
 * 缓存绑定最新批次 + 直接认领标识的版本；认领后由写路径主动刷新。
 */
import { sql, type SQL } from "drizzle-orm";

import { dAdd, dCmp, dDiv, dSub } from "@/server/core/decimal";

interface ReadDb {
  execute(query: SQL): Promise<unknown>;
}

export const PLATFORM_SKU_IDENTIFIER_SCOPE = "JIANDAOYUN:TMALL";
const READ_MODEL_CACHE_KEY = "jiandaoyun-platform-sku-identity-gap/v1";
const TOP_ROWS = 60;
const MAX_CANDIDATES = 3;
const MIN_CANDIDATE_SCORE = 60;
const MIN_TOKEN_OVERLAP = 2; // 只有规格+品牌、名称一个词都不沾，不算相似

export type PlatformSkuGapStatus =
  | "mapped"
  | "direct_claimed"
  | "crosswalk_without_code"
  | "barcode_claim_pending"
  | "not_in_crosswalk";

export interface PlatformSkuGapCandidate {
  skuId: number;
  code: string;
  name: string;
  score: number;
  reasons: string[];
}

export interface PlatformSkuGapRow {
  shopName: string;
  platformSkuId: string;
  productName: string | null;
  skuName: string | null;
  specToken: string | null;
  brandCode: string | null;
  paidAmount: string;
  paidQty: number;
  refundQty: number;
  firstSoldDate: string | null;
  lastSoldDate: string | null;
  activeDays: number;
  status: PlatformSkuGapStatus;
  skuId: number | null;
  skuCode: string | null;
  barcode: string | null;
  exceptionId: number | null;
  exceptionStatus: "open" | "resolved" | "ignored" | null;
  candidates: PlatformSkuGapCandidate[];
}

export interface PlatformSkuIdentityGap {
  state: "ready" | "insufficient";
  authority: "observation_only";
  source: "JIANDAOYUN";
  platform: "天猫";
  gate: string;
  sourceAsOf: string | null;
  crosswalkAsOf: string | null;
  window: { from: string | null; to: string | null };
  totals: {
    platformSkus: number;
    mappedSkus: number;
    paidAmount: string;
    mappedPaidAmount: string;
    unmappedPaidAmount: string;
    mappedAmountPct: number | null;
    byStatus: Record<PlatformSkuGapStatus, { skus: number; paidAmount: string }>;
    unmappedWithCandidates: number;
    /** 若把"有候选"的缺口全部认领，金额覆盖率会到多少——给业务一个投入产出的预期 */
    coverableAmountPct: number | null;
  };
  byShop: { shopName: string; brandCode: string | null; paidAmount: string; mappedAmountPct: number | null; platformSkus: number; unmappedSkus: number }[];
  top: PlatformSkuGapRow[];
  /**
   * 对照表商家编码与系统编码逐字相等、但尚未认领的行。
   * 治理规定外部码即使同码也不自动认领（tests/integrations/jiandaoyun-identity-boundary），
   * 所以这里只是把确定性线索攒成一批，供人复核后一次确认。
   */
  exactHits: { shopName: string; platformSkuId: string; skuId: number; skuCode: string; paidAmount: string }[];
  exactHitAmountPct: number | null;
  limitations: string[];
}

interface LatestBatch { importJobId: number; sourceAsOf: string | null }

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as T[] : [];
}
function intValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}
function textValue(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}
function money(value: unknown): string {
  const text = textValue(value);
  return text && /^-?\d+(\.\d+)?$/.test(text) ? text : "0";
}

async function latestBatch(db: ReadDb, stream: string): Promise<LatestBatch | null> {
  const result = await db.execute(sql`
    SELECT ir.import_job_id, ij.source_as_of
    FROM integration_runs ir
    INNER JOIN import_jobs ij ON ij.id = ir.import_job_id
    WHERE ir.connector = 'jdy' AND ir.stream = ${stream}
      AND ir.status = 'succeeded' AND ir.import_job_id IS NOT NULL
    ORDER BY ir.id DESC
    LIMIT 1
  `);
  const [row] = resultRows<Record<string, unknown>>(result);
  const importJobId = intValue(row?.import_job_id);
  return importJobId > 0
    ? { importJobId, sourceAsOf: row?.source_as_of == null ? null : String(row.source_as_of) }
    : null;
}

async function directIdentifierVersion(db: ReadDb): Promise<string> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS n, coalesce(max(id), 0)::int AS max_id, coalesce(max(updated_at), 'epoch')::text AS updated
    FROM sku_identifiers WHERE kind = 'external' AND scope = ${PLATFORM_SKU_IDENTIFIER_SCOPE}
  `);
  const [row] = resultRows<Record<string, unknown>>(result);
  return `direct:${intValue(row?.n)}:${intValue(row?.max_id)}:${String(row?.updated ?? "")}`;
}

/* ---------- 建议候选：规格 + 名称词元，只建议不裁决 ---------- */

/** 「净含量:220g」「220g」「30片」「75ml(60片)」 → 规范化规格串（小写、去空格） */
export function extractSpecToken(skuName: string | null, productName: string | null): string | null {
  const source = `${skuName ?? ""} ${productName ?? ""}`;
  const match = source.match(/(\d+(?:\.\d+)?)\s*(g|G|ml|ML|mL|L|kg|片|支|袋|瓶|粒|贴|颗|条)/);
  if (!match) return null;
  return `${match[1]}${match[2].toLowerCase()}`;
}

/** 中文按双字词元、字母数字按单词；去掉营销噪音词 */
const NOISE = new Set(["正品", "官方", "旗舰店", "旗舰", "进口", "海外", "新加坡", "男士", "女士", "男女", "学生", "秋冬", "春夏", "夏季", "冬季", "补水", "保湿", "官网", "同款"]);
export function nameTokens(text: string | null): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;
  const cleaned = text
    .replace(/[（(][^）)]*[）)]/g, " ") // 括号内是品牌/规格，另行比对
    .replace(/[【】\[\]\-–—_/,，。·:：+&]/g, " ");
  for (const word of cleaned.match(/[A-Za-z0-9]{2,}/g) ?? []) tokens.add(word.toLowerCase());
  const cjk = cleaned.replace(/[^一-鿿]/g, "");
  for (let i = 0; i + 1 < cjk.length; i++) {
    const bigram = cjk.slice(i, i + 2);
    if (!NOISE.has(bigram)) tokens.add(bigram);
  }
  return tokens;
}

interface SkuCandidateSource { skuId: number; code: string; name: string; brandCode: string | null; spec: string | null }

export function scoreCandidates(
  row: { productName: string | null; skuName: string | null; brandCode: string | null; specToken: string | null },
  skus: SkuCandidateSource[],
): PlatformSkuGapCandidate[] {
  const productTokens = nameTokens(row.productName);
  if (productTokens.size === 0) return [];
  const scored: PlatformSkuGapCandidate[] = [];
  for (const sku of skus) {
    if (row.brandCode && sku.brandCode && sku.brandCode !== row.brandCode) continue;
    const reasons: string[] = [];
    let score = 0;
    const skuTokens = nameTokens(sku.name);
    let overlap = 0;
    for (const token of productTokens) if (skuTokens.has(token)) overlap++;
    const overlapPct = overlap / Math.max(1, Math.min(productTokens.size, skuTokens.size));
    if (overlap < MIN_TOKEN_OVERLAP) continue;
    score += Math.round(overlapPct * 55);
    reasons.push(`名称词元重合 ${overlap} 个`);
    if (row.specToken) {
      const skuSpec = extractSpecToken(sku.spec, sku.name);
      if (skuSpec === row.specToken) {
        score += 40;
        reasons.push(`规格一致 ${row.specToken}`);
      } else if (skuSpec) {
        score -= 20;
        reasons.push(`规格不同（系统 ${skuSpec}）`);
      }
    }
    if (row.brandCode && sku.brandCode === row.brandCode) {
      score += 5;
      reasons.push("品牌一致");
    }
    if (score >= MIN_CANDIDATE_SCORE) scored.push({ skuId: sku.skuId, code: sku.code, name: sku.name, score, reasons });
  }
  return scored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code)).slice(0, MAX_CANDIDATES);
}

/** 店铺名里含品牌名（中/英/编码）即视为该品牌店；对不上则不按品牌收窄候选 */
export function brandCodeForShop(
  shopName: string,
  brands: { code: string; nameCn: string | null; nameEn: string | null }[],
): string | null {
  const shop = shopName.toUpperCase();
  const hits = brands.filter((b) =>
    [b.code, b.nameCn, b.nameEn].some((n) => n && n.length >= 2 && shop.includes(n.toUpperCase())),
  );
  return hits.length === 1 ? hits[0].code : null;
}

/* ---------- 计算 ---------- */

export async function computePlatformSkuIdentityGap(db: ReadDb): Promise<PlatformSkuIdentityGap> {
  const [salesBatch, refundBatch, crosswalkBatch] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation"),
    latestBatch(db, "tmall-sku-refund-observation"),
    latestBatch(db, "tmall-sku-crosswalk-observation"),
  ]);
  if (!salesBatch) {
    return emptyPlatformSkuIdentityGap("缺少天猫日销量的成功批次，身份缺口保持关闭。");
  }

  const [salesResult, refundResult, crosswalkResult, directResult, exceptionResult, skuResult, brandResult] = await Promise.all([
    db.execute(sql`
      SELECT payload->'data'->>'shopName' AS shop_name,
             payload->'data'->>'skuId' AS platform_sku_id,
             max(payload->'data'->>'productName') AS product_name,
             max(payload->'data'->>'skuName') AS sku_name,
             round(sum(CASE WHEN trim(coalesce(payload->'data'->>'paidAmount','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                            THEN (payload->'data'->>'paidAmount')::numeric ELSE 0 END), 2)::text AS paid_amount,
             sum(CASE WHEN trim(coalesce(payload->'data'->>'paidNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                      THEN (payload->'data'->>'paidNumber')::numeric ELSE 0 END)::int AS paid_qty,
             min(left(payload->'data'->>'statisticalDate', 10)) AS first_date,
             max(left(payload->'data'->>'statisticalDate', 10)) AS last_date,
             count(DISTINCT left(payload->'data'->>'statisticalDate', 10))::int AS active_days
      FROM staging_rows
      WHERE import_job_id = ${salesBatch.importJobId}
        AND target_table = 'jdy_tmall_sku_sales_observation'
        AND status IN ('pending', 'validated', 'committed')
        AND nullif(trim(payload->'data'->>'shopName'), '') IS NOT NULL
        AND nullif(trim(payload->'data'->>'skuId'), '') IS NOT NULL
      GROUP BY 1, 2
    `),
    refundBatch
      ? db.execute(sql`
        SELECT payload->'data'->>'shopName' AS shop_name,
               payload->'data'->>'skuId' AS platform_sku_id,
               sum(CASE WHEN trim(coalesce(payload->'data'->>'successRefundSuborderNumber','')) ~ '^-?[0-9]+([.][0-9]+)?$'
                        THEN (payload->'data'->>'successRefundSuborderNumber')::numeric ELSE 0 END)::int AS refund_qty
        FROM staging_rows
        WHERE import_job_id = ${refundBatch.importJobId}
          AND target_table = 'jdy_tmall_sku_refund_observation'
          AND status IN ('pending', 'validated', 'committed')
        GROUP BY 1, 2
      `)
      : Promise.resolve([]),
    crosswalkBatch
      ? db.execute(sql`
        SELECT payload->'data'->>'shopName' AS shop_name,
               payload->'data'->>'platformSkuId' AS platform_sku_id,
               max(nullif(trim(payload->'data'->>'barcode'), '')) AS barcode,
               max(nullif(trim(payload->'data'->>'merchantSkuCode'), '')) AS merchant_code,
               count(DISTINCT (payload->'_identity'->>'skuId'))::int AS identity_count,
               max(payload->'_identity'->>'skuId') AS sku_id
        FROM staging_rows
        WHERE import_job_id = ${crosswalkBatch.importJobId}
          AND target_table = 'jdy_tmall_sku_crosswalk_observation'
          AND status IN ('pending', 'validated', 'committed')
        GROUP BY 1, 2
      `)
      : Promise.resolve([]),
    db.execute(sql`
      SELECT i.value, i.sku_id, s.code AS sku_code FROM sku_identifiers i
      INNER JOIN skus s ON s.id = i.sku_id
      WHERE i.kind = 'external' AND i.scope = ${PLATFORM_SKU_IDENTIFIER_SCOPE} AND i.active = true
    `),
    db.execute(sql`
      SELECT id, raw_value, status FROM alias_exceptions
      WHERE alias_type = 'sku_barcode' AND scope = 'JIANDAOYUN'
    `),
    db.execute(sql`
      SELECT s.id, s.code, s.name, s.spec, s.sku_type, b.code AS brand_code
      FROM skus s LEFT JOIN brands b ON b.id = s.brand_id
      WHERE s.active = true
    `),
    db.execute(sql`SELECT code, name_cn, name_en FROM brands`),
  ]);

  const refunds = new Map<string, number>();
  for (const row of resultRows<Record<string, unknown>>(refundResult)) {
    refunds.set(`${textValue(row.shop_name)}|${textValue(row.platform_sku_id)}`, intValue(row.refund_qty));
  }
  const crosswalk = new Map<string, { barcode: string | null; merchantCode: string | null; skuId: number | null; conflicting: boolean }>();
  for (const row of resultRows<Record<string, unknown>>(crosswalkResult)) {
    const identityCount = intValue(row.identity_count);
    crosswalk.set(`${textValue(row.shop_name)}|${textValue(row.platform_sku_id)}`, {
      barcode: textValue(row.barcode),
      merchantCode: textValue(row.merchant_code),
      skuId: identityCount === 1 ? intValue(row.sku_id) || null : null,
      conflicting: identityCount > 1,
    });
  }
  const direct = new Map<string, { skuId: number; skuCode: string }>();
  for (const row of resultRows<Record<string, unknown>>(directResult)) {
    const value = textValue(row.value);
    if (value) direct.set(value, { skuId: intValue(row.sku_id), skuCode: String(row.sku_code ?? "") });
  }
  const exceptions = new Map<string, { id: number; status: PlatformSkuGapRow["exceptionStatus"] }>();
  for (const row of resultRows<Record<string, unknown>>(exceptionResult)) {
    const raw = textValue(row.raw_value);
    const status = row.status === "open" || row.status === "resolved" || row.status === "ignored" ? row.status : null;
    if (raw) exceptions.set(raw, { id: intValue(row.id), status });
  }
  const skuCodeById = new Map<number, string>();
  const candidateSource: SkuCandidateSource[] = [];
  const allSkus: SkuCandidateSource[] = [];
  for (const row of resultRows<Record<string, unknown>>(skuResult)) {
    const skuId = intValue(row.id);
    skuCodeById.set(skuId, String(row.code ?? ""));
    const entry = { skuId, code: String(row.code ?? ""), name: String(row.name ?? ""), brandCode: textValue(row.brand_code), spec: textValue(row.spec) };
    allSkus.push(entry);
    if (row.sku_type === "finished") candidateSource.push(entry);
  }
  const brands = resultRows<Record<string, unknown>>(brandResult).map((b) => ({
    code: String(b.code ?? ""), nameCn: textValue(b.name_cn), nameEn: textValue(b.name_en),
  }));
  const shopBrand = new Map<string, string | null>();

  const rows: PlatformSkuGapRow[] = [];
  let windowFrom: string | null = null;
  let windowTo: string | null = null;
  for (const raw of resultRows<Record<string, unknown>>(salesResult)) {
    const shopName = textValue(raw.shop_name);
    const platformSkuId = textValue(raw.platform_sku_id);
    if (!shopName || !platformSkuId) continue;
    const key = `${shopName}|${platformSkuId}`;
    if (!shopBrand.has(shopName)) shopBrand.set(shopName, brandCodeForShop(shopName, brands));
    const bridge = crosswalk.get(key);
    const claimed = direct.get(key);
    let status: PlatformSkuGapStatus;
    let skuId: number | null = null;
    if (bridge?.skuId) { status = "mapped"; skuId = bridge.skuId; }
    else if (claimed) { status = "direct_claimed"; skuId = claimed.skuId; }
    else if (!bridge) status = "not_in_crosswalk";
    else if (bridge.barcode && exceptions.get(bridge.barcode)?.status === "open") status = "barcode_claim_pending";
    else status = "crosswalk_without_code";
    const exception = bridge?.barcode ? exceptions.get(bridge.barcode) ?? null : null;
    const firstDate = textValue(raw.first_date);
    const lastDate = textValue(raw.last_date);
    if (firstDate && (!windowFrom || firstDate < windowFrom)) windowFrom = firstDate;
    if (lastDate && (!windowTo || lastDate > windowTo)) windowTo = lastDate;
    const productName = textValue(raw.product_name);
    const skuName = textValue(raw.sku_name);
    rows.push({
      shopName, platformSkuId, productName, skuName,
      specToken: extractSpecToken(skuName, productName),
      brandCode: shopBrand.get(shopName) ?? null,
      paidAmount: money(raw.paid_amount),
      paidQty: intValue(raw.paid_qty),
      refundQty: refunds.get(key) ?? 0,
      firstSoldDate: firstDate, lastSoldDate: lastDate,
      activeDays: intValue(raw.active_days),
      status, skuId,
      skuCode: skuId ? (skuCodeById.get(skuId) ?? claimed?.skuCode ?? null) : null,
      barcode: bridge?.barcode ?? null,
      exceptionId: exception?.id ?? null,
      exceptionStatus: exception?.status ?? null,
      candidates: [],
    });
  }
  rows.sort((a, b) => dCmp(b.paidAmount, a.paidAmount) || a.platformSkuId.localeCompare(b.platformSkuId));

  // 只给排在前面的缺口算候选：候选是给人看的，不是给全量算的
  const unmapped = rows.filter((r) => r.status !== "mapped" && r.status !== "direct_claimed");
  const skuByCode = new Map(allSkus.map((k) => [k.code, k]));
  const candidatesFor = (row: PlatformSkuGapRow): PlatformSkuGapCandidate[] => {
    const merchantCode = crosswalk.get(`${row.shopName}|${row.platformSkuId}`)?.merchantCode;
    const exact = merchantCode ? skuByCode.get(merchantCode) : undefined;
    const scored = scoreCandidates(row, candidateSource).filter((c) => c.skuId !== exact?.skuId);
    // 对照表里的商家编码与系统编码逐字相等：这是确定性线索（同步时未解析多因当时主档尚无此码），
    // 仍交人一键确认，不自动落库
    return exact
      ? [{ skuId: exact.skuId, code: exact.code, name: exact.name, score: 100, reasons: ["对照表商家编码精确命中系统编码"] }, ...scored].slice(0, MAX_CANDIDATES)
      : scored;
  };
  const exactHits: PlatformSkuIdentityGap["exactHits"] = [];
  for (const row of unmapped) {
    const merchantCode = crosswalk.get(`${row.shopName}|${row.platformSkuId}`)?.merchantCode;
    const exact = merchantCode ? skuByCode.get(merchantCode) : undefined;
    if (exact) exactHits.push({ shopName: row.shopName, platformSkuId: row.platformSkuId, skuId: exact.skuId, skuCode: exact.code, paidAmount: row.paidAmount });
  }
  const top = unmapped.slice(0, TOP_ROWS);
  for (const row of top) row.candidates = candidatesFor(row);
  const withCandidates = unmapped.slice(0, 200).map((r) => (r.candidates.length ? r : { ...r, candidates: candidatesFor(r) }));

  const zero = "0.00";
  const byStatus: PlatformSkuIdentityGap["totals"]["byStatus"] = {
    mapped: { skus: 0, paidAmount: zero },
    direct_claimed: { skus: 0, paidAmount: zero },
    crosswalk_without_code: { skus: 0, paidAmount: zero },
    barcode_claim_pending: { skus: 0, paidAmount: zero },
    not_in_crosswalk: { skus: 0, paidAmount: zero },
  };
  let paidAmount = zero;
  let mappedPaidAmount = zero;
  const shops = new Map<string, { paidAmount: string; mappedPaidAmount: string; platformSkus: number; unmappedSkus: number }>();
  for (const row of rows) {
    paidAmount = dAdd(paidAmount, row.paidAmount, 2);
    byStatus[row.status].skus++;
    byStatus[row.status].paidAmount = dAdd(byStatus[row.status].paidAmount, row.paidAmount, 2);
    const isMapped = row.status === "mapped" || row.status === "direct_claimed";
    if (isMapped) mappedPaidAmount = dAdd(mappedPaidAmount, row.paidAmount, 2);
    const shop = shops.get(row.shopName) ?? { paidAmount: zero, mappedPaidAmount: zero, platformSkus: 0, unmappedSkus: 0 };
    shop.paidAmount = dAdd(shop.paidAmount, row.paidAmount, 2);
    if (isMapped) shop.mappedPaidAmount = dAdd(shop.mappedPaidAmount, row.paidAmount, 2);
    shop.platformSkus++;
    if (!isMapped) shop.unmappedSkus++;
    shops.set(row.shopName, shop);
  }
  let exactHitAmount = zero;
  for (const hit of exactHits) exactHitAmount = dAdd(exactHitAmount, hit.paidAmount, 2);
  let coverableAmount = mappedPaidAmount;
  let unmappedWithCandidates = 0;
  for (const row of withCandidates) {
    if (row.candidates.length) { unmappedWithCandidates++; coverableAmount = dAdd(coverableAmount, row.paidAmount, 2); }
  }
  const pct = (part: string, whole: string): number | null =>
    dCmp(whole, zero) > 0 ? Math.round(Number(dDiv(part, whole, 6)) * 1000) / 10 : null;

  return {
    state: rows.length ? "ready" : "insufficient",
    authority: "observation_only",
    source: "JIANDAOYUN",
    platform: "天猫",
    gate: rows.length
      ? "观察口径：金额来自简道云天猫日销量批次的支付金额；候选只是建议，认领后才成为系统身份。"
      : "最新批次里没有可用的天猫 SKU 销量行。",
    sourceAsOf: salesBatch.sourceAsOf,
    crosswalkAsOf: crosswalkBatch?.sourceAsOf ?? null,
    window: { from: windowFrom, to: windowTo },
    totals: {
      platformSkus: rows.length,
      mappedSkus: byStatus.mapped.skus + byStatus.direct_claimed.skus,
      paidAmount,
      mappedPaidAmount,
      unmappedPaidAmount: dSub(paidAmount, mappedPaidAmount, 2),
      mappedAmountPct: pct(mappedPaidAmount, paidAmount),
      byStatus,
      unmappedWithCandidates,
      coverableAmountPct: pct(coverableAmount, paidAmount),
    },
    byShop: [...shops.entries()]
      .map(([shopName, s]) => ({
        shopName, brandCode: shopBrand.get(shopName) ?? null, paidAmount: s.paidAmount,
        mappedAmountPct: pct(s.mappedPaidAmount, s.paidAmount), platformSkus: s.platformSkus, unmappedSkus: s.unmappedSkus,
      }))
      .sort((a, b) => dCmp(b.paidAmount, a.paidAmount)),
    top,
    exactHits,
    exactHitAmountPct: pct(exactHitAmount, paidAmount),
    limitations: [
      "金额 = 简道云天猫日销量的支付金额，未扣退款、折让与平台费用；只用来排序谁最值得先认领。",
      "候选按店铺推断品牌，再比对规格与名称词元；分数只表示相似度，不表示归属，认领前必须人工核对。",
      "同一平台 SKU 在对照表里有多个系统 SKU 视为冲突，不给候选，交人裁决。",
      "认领只登记外部标识（kind=external, scope=JIANDAOYUN:TMALL），不改任何主档、库存或销量事实。",
    ],
  };
}

export function emptyPlatformSkuIdentityGap(gate: string): PlatformSkuIdentityGap {
  const zero = "0.00";
  const empty = { skus: 0, paidAmount: zero };
  return {
    state: "insufficient",
    authority: "observation_only",
    source: "JIANDAOYUN",
    platform: "天猫",
    gate,
    sourceAsOf: null,
    crosswalkAsOf: null,
    window: { from: null, to: null },
    totals: {
      platformSkus: 0, mappedSkus: 0, paidAmount: zero, mappedPaidAmount: zero, unmappedPaidAmount: zero,
      mappedAmountPct: null,
      byStatus: { mapped: { ...empty }, direct_claimed: { ...empty }, crosswalk_without_code: { ...empty }, barcode_claim_pending: { ...empty }, not_in_crosswalk: { ...empty } },
      unmappedWithCandidates: 0, coverableAmountPct: null,
    },
    byShop: [],
    top: [],
    exactHits: [],
    exactHitAmountPct: null,
    limitations: [gate],
  };
}

async function readModelBinding(db: ReadDb): Promise<string | null> {
  const [sales, refunds, crosswalk, direct] = await Promise.all([
    latestBatch(db, "tmall-sku-sales-observation"),
    latestBatch(db, "tmall-sku-refund-observation"),
    latestBatch(db, "tmall-sku-crosswalk-observation"),
    directIdentifierVersion(db),
  ]);
  if (!sales) return null;
  return `sales:${sales.importJobId}|refunds:${refunds?.importJobId ?? "none"}|crosswalk:${crosswalk?.importJobId ?? "none"}|${direct}`;
}

function cachedGap(value: unknown): PlatformSkuIdentityGap | null {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Partial<PlatformSkuIdentityGap>;
  return candidate.authority === "observation_only" && candidate.source === "JIANDAOYUN"
    && Array.isArray(candidate.top) && Array.isArray(candidate.byShop) && Array.isArray(candidate.exactHits) && candidate.totals != null
    ? candidate as PlatformSkuIdentityGap
    : null;
}
function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** 页面读取：命中精确绑定的缓存；未命中则现算并写入（单批 6.8 万行的 SQL 聚合约 0.5 s，可接受）。 */
export async function loadPlatformSkuIdentityGap(db: ReadDb): Promise<PlatformSkuIdentityGap> {
  const binding = await readModelBinding(db);
  if (!binding) return emptyPlatformSkuIdentityGap("缺少天猫日销量的成功批次，身份缺口保持关闭。");
  const cacheResult = await db.execute(sql`
    SELECT payload FROM report_read_model_cache
    WHERE key = ${READ_MODEL_CACHE_KEY} AND source_binding = ${binding}
    LIMIT 1
  `);
  const [row] = resultRows<Record<string, unknown>>(cacheResult);
  const cached = cachedGap(row?.payload);
  if (cached) return cached;
  return refreshPlatformSkuIdentityGap(db);
}

/** 重算并以精确绑定原子替换缓存；连接器同步与认领写路径都会调用。 */
export async function refreshPlatformSkuIdentityGap(db: ReadDb): Promise<PlatformSkuIdentityGap> {
  const binding = await readModelBinding(db);
  if (!binding) return emptyPlatformSkuIdentityGap("缺少天猫日销量的成功批次，身份缺口保持关闭。");
  const result = await computePlatformSkuIdentityGap(db);
  await db.execute(sql`
    INSERT INTO report_read_model_cache (key, source_binding, payload, built_at)
    VALUES (${READ_MODEL_CACHE_KEY}, ${binding}, ${JSON.stringify(result)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET
      source_binding = excluded.source_binding,
      payload = excluded.payload,
      built_at = excluded.built_at
  `);
  return result;
}
