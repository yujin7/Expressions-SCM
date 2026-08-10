/**
 * 源时点（sourceAsOf）的取值纪律：**不让脏的未来日期污染整批数据的时点**。
 *
 * 事故背景（2026-08-04 实测）：简道云真实数据里存在录入错误造成的未来日期——
 * `Pdd_X.04_百亿报名记录` 最新时间是 **2051-07-31**，
 * `CW_A.05_dd_绍兴保税仓_保税订单` 是 **2028-11-12**。
 *
 * 而各同步器的 sourceAsOf 都取"记录里最大的更新时间"。一条 2051 的脏行，
 * 就会让整批的 sourceAsOf 变成 2051，后果不只是页面显示难看：
 *   - `month-close.ts` 用 sourceAsOf 做 `gte/lt` 月份区间过滤 —— 该批次会被
 *     **排除在每一个合法月份之外**，月结证据里静默缺失；
 *   - 数据新鲜度看门狗会认为这批数据永远"新鲜"，再也不告警。
 *
 * 处理口径：**忽略**超出容差的未来时点（而不是整批拒绝，也不是钳到当前时间）——
 *   - 整批拒绝：一条脏行就阻断同步，代价过大；
 *   - 钳到 now：等于把脏数据伪装成"刚更新"，把问题藏起来；
 *   - 忽略：其余记录仍能给出真实时点，且脏行数量被显式报出，可以去源头修。
 */

/** 时区/时钟偏差容差：源系统按本地时区写入时可能比 UTC now 早一点点 */
const DEFAULT_SKEW_MS = 36 * 60 * 60 * 1_000; // 36 小时

export interface SourceAsOfResult {
  /** 排除异常未来时点后的最大时点；全部无效则为 null */
  sourceAsOf: string | null;
  /** 被忽略的未来时点条数——非零即说明源头有脏数据，应报出而非吞掉 */
  futureIgnored: number;
  /** 被忽略的最大未来时点，便于定位是哪条 */
  futureMax: string | null;
}

/**
 * 从一组时间字符串里取合理的最大时点。
 *
 * @param values 原始时间字符串（可含 null/空/非法，均安全跳过）
 * @param now 判定"未来"的基准
 * @param skewMs 容差，默认 36 小时
 */
export function resolveSourceAsOf(
  values: readonly (string | null | undefined)[],
  now: Date = new Date(),
  skewMs: number = DEFAULT_SKEW_MS,
): SourceAsOfResult {
  const ceiling = now.getTime() + skewMs;
  let latest: number | null = null;
  let futureIgnored = 0;
  let futureMax: number | null = null;

  for (const raw of values) {
    const instant = Date.parse(String(raw ?? "").trim());
    if (!Number.isFinite(instant)) continue;
    if (instant > ceiling) {
      futureIgnored++;
      if (futureMax === null || instant > futureMax) futureMax = instant;
      continue;
    }
    if (latest === null || instant > latest) latest = instant;
  }

  return {
    sourceAsOf: latest === null ? null : new Date(latest).toISOString(),
    futureIgnored,
    futureMax: futureMax === null ? null : new Date(futureMax).toISOString(),
  };
}
