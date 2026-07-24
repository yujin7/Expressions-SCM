import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { users } from "@/db/schema";
import { errorResponse, guardRead } from "@/server/modules/master/common";

/**
 * 当前用户（角色感知 UI 的数据源——UX 走查 Top-4）。
 * mustChangePassword 必须回查 DB（token 内无此位；管理员重置密码须即时生效——UAT 缺口 #1）。
 */
export async function GET() {
  try {
    const user = await guardRead();
    const db = await getDbAsync();
    const [row] = await db
      .select({ mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, user.id));
    return NextResponse.json({
      id: user.id,
      name: user.name,
      roles: user.roles,
      isApprover: user.isApprover,
      mustChangePassword: row?.mustChangePassword ?? false,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
