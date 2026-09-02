import { sql, type SQL } from "drizzle-orm";

/**
 * 拼多多需求观察的唯一订单资格口径。
 *
 * paymentTime 是最强证据；历史数据可能未回填该字段，因此仅对明确已支付的
 * 订单状态做兼容。待付款、取消、退款成功均不得进入销速或渠道件数。
 */
export const PDD_CONFIRMED_PAID_STATUS_HINTS = ["待发货", "已发货", "待收货", "已收货", "交易成功", "已完成"] as const;
export const PDD_EXCLUDED_STATUS_HINTS = ["取消", "退款成功"] as const;

export interface PddDemandStatus {
  paymentTime?: string | null;
  orderStatus?: string | null;
  afterSalesStatus?: string | null;
}

export function isPddDemandEligible(input: PddDemandStatus): boolean {
  const orderStatus = input.orderStatus?.trim() ?? "";
  const afterSalesStatus = input.afterSalesStatus?.trim() ?? "";
  const excluded = PDD_EXCLUDED_STATUS_HINTS.some(
    (hint) => orderStatus.includes(hint) || afterSalesStatus.includes(hint),
  );
  if (excluded) return false;
  if (input.paymentTime?.trim()) return true;
  return PDD_CONFIRMED_PAID_STATUS_HINTS.some((hint) => orderStatus.includes(hint));
}

/** SQL 与纯函数共用同一组状态常量，避免两张读模型口径漂移。 */
export function pddDemandEligibilitySql(columns: {
  paymentTime: SQL;
  orderStatus: SQL;
  afterSalesStatus: SQL;
}): SQL {
  const confirmedPaid = sql.join(
    PDD_CONFIRMED_PAID_STATUS_HINTS.map((hint) => sql`${columns.orderStatus} LIKE ${`%${hint}%`}`),
    sql` OR `,
  );
  const excluded = sql.join(
    PDD_EXCLUDED_STATUS_HINTS.flatMap((hint) => [
      sql`${columns.orderStatus} LIKE ${`%${hint}%`}`,
      sql`${columns.afterSalesStatus} LIKE ${`%${hint}%`}`,
    ]),
    sql` OR `,
  );
  return sql`
    (nullif(trim(${columns.paymentTime}), '') IS NOT NULL OR (${confirmedPaid}))
    AND NOT (${excluded})
  `;
}
