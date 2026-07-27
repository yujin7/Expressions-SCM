import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { errorResponse, readJson } from "@/server/modules/master/common";
import {
  activateBatchPosting,
  getBatchRolloutReport,
} from "@/server/modules/inventory/batch-rollout";

export async function GET() {
  try {
    const user = await getFreshSessionUser();
    requireRole(user, "pmc", "purchasing", "finance");
    return NextResponse.json(await getBatchRolloutReport(await getDbAsync()));
  } catch (e) {
    return errorResponse(e, { path: "/api/admin/batch-posting", method: "GET" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const db = await getDbAsync();
    return NextResponse.json(await activateBatchPosting(user, await readJson(req), db));
  } catch (e) {
    return errorResponse(e, { path: "/api/admin/batch-posting", method: "POST" });
  }
}
