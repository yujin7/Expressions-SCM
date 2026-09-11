import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { ApiError, errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { disposeOpsDemand, getReconcile, OPS_DEMAND_CSV_HEADERS, parseOpsDemandCsv, projectReconcileReviewItems, submitOpsDemand } from "@/server/modules/replenish/reconcile";

/** 运营提报核对（D55/R3）：GET 某月提报 vs 系统基线并排；受限用户按渠道范围裁剪 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const channelRaw = Number(searchParams.get("channelId"));
    const data = await getReconcile(user as { roles: string[]; channelScope?: number[] | null }, {
      period: searchParams.get("period") || null,
      channelId: Number.isInteger(channelRaw) && channelRaw > 0 ? channelRaw : null,
      q,
      flaggedOnly: searchParams.get("flaggedOnly") === "1",
      page,
      pageSize,
    });
    return NextResponse.json({ ...data, csvHeaders: OPS_DEMAND_CSV_HEADERS });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST { rows: [{ skuCode|skuId, channelCode|channelId?, period, qty, basis? }] } 或 { csv: "<文本>" }（模板导入）。
 * 写守卫：新鲜身份 + service 内 ops/pmc（admin 兜底）；整批一事务 + 审计；只对照不驱动。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const body = await readJson<{ csv?: string; rows?: unknown[] }>(req);
    if (typeof body?.csv === "string") {
      const parsed = parseOpsDemandCsv(body.csv);
      if (parsed.errors.length) {
        throw new ApiError(400, `模板解析失败（未落库）：${parsed.errors.slice(0, 20).map((e) => `第 ${e.line} 行 ${e.message}`).join("；")}`);
      }
      const result = await submitOpsDemand(user, { rows: parsed.rows }, undefined);
      return NextResponse.json({ ...result, parsedRows: parsed.rows.length }, { status: 201 });
    }
    return NextResponse.json(await submitOpsDemand(user, body), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * W2-#7 处置一条提报：PATCH { submissionId, decision: "accepted"|"rejected", reason? }。
 * 接受 = 记为该期已达成一致的需求（**仍不自动驱动建议量**）；驳回必须写原因。
 * 处置后重投影复核项，使「标红未处置」的待办与实际状态保持一致。
 */
export async function PATCH(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    const result = await disposeOpsDemand(user, await readJson(req));
    const projection = await projectReconcileReviewItems(null);
    return NextResponse.json({ ...result, projection });
  } catch (e) {
    return errorResponse(e);
  }
}
