/**
 * 聚水潭仓库可信范围。
 *
 * 业务事实（2026-08-04 用户口径）：**聚水潭里只有「一仓」的数据是准的，其余仓不准。**
 *
 * 这条事实必须落到代码里，不能只写在文档里，原因是两个数据流的"粒度"不同：
 *
 *  1. **出库单流**（`/open/orders/out/simple/query`）逐单带仓库信息 ——
 *     可以按可信仓过滤，只取准的那部分；
 *  2. **库存流**（`/open/inventory/query`）**不带 wms_co_id 时返回的是全仓合计** ——
 *     一个把准仓和不准仓加在一起的数字。这种数字比两者单独存在**更危险**：
 *     它看起来是个完整的库存总量，实际混了已知不准的部分，且无法拆开。
 *
 * 所以纪律是：
 *  - 可信仓清单为空时，出库单流按"全部不可信"处理（宁可不取，不取错）；
 *  - 库存流在**无法按仓过滤**的情况下一律不得启用——这不是配置问题，是口径问题，
 *    加再多环境变量也变不出可信的数字。
 */

/** 环境变量：可信仓的 wms_co_id 列表（英文逗号分隔） */
export const TRUSTED_WMS_ENV = "JST_TRUSTED_WMS_CO_IDS";

export interface JstWarehouseTrust {
  /** 可信仓 wms_co_id 集合；空集表示"没有任何仓被确认为准" */
  trusted: ReadonlySet<string>;
  /** 是否已明确声明过可信范围 */
  declared: boolean;
  /** 显式声明「全部仓都准」（值为 ALL）——这是唯一能放行全仓合计的情况 */
  allTrusted: boolean;
}

export function jstWarehouseTrustFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JstWarehouseTrust {
  const raw = env[TRUSTED_WMS_ENV]?.trim() ?? "";
  const allTrusted = raw.toUpperCase() === "ALL";
  const trusted = new Set(
    allTrusted
      ? []
      : raw.split(",").map((part) => part.trim()).filter((part) => part !== ""),
  );
  return { trusted, declared: raw !== "", allTrusted };
}

/** 该仓的数据能否作为事实使用 */
export function isTrustedWarehouse(
  wmsCoId: string | number | null | undefined,
  trust: JstWarehouseTrust,
): boolean {
  if (wmsCoId === null || wmsCoId === undefined) return false;
  const value = String(wmsCoId).trim();
  if (value === "") return false;
  if (trust.allTrusted) return true;
  return trust.trusted.has(value);
}

/**
 * 库存流是否允许启用。
 *
 * 只要**存在已知不准的仓**（即声明了可信范围，说明并非所有仓都准），
 * 而该接口又只能给全仓合计，就必须拒绝——合计里混着不准的部分，且拆不开。
 * 返回 null 表示允许，否则返回拒绝理由。
 */
export function inventoryStreamBlockReason(
  trust: JstWarehouseTrust,
): string | null {
  if (!trust.declared) {
    return `未声明 ${TRUSTED_WMS_ENV}：在确认哪些仓的数据可信之前，`
      + `不能把聚水潭库存当作事实——未知不等于全部可信。`;
  }
  // 只有显式声明「全部仓都准」时，全仓合计才是可用的数字
  if (trust.allTrusted) return null;
  return `聚水潭库存接口在不带 wms_co_id 时返回**全仓合计**，`
    + `而当前已声明只有 ${[...trust.trusted].join("、")} 可信，其余仓已知不准。`
    + `合计数字混入了不准的仓且无法拆分，看起来却像一个完整库存总量——`
    + `这比没有数字更危险。除非改为逐仓拉取，否则本流不得启用。`;
}
