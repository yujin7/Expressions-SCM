import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { systemAlerts } from "@/db/schema";
import { errorResponse, guardRead } from "@/server/modules/master/common";

/** struct#15 系统告警（看门狗产出，与人工裁决 review_items 分家）；默认 open */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const db = await getDbAsync();
    const status = new URL(req.url).searchParams.get("status") ?? "open";
    const rows = await db
      .select()
      .from(systemAlerts)
      .where(eq(systemAlerts.status, status))
      .orderBy(desc(systemAlerts.id))
      .limit(200);
    return NextResponse.json({ rows });
  } catch (e) {
    return errorResponse(e);
  }
}
