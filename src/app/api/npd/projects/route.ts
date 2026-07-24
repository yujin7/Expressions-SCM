import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createNpdProject, getNpdProject, listNpdProjects, updateNpdProject } from "@/server/modules/npd/service";

/** NPD 项目：GET 列表 / ?id= 详情；POST 建项目（模板实例化）；PATCH 项目状态 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const id = new URL(req.url).searchParams.get("id");
    if (id) return NextResponse.json(await getNpdProject(Number(id)));
    return NextResponse.json({ projects: await listNpdProjects() });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(await createNpdProject(user, await req.json()), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    return NextResponse.json(await updateNpdProject(user, await req.json()));
  } catch (e) {
    return errorResponse(e);
  }
}
