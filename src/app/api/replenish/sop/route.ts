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
  getSopExecutionResult,
  getSopCycleCreationResult,
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
    /* 幂等键：双击此前会得到两张内容相同的 BH 草稿一起进审批链（S2） */
    idempotencyKey: z.string(),
    skuIds: z.array(z.number()).optional(),
    includeSuppressed: z.boolean().optional(),
    remark: z.string().optional(),
  }),
]);

/** GET: workspace, cycle history, or a read-only account-owned request receipt. */
export async function GET(req: NextRequest) {
  try {
    const params = new URL(req.url).searchParams;
    const query = z.object({ cycleId: z.coerce.number().int().positive().max(2147483647).optional(), requestKey: z.string().uuid().optional(), createRequestKey: z.string().uuid().optional(), workspaceCycleId: z.coerce.number().int().positive().max(2147483647).optional() }).strict()
      .refine(v => Object.values(v).filter(value => value !== undefined).length <= 1, "只能选择一种周期或请求查询")
      .parse(Object.fromEntries(params));
    if (["cycleId", "requestKey", "createRequestKey", "workspaceCycleId"].some(key => params.getAll(key).length > 1)) {
      return NextResponse.json({ error: "查询条件不能重复" }, { status: 400 });
    }
    if (query.createRequestKey !== undefined) {
      const user = await getFreshSessionUser();
      return NextResponse.json(await getSopCycleCreationResult(user, query.createRequestKey), { headers: { "Cache-Control": "private, no-store" } });
    }
    if (query.requestKey !== undefined) {
      const user = await getFreshSessionUser();
      return NextResponse.json(await getSopExecutionResult(user, query.requestKey), { headers: { "Cache-Control": "private, no-store" } });
    }
    const user = await guardRead();
    if (query.cycleId !== undefined) {
      return NextResponse.json(await getFrozenPlanExecution(user, query.cycleId));
    }
    return NextResponse.json(await getSopWorkspace(user, undefined, query.workspaceCycleId === undefined ? undefined : { id: query.workspaceCycleId, only: false }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const input = actionSchema.parse(await readJson(req));
    if (input.action === "create") {
      const cycle = await createSopCycle(user, input);
      return NextResponse.json({ requestKey: input.idempotencyKey.toLowerCase(), cycle: { id: cycle.id,
        month: cycle.month, name: cycle.name, status: cycle.status, version: cycle.version, planningVersionId: cycle.planningVersionId } },
      { status: 201, headers: { "Cache-Control": "private, no-store" } });
    }
    if (input.action === "change_plan") await changeSopPlan(user, input);
    if (input.action === "decide") await decideSopCycle(user, input);
    if (input.action === "transition") await transitionSopCycle(user, input);
    if (input.action === "execute_draft") {
      const draft = await executeFrozenPlan(user, input);
      // Do not turn a committed document into a 500 if an unrelated workspace refresh fails.
      return NextResponse.json({ requestKey: input.idempotencyKey.toLowerCase(), draft }, { status: 201 });
    }
    return NextResponse.json(await getSopWorkspace(user));
  } catch (error) {
    return errorResponse(error);
  }
}
