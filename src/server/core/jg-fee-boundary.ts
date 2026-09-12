import { eq } from "drizzle-orm";
import { jsDocs } from "@/db/schema";
import { ApiError } from "@/server/modules/master/common";
import type { AnyDb } from "./svc";

/** Caller holds the JG row lock, also used by JS creation/submission/approval/fee refresh. */
export async function assertJgFeeMutable(tx: AnyDb, jgId: number) {
  const [settlement]: { docNo: string; status: string }[] = await tx.select({ docNo: jsDocs.docNo, status: jsDocs.status })
    .from(jsDocs).where(eq(jsDocs.jgId, jgId));
  if (settlement && !["draft", "pending"].includes(settlement.status)) {
    throw new ApiError(409, `结算单 ${settlement.docNo} 已冻结，不可再改JG加工费；请联系财务核对差额调整`);
  }
}
