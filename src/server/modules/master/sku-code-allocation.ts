import { eq, sql } from "drizzle-orm";

import { schema } from "@/db";
import {
  generateGovernedSkuCode,
  normalizeSkuOrigin,
  type GovernedSkuType,
} from "@/server/rules/sku-code";

import { ApiError } from "./common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- allocator is transaction-owned and supports both PGlite and PostgreSQL Drizzle transactions
type AnyTx = any;

/**
 * Allocate one S1 code inside the caller's transaction.
 *
 * The doc counter increment, collision check, SKU insert and any identifier/audit rows must all
 * commit or roll back together. Callers must not invoke this for previews: a dry-run never consumes
 * a permanent identity and never guesses which sequence another transaction will receive.
 */
export async function allocateGovernedSkuCode(
  tx: AnyTx,
  brandCode: string | null,
  skuType: GovernedSkuType,
): Promise<string> {
  const origin = normalizeSkuOrigin(brandCode);
  for (let guard = 0; guard < 100_000; guard++) {
    const [counter] = await tx
      .insert(schema.docCounters)
      .values({ prefix: "SKU-S1", bizDate: "GLOBAL", lastNo: 1 })
      .onConflictDoUpdate({
        target: [schema.docCounters.prefix, schema.docCounters.bizDate],
        set: { lastNo: sql`${schema.docCounters.lastNo} + 1` },
      })
      .returning({ lastNo: schema.docCounters.lastNo });
    const code = generateGovernedSkuCode({ origin, skuType, sequence: counter.lastNo });
    const [duplicate] = await tx
      .select({ id: schema.skus.id })
      .from(schema.skus)
      .where(eq(schema.skus.code, code));
    if (!duplicate) return code;
  }
  throw new ApiError(500, "SKU 取号异常：连续碰撞超过安全上限");
}
