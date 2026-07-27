import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, guardRead, readJson } from "@/server/modules/master/common";
import {
  changeSopPlan,
  createSopCycle,
  decideSopCycle,
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
]);

export async function GET() {
  try {
    return NextResponse.json(await getSopWorkspace(await guardRead()));
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
    return NextResponse.json(await getSopWorkspace(user));
  } catch (error) {
    return errorResponse(error);
  }
}
