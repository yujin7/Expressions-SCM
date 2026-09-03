import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDbAsync } from "@/db";
import { getFreshSessionUser, maskSensitive } from "@/server/core/dto";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { closeReview, generateReviewPackAs, listReviews, resolveCadence } from "@/server/modules/dq/reviews";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";

const VIEW_ROLES = ["pmc", "finance", "warehouse", "purchasing"];

const listSchema = z.object({
  periodKind: z.enum(["week", "month"]).optional(),
  periodKey: z.string().trim().min(1).optional(),
  status: z.enum(["pending", "completed", "waived"]).optional(),
  sourceClass: z.enum(["rpa_warehouse", "manual_po_chain", "external_platform"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate"), periodKind: z.enum(["week", "month"]).optional(), periodKey: z.string().trim().min(1).optional() }),
  z.object({ action: z.literal("complete"), id: z.number().int().positive(), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("waive"), id: z.number().int().positive(), note: z.string().trim().min(1).max(500) }),
]);

/** D65 周/月核对清单：GET 列表（含当前节奏裁决）；POST generate / complete / waive（写守卫 getFreshSessionUser + service 内角色校验 + writeAudit）；出口一律 maskSensitive */
export async function GET(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, ...VIEW_ROLES);
    const db = await getDbAsync();
    const url = new URL(req.url);
    const q = listSchema.parse(Object.fromEntries(url.searchParams.entries()));
    const [list, cadence] = await Promise.all([listReviews(db, q), resolveCadence(db)]);
    const response = NextResponse.json(maskSensitive({ ...list, cadence }, user.roles));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return errorResponse(error, { path: "/api/dq/reviews", method: "GET" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const body = postSchema.parse(await readJson(req));
    const db = await getDbAsync();
    if (body.action === "generate") {
      return NextResponse.json(maskSensitive(await generateReviewPackAs(user, { periodKind: body.periodKind, periodKey: body.periodKey }, db), user.roles));
    }
    const status = body.action === "complete" ? "completed" : "waived";
    return NextResponse.json(maskSensitive(await closeReview(user, body.id, { status, note: body.note }, db), user.roles));
  } catch (error) {
    return errorResponse(error, { path: "/api/dq/reviews", method: "POST" });
  }
}
