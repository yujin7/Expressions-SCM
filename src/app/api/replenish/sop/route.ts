import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, guardRead, readJson } from "@/server/modules/master/common";
import {
  changeSopPlan,
  createSopCycle,
  decideSopCycle,
  executeFrozenPlan,
  getFrozenPlanExecution,
  getSopWorkspace,
  transitionSopCycle,
} from "@/server/modules/replenish/sop-cycle";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    month: z.string(),
    name: z.string(),
    planningVersionId: z.number(),
    idempotencyKey: z.string(),
  }),
  z.object({
    action: z.literal("change_plan"),
    cycleId: z.number(),
    version: z.number(),
    planningVersionId: z.number(),
  }),
  z.object({
    action: z.literal("decide"),
    cycleId: z.number(),
    version: z.number(),
    role: z.enum(["ops", "pmc", "finance"]),
    decision: z.enum(["agree", "reject"]),
    note: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal("transition"),
    cycleId: z.number(),
    version: z.number(),
    target: z.enum(["frozen", "executing", "closed"]),
  }),
  /* W2-#4：冻结版本的执行通道。冻结让实时建议只读，却一直没有出口——
     执行于是发生在系统外。数量只能来自冻结版本的行，人工闸与审批链与实时路径完全一致。 */
  z.object({
    action: z.literal("execute_draft"),
    cycleId: z.number(),
    skuIds: z.array(z.number()).optional(),
    includeSuppressed: z.boolean().optional(),
    remark: z.string().optional(),
  }),
]);

/** GET：工作台；带 ?cycleId= 时返回该冻结周期的可执行行与已开单据（W2-#4）。 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const cycleId = Number(new URL(req.url).searchParams.get("cycleId"));
    if (Number.isInteger(cycleId) && cycleId > 0) {
      return NextResponse.json(await getFrozenPlanExecution(user, cycleId));
    }
    return NextResponse.json(await getSopWorkspace(user));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const input = actionSchema.parse(await readJson(req));
    if (input.action === "create") await createSopCycle(user, input);
    if (input.action === "change_plan") await changeSopPlan(user, input);
    if (input.action === "decide") await decideSopCycle(user, input);
    if (input.action === "transition") await transitionSopCycle(user, input);
    if (input.action === "execute_draft") {
      const draft = await executeFrozenPlan(user, input);
      return NextResponse.json({ ...(await getSopWorkspace(user)), draft }, { status: 201 });
    }
    return NextResponse.json(await getSopWorkspace(user));
  } catch (error) {
    return errorResponse(error);
  }
}
