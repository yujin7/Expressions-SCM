import { NextRequest, NextResponse } from "next/server";
import { buildProductExternalDecisionEvidenceBrief } from "@/components/product-external-decision-evidence";
import { getDbAsync } from "@/db";
import { ApiError, errorResponse, guardRead, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createNpdFirstOrder, createNpdProject, getNpdProject, listNpdProjects, rescheduleNpd, updateNpdProject, updateNpdProjectSkuCode } from "@/server/modules/npd/service";
import { loadDataSourceReadiness } from "@/server/modules/report/data-source-readiness";
import { loadJiandaoyunSupportingObservations } from "@/server/modules/report/jiandaoyun-supporting-observation";

/** NPD 项目：GET 列表 / ?id= 详情；POST 建项目（模板实例化）；PATCH 项目状态 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const params = new URL(req.url).searchParams;
    const ids = params.getAll("id");
    const views = params.getAll("view");
    if (ids.length > 1 || (ids.length === 1 && (!/^[1-9]\d*$/.test(ids[0]) || Number(ids[0]) > 2_147_483_647))) {
      throw new ApiError(400, "无效的项目 ID");
    }
    if (views.length > 1 || (views.length === 1 && !["projects", "evidence"].includes(views[0]))) {
      throw new ApiError(400, "无效的项目读取范围");
    }
    const db = await getDbAsync();
    if (ids.length) return NextResponse.json(await getNpdProject(Number(ids[0]), db));
    if (views[0] === "projects") return NextResponse.json({ projects: await listNpdProjects(db) });
    const [projects, supportingObservations, dataSources] = await Promise.all([
      views[0] === "evidence" ? undefined : listNpdProjects(db),
      loadJiandaoyunSupportingObservations(db),
      loadDataSourceReadiness(db),
    ]);
    return NextResponse.json({
      ...(projects === undefined ? {} : { projects }),
      supportingObservations: supportingObservations.filter((observation) =>
        observation.stream === "product-master-observation"
        || observation.stream === "sample-management-observation"),
      externalDecisionEvidence: buildProductExternalDecisionEvidenceBrief("launch-readiness", dataSources),
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
