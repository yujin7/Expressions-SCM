/**
 * 过账错误码 → HTTP 路由表（**唯一权威**，零依赖纯常量模块）。
 *
 * 事故形态（W2 复审 C1）：`post.ts` 抛 `CLOSED_PERIOD` 时精心写了指引
 * （「纠错请按当前开放期间做红字冲销，或由管理员先重开该期间」），
 * 可 `master/common.errorResponse` 的放行名单是**手抄的三条字面量**
 * `["NEGATIVE_STOCK","SNAPSHOT_WAREHOUSE","LOCATED_STOCK"]`，漏了它。
 * 于是每一次期间锁拒绝都变成带 errorId 的 500、进 `error_logs` 的「未预期错误」，
 * 用户看到的是「系统错误，请联系管理员」——真正的原因被丢掉。
 *
 * 修法只有一种：路由表与错误码**同一处定义**，用 `Record<PostingErrorCode, …>` 强制穷举
 * （新增错误码不登记 → tsc 直接红），再由 `tests/posting/error-routing.test.ts` 在运行时复核。
 * 调用点不得再写第二份名单。
 *
 * 分档理由：
 * - 409（业务冲突，回显原文）：负库存、快照仓、库位占用、期间锁——都是**用户能读懂也能处置**的拒绝；
 * - 500（编程错误，落 error_logs）：空事件、未注册来源——调用方装配错了，不该把内部细节丢给用户。
 */

/** 过账错误码全集（`PostingErrorCode` 由本数组派生，运行时可枚举） */
export const POSTING_ERROR_CODES = [
  "NEGATIVE_STOCK",
  "EMPTY_EVENT",
  "UNREGISTERED_SOURCE",
  "SNAPSHOT_WAREHOUSE",
  "LOCATED_STOCK",
  "CLOSED_PERIOD",
  "EXPIRED_BATCH",
  "BATCH_IDENTITY",
] as const;

export type PostingErrorCode = (typeof POSTING_ERROR_CODES)[number];

/**
 * 每个错误码的 HTTP 归属。`Record<PostingErrorCode, …>` 是**编译期穷举门**：
 * 往 `POSTING_ERROR_CODES` 里加一个码而不在这里登记，`tsc` 立刻红。
 */
export const POSTING_ERROR_HTTP_STATUS: Record<PostingErrorCode, 409 | 500> = {
  NEGATIVE_STOCK: 409,
  SNAPSHOT_WAREHOUSE: 409,
  LOCATED_STOCK: 409,
  CLOSED_PERIOD: 409,
  EXPIRED_BATCH: 409,
  BATCH_IDENTITY: 409,
  EMPTY_EVENT: 500,
  UNREGISTERED_SOURCE: 500,
};

/** 该错误码是否回显给用户（409 业务冲突）；false = 走未预期 500 收口 */
export function isUserFacingPostingError(code: string): code is PostingErrorCode {
  return Object.hasOwn(POSTING_ERROR_HTTP_STATUS, code)
    && POSTING_ERROR_HTTP_STATUS[code as PostingErrorCode] === 409;
}
