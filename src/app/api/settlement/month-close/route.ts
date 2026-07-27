import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse, guardRead, readJson } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import {
  getMonthCloseChecklist,
  updateMonthCloseCheck,
} from "@/server/modules/settlement/month-close";

const updateSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  checkKey: z.enum([
    "data_release",
    "operational_docs",
    "inventory_count",
    "jst_reconciliation",
    "borrow_reconciliation",
    "settlement_close",
  ]),
  status: z.enum(["pending", "completed", "waived"]),
  note: z.string().max(500).nullable().optional(),
  version: z.number().int().min(0),
});

export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    requireAnyRole(user, "finance", "pmc");
    const month = new URL(req.url).searchParams.get("month") ?? "";
    return NextResponse.json(await getMonthCloseChecklist(month));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const input = updateSchema.parse(await readJson(req));
    return NextResponse.json(await updateMonthCloseCheck(user, input, undefined));
  } catch (error) {
    return errorResponse(error);
  }
}
