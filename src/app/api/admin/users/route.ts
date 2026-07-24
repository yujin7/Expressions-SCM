import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { errorResponse } from "@/server/modules/master/common";
import { createUser, guardAdmin, listUsers } from "@/server/modules/admin/users";

/** 用户列表（仅 admin；passwordHash 永不出此边界） */
export async function GET() {
  try {
    const user = await getFreshSessionUser();
    guardAdmin(user);
    return NextResponse.json({ rows: await listUsers() });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 建号（仅 admin） */
export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    return NextResponse.json(await createUser(user, await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
