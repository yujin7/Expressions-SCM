import { sql, type SQL } from "drizzle-orm";

/**
 * 单据列表搜索：让搜索框除单号外也能命中 SKU 编码/名称。
 *
 * 为什么需要：0727 会议定了「选 2 款产品从下单环节开始跑全流程」的试点，
 * 但九个单据列表此前只能按单号搜——试点产品的单据无法一次圈出来，
 * 只能顺着链路视图一单一单点。跑全流程的前提是能按产品把单据找齐。
 *
 * 口径统一放这里，避免九个服务各写一份 ILIKE 造成搜索行为不一致
 * （共享层唯一权威，禁止本地重实现）。
 *
 * 安全：表名/列名是本文件内的硬编码字面量，只有用户输入走参数化占位符。
 */

/** 明细行挂 SKU 的单据（BH/PO/FL/TL/SH/CT）：EXISTS 子查询，避免 join 放大行数。 */
export function skuLineMatch(
  lineTable: string,
  foreignKeyColumn: string,
  docIdColumn: SQL | unknown,
  q: string,
): SQL {
  const pattern = `%${q}%`;
  return sql`EXISTS (
    SELECT 1 FROM ${sql.raw(lineTable)} dl
    JOIN skus ds ON ds.id = dl.sku_id
    WHERE dl.${sql.raw(foreignKeyColumn)} = ${docIdColumn}
      AND (ds.code ILIKE ${pattern} OR ds.name ILIKE ${pattern})
  )`;
}

/** 表头直接挂 SKU 的单据（WO/JG 的 product_sku_id）。 */
export function skuHeaderMatch(skuIdColumn: SQL | unknown, q: string): SQL {
  const pattern = `%${q}%`;
  return sql`EXISTS (
    SELECT 1 FROM skus ds
    WHERE ds.id = ${skuIdColumn}
      AND (ds.code ILIKE ${pattern} OR ds.name ILIKE ${pattern})
  )`;
}

/** 单据列表搜索框的统一占位符——提示里必须写明能搜什么，否则功能等于不存在。 */
export const DOC_SEARCH_PLACEHOLDER = "搜索单号 / SKU 编码 / 货品名称";

/**
 * 制单时间窗（上海业务日 YYYY-MM-DD，含首尾）→ timestamptz 条件。
 * 全链漏斗把「计划/下单/到货」三级按单据创建时间窗回链到 BH/WO/SH 列表，三处列表共用这一条口径，
 * 不得再各写一份时区换算（上海业务日唯一权威 core/business-day，此处只做 SQL 绑定）。
 * 非法日期串直接忽略（不猜、不 500）。
 */
const YMD = /^\d{4}-\d{2}-\d{2}$/;
export function createdWithinShanghaiDays(column: SQL | unknown, from: string | undefined, to: string | undefined): SQL[] {
  const conds: SQL[] = [];
  if (from && YMD.test(from)) conds.push(sql`${column} >= ((${from})::date)::timestamp AT TIME ZONE 'Asia/Shanghai'`);
  if (to && YMD.test(to)) conds.push(sql`${column} < (((${to})::date + 1))::timestamp AT TIME ZONE 'Asia/Shanghai'`);
  return conds;
}
