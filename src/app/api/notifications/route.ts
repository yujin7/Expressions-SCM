import { NextRequest, NextResponse } from "next/server";
import { desc, inArray } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { notifications } from "@/db/schema";
import { errorResponse, guardRead } from "@/server/modules/master/common";

/** #8 站内通知列表（只读；已发/待发的应用内通知） */
export async function GET(_req: NextRequest) {
  try {
    await guardRead();
    const db = await getDbAsync();
    const rows = await db
      .select()
      .from(notifications)
      .where(inArray(notifications.status, ["pending", "sent", "skipped", "failed"]))
      .orderBy(desc(notifications.id))
      .limit(100);
    return NextResponse.json({ rows });
  } catch (e) {
    return errorResponse(e);
  }
}
