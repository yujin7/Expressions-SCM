import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, guardRead, readJson } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { clearScopedParam, listScopedOverrides, setScopedParam, type ParamScope } from "@/server/core/scoped-params";

/**
 * 分域参数覆盖（sku > brand > segment > global > 系统缺省）。
 *
 * 为什么需要这条路由（2026-07-25 审计）：`core/scoped-params.ts` 把整套作用域继承
 * 都实现好了——setScopedParam / resolveNumParam / listScopedOverrides / describeScope，
 * 还配了单测——但**全系统没有任何代码能写出 `sku:401` / `brand:12` / `segment:AX` 这样的行**：
 * 唯一写库路径 `admin/params.ts` 硬编码 `scope='global'`，seed 只播 global 与 category:*。
 * 于是 pick() 的前三级候选永远 miss，`makeResolver("safety_days_fallback")` 100% 退化为 global，
 * **全体 SKU 共用同一个安全库存兜底天数**——ABC/XYZ 九宫格算出的策略无处落参。
 * 本路由补上写入口，让分层策略真的能落到参数上。
 */

/**
 * GET ?key=safety_days_fallback —— 列出该参数的全部作用域覆盖。
 *
 * 读权限与 `/api/admin/params` 的 GET **同一档**（pmc/purchasing/finance/admin，S3）：
 * 此前只 `guardRead()`，任何登录用户（含仓管/运营）都能把某个参数在
 * 每个 SKU / 品牌 / 分层上的覆盖值连同「谁在什么时候改的」一并枚举出来——
 * 全局值要业务角色才看得到，分层值却对全员敞开，两条路对同一份数据两套口径。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    requireAnyRole(user, "pmc", "purchasing", "finance");
    const key = req.nextUrl.searchParams.get("key");
    if (!key) throw new ApiError(400, "缺少 key 参数");
    return NextResponse.json({ rows: await listScopedOverrides(key) });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST { key, value, scope: {kind:'sku'|'brand'|'segment'|'global', ...} }
 * 越界/未登记键/无权角色一律由 setScopedParam 拒绝（含审计），此处只做形状校验。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const body = (await readJson(req)) as { key?: string; value?: number; scope?: ParamScope };
    if (!body?.key) throw new ApiError(400, "缺少 key");
    if (typeof body.value !== "number" || !Number.isFinite(body.value)) throw new ApiError(400, "value 必须是数字");
    if (!body.scope?.kind) throw new ApiError(400, "缺少 scope.kind");
    await setScopedParam(user, { key: body.key, scope: body.scope, value: body.value });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE { key, scope } —— 移除覆盖，回落上一级（撤不掉的覆盖是陷阱） */
export async function DELETE(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const body = (await readJson(req)) as { key?: string; scope?: ParamScope };
    if (!body?.key) throw new ApiError(400, "缺少 key");
    if (!body.scope?.kind) throw new ApiError(400, "缺少 scope.kind");
    await clearScopedParam(user, { key: body.key, scope: body.scope });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
