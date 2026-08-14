import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { loadJiandaoyunSupportingObservations } from "@/server/modules/report/jiandaoyun-supporting-observation";
import { applySupplierLevel, getSupplierScorecard } from "@/server/modules/report/supplier-scorecard";
import { guardFreshWrite } from "@/server/modules/outsource/common";

/** E5-06 供应商记分卡：交期履约 × 质检结果 × 价格异动 → 综合分与建议等级（只读） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const windowDays = Number(searchParams.get("windowDays")) || undefined;
    const db = await getDbAsync();
    const [scorecard, supportingObservations] = await Promise.all([
      getSupplierScorecard({ q, page, pageSize, windowDays }, db),
      loadJiandaoyunSupportingObservations(db),
    ]);
    return NextResponse.json({
      ...scorecard,
      supportingObservations: supportingObservations.filter((observation) =>
        observation.stream === "supplier-observation"
        || observation.stream === "sample-management-observation"),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 采纳建议等级 → 写 suppliers.level（purchasing/admin；人工闸，新鲜会话回查） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const body = (await readJson(req)) as { supplierId: number; level: string };
    return NextResponse.json(await applySupplierLevel(user, body), { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
