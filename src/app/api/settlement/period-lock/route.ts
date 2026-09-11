import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, guardRead, readJson } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { closePeriod, listClosedPeriods, reopenPeriod } from "@/server/modules/settlement/period-lock";

const bodySchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("close"),
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    note: z.string().max(500).nullable().optional(),
  }),
  z.object({
    intent: z.literal("reopen"),
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    reason: z.string().min(5).max(500),
  }),
]);

/** 已关账期间清单（财务/PMC 可见） */
export async function GET() {
  try {
    const user = await guardRead();
    requireAnyRole(user, "finance", "pmc");
    return NextResponse.json({ rows: await listClosedPeriods() });
  } catch (error) {
    return errorResponse(error, { path: "/api/settlement/period-lock", method: "GET" });
  }
}

/**
 * 关账（财务，六项检查全部收口后）/ 重开（仅管理员，必须留原因）。
 * 两者都在服务层同一事务写审计；期间锁生效后过账引擎直接拒绝该期间的过账。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const body = bodySchema.parse(await readJson(req));
    if (body.intent === "reopen") {
      return NextResponse.json(await reopenPeriod(user, { period: body.period, reason: body.reason }));
    }
    return NextResponse.json(await closePeriod(user, { period: body.period, note: body.note ?? null }));
  } catch (error) {
    return errorResponse(error, { path: "/api/settlement/period-lock", method: "POST" });
  }
}
