import { ApiError } from "./common";
import { log } from "@/server/core/logger";

/** A lost commit acknowledgement is not proof of rollback. Never expose SQL/parameters to clients. */
export function identityBulkError(error: unknown, context: { operation: "claim" | "barcode"; userId: number; skuId: number }) {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return { error: error.message, errorKind: "business" as const };
  }
  const errorId = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  let cause = error;
  let sqlState: string | undefined;
  for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth++) {
    const detail = cause as { code?: unknown; cause?: unknown };
    if (typeof detail.code === "string" && /^[A-Z0-9]{5}$/.test(detail.code)) sqlState = detail.code;
    cause = detail.cause;
  }
  log({ level: "error", msg: "身份批量操作结果未确认", errorId, ...context, sqlState });
  return {
    error: `结果未确认（错误码 ${errorId}）；请先核对当前归属，勿重复提交`,
    errorKind: "unconfirmed" as const,
    errorId,
  };
}
