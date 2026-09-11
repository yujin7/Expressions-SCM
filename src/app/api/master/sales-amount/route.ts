import { NextRequest, NextResponse } from "next/server";
import { getDbAsync } from "@/db";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import {
  listSalesAmountMonthly,
  prefillFromObservation,
  SALES_AMOUNT_SCOPE_KINDS,
  SALES_AMOUNT_WRITE_ROLES,
  type SalesAmountScopeKind,
  upsertSalesAmountMonthly,
} from "@/server/modules/master/sales-amount";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";

/**
 * 月度销售金额受控表（D53）。
 * GET  列表（链尾 = 当前有效；`includeSuperseded=1` 含历史）；`prefill=1&yearMonth=` 返回观察预填建议（不落库；finance/admin）。
 * POST 新增 / 改写（finance/admin；append-only supersedes 链 + 同事务审计）。
 * 金额键 salesAmount 为敏感字段：非 PRICE_VISIBLE_ROLES 由 maskSensitive 剥离。
 */
export async function GET(req: NextRequest) {
  try {
    const { page, pageSize, searchParams } = parseListQuery(req.url);
    const db = await getDbAsync();
    if (searchParams.get("prefill") === "1") {
      const user = await guardFreshWrite();
      requireAnyRole(user, ...SALES_AMOUNT_WRITE_ROLES);
      const data = await prefillFromObservation(searchParams.get("yearMonth") ?? "", db);
      return NextResponse.json(maskSensitive(data, user.roles), { headers: { "Cache-Control": "private, no-store" } });
    }
    const user = await guardRead();
    const scopeKindRaw = searchParams.get("scopeKind");
    const scopeKind = scopeKindRaw && (SALES_AMOUNT_SCOPE_KINDS as readonly string[]).includes(scopeKindRaw) ? (scopeKindRaw as SalesAmountScopeKind) : undefined;
    const scopeIdRaw = searchParams.get("scopeId");
    const data = await listSalesAmountMonthly({
      yearMonth: searchParams.get("yearMonth") ?? undefined,
      fromMonth: searchParams.get("fromMonth") ?? undefined,
      toMonth: searchParams.get("toMonth") ?? undefined,
      scopeKind,
      scopeId: scopeIdRaw == null ? undefined : scopeIdRaw === "" ? null : Number(scopeIdRaw) || undefined,
      includeSuperseded: searchParams.get("includeSuperseded") === "1",
      page,
      pageSize,
    }, db);
    return NextResponse.json(maskSensitive(data, user.roles), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e, { path: "/api/master/sales-amount", method: "GET" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    requireAnyRole(user, ...SALES_AMOUNT_WRITE_ROLES);
    const db = await getDbAsync();
    // 审计随写入落在同一事务内（master/sales-amount.ts）
    const result = await upsertSalesAmountMonthly(user, await readJson(req), db);
    return NextResponse.json(maskSensitive(result, user.roles), { status: result.unchanged ? 200 : 201 });
  } catch (e) {
    return errorResponse(e, { path: "/api/master/sales-amount", method: "POST" });
  }
}
