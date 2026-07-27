import { NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { isBatchPostingEnabled } from "@/server/modules/inventory/batch-allocation";

export async function GET() {
  try {
    await guardRead();
    return NextResponse.json({ enabled: await isBatchPostingEnabled(await getDbAsync()) });
  } catch (e) {
    return errorResponse(e, { path: "/api/inventory/batch-posting/status", method: "GET" });
  }
}
