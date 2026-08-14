import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { errorResponse, guardRead, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createNpdFirstOrder, createNpdProject, getNpdProject, listNpdProjects, rescheduleNpd, updateNpdProject, updateNpdProjectSkuCode } from "@/server/modules/npd/service";
import { loadJiandaoyunSupportingObservations } from "@/server/modules/report/jiandaoyun-supporting-observation";

/** NPD 项目：GET 列表 / ?id= 详情；POST 建项目（模板实例化）；PATCH 项目状态 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const id = new URL(req.url).searchParams.get("id");
    const db = await getDbAsync();
    if (id) return NextResponse.json(await getNpdProject(Number(id), db));
    const [projects, supportingObservations] = await Promise.all([
      listNpdProjects(db),
      loadJiandaoyunSupportingObservations(db),
    ]);
    return NextResponse.json({
      projects,
      supportingObservations: supportingObservations.filter((observation) =>
        observation.stream === "product-master-observation"
        || observation.stream === "sample-management-observation"),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const body = (await readJson(req)) as { intent?: string };
    if (body?.intent === "first_order") {
      return NextResponse.json(await createNpdFirstOrder(user, body), { status: 201 });
    }
    return NextResponse.json(await createNpdProject(user, body), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const body = (await readJson(req)) as { intent?: string };
    if (body?.intent === "set_sku") return NextResponse.json(await updateNpdProjectSkuCode(user, body));
    if (body?.intent === "reschedule") return NextResponse.json(await rescheduleNpd(user, body));
    return NextResponse.json(await updateNpdProject(user, body));
  } catch (e) {
    return errorResponse(e);
  }
}
