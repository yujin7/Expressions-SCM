import { and, eq, notInArray } from "drizzle-orm";
import { jsDocs } from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";
import type { AnyDb } from "./svc";

export const MUTABLE_JG_SETTLEMENT_STATUSES = ["draft", "pending"] as const;

/** Caller holds the JG lock for writes; shared with return eligibility and fee changes. */
export async function getFrozenJgSettlement(tx: AnyDb, jgId: number) {
  const [settlement]: { docNo: string; status: string }[] = await tx.select({ docNo: jsDocs.docNo, status: jsDocs.status })
    .from(jsDocs).where(and(eq(jsDocs.jgId, jgId), notInArray(jsDocs.status, [...MUTABLE_JG_SETTLEMENT_STATUSES])));
  return settlement;
}

/** Caller holds the JG row lock, also used by JS creation/submission/approval/fee refresh. */
export async function assertJgFeeMutable(tx: AnyDb, jgId: number) {
  const settlement = await getFrozenJgSettlement(tx, jgId);
  if (settlement) {
    throw new ApiError(409, `结算单 ${settlement.docNo} 已冻结，不可再改JG加工费；请联系财务核对差额调整`);
  }
}
