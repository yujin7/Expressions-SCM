import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { users } from "@/db/schema";
import { errorResponse, guardRead } from "@/server/modules/master/common";

/** 待办责任人选择器：在职用户 id/name/roles（不含账号、绑定等敏感字段） */
export async function GET() {
  try {
    await guardRead();
    const db = await getDbAsync();
    const rows = await db
      .select({ id: users.id, name: users.name, roles: users.roles })
      .from(users)
      .where(eq(users.active, true))
      .orderBy(users.name);
    return NextResponse.json({ rows });
  } catch (error) {
    return errorResponse(error, { path: "/api/todo/assignees", method: "GET" });
  }
}
