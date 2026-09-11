import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { alertEvents, systemAlerts, users } from "@/db/schema";
import { resolveChannelScope } from "@/server/core/data-scope";
import { maskSensitive } from "@/server/core/dto";
import { ApiError, errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { channelScopedAlertCondition, visibleChannelScopedAlertIds } from "@/server/modules/report/shop-channel-scope";
import { ALERT_LOOKUP_MAX_ENCODED_KEYS, ALERT_LOOKUP_MAX_KEYS } from "@/lib/alert-lookup";

/**
 * struct#15 系统告警（看门狗产出，与人工裁决 review_items 分家）。
 * 查询参数：status（缺省 open）、category、severity、acked=0（只看未知悉）、page/pageSize（缺省 1/50，上限 500）。
 * 返回 { rows, total, page, pageSize }；rows 带 ackedByName；params_snapshot 可能带金额键，统一经 maskSensitive。
 * keys=JSON数组：只用于inventory_cover/sales_spike未关闭告警的精确关联；最多100键且编码后6000字符。
 * 该模式固定第一页并返回全部可见命中；unackedTotal为当前账号可见的本类全部未知悉数，不受keys裁剪。
 *
 * W2：status=resolved 时每行再带**最近一条 close 事件**的 reason_code / note / 时间 / 关闭人
 * （closeReasonCode / closeNote / closedAt / closedByName）——已关闭视图不写明"为什么关的"，
 * 误报复盘与阈值调参就只能靠猜。台账在 alert_events（只追加），这里只读最新一条，不改任何状态。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const { page: requestedPage, pageSize: rawPageSize, searchParams } = parseListQuery(req.url);
    const status = searchParams.get("status")?.trim() || "open";
    const category = searchParams.get("category")?.trim() || "";
    const severity = searchParams.get("severity")?.trim() || "";
    const unackedOnly = searchParams.get("acked") === "0";
    /* W2 单条深链 `?id=`：通知中心的系统告警通知按 dedupeKey 反查到具体告警行
       （lib/notify-links）。**命中 id 时忽略 status**——通知常常是在告警被关闭之后才被点开，
       若还按缺省 status=open 过滤，用户点进来只会看到空列表，然后以为"这条告警不存在"。 */
    const idRaw = searchParams.get("id");
    const focusId = idRaw !== null ? z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(2_147_483_647)).parse(idRaw) : null;
    const keysRaw = searchParams.get("keys");
    let lookupKeys: string[] | null = null;
    if (keysRaw !== null) {
      if (focusId !== null || status !== "open" || !["inventory_cover", "sales_spike"].includes(category)
        || severity || unackedOnly || encodeURIComponent(keysRaw).length > ALERT_LOOKUP_MAX_ENCODED_KEYS) {
        throw new ApiError(400, "告警关联查询无效，请按当前类别和行标识查询");
      }
      let parsed: unknown;
      try { parsed = JSON.parse(keysRaw); } catch { throw new ApiError(400, "告警关联标识格式无效"); }
      lookupKeys = [...new Set(z.array(z.string().min(1)).max(ALERT_LOOKUP_MAX_KEYS).parse(parsed))];
    }
    const page = focusId || lookupKeys !== null ? 1 : requestedPage;
    const pageSize = lookupKeys !== null ? Math.max(1, lookupKeys.length) : Math.min(500, searchParams.get("pageSize") ? rawPageSize : 50);
    // Allowlisted expressions only; apply ordering before LIMIT/OFFSET, never to one client page.
    // Exact notification links ignore display sorting just as they ignore other display filters.
    const sort = focusId ? "id" : z.enum(["id", "createdAt", "lastHitAt", "severity"]).parse(searchParams.get("sort") || "id");
    const order = focusId ? "desc" : z.enum(["asc", "desc"]).parse(searchParams.get("order") || "desc");
    const sortColumn = sort === "severity"
      ? sql`case ${systemAlerts.severity} when 'critical' then 3 when 'high' then 2 when 'medium' then 1 else null end`
      : systemAlerts[sort];
    const ordering = order === "asc" ? sql`${sortColumn} asc nulls last` : sql`${sortColumn} desc nulls last`;
    const db = await getDbAsync();
    const where: SQL[] = focusId ? [eq(systemAlerts.id, focusId)] : [eq(systemAlerts.status, status)];
    if (!focusId) {
      if (category) where.push(eq(systemAlerts.category, category));
      if (severity) where.push(eq(systemAlerts.severity, severity));
      if (unackedOnly) where.push(isNull(systemAlerts.ackedAt));
    }
    // D62（安全审计 S3）：受限渠道账号只看得到能归到自己渠道的店铺维告警（爆单预警的标题/详情/去重键
    // 里带着店铺名与平台 SKU）。条件下推 SQL，total 与分页跟着一起裁，不是分页后再删行。
    const scope = resolveChannelScope(user, null);
    if (scope.forced) where.push(channelScopedAlertCondition(await visibleChannelScopedAlertIds(db, scope)));
    const categoryScope = and(...where);
    const cond = lookupKeys === null ? categoryScope : and(categoryScope,
      lookupKeys.length ? inArray(systemAlerts.dedupeKey, lookupKeys) : sql`false`);
    const [[{ total }], rows, unacked] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int` }).from(systemAlerts).where(cond),
      db
        .select({
          id: systemAlerts.id,
          category: systemAlerts.category,
          refKey: systemAlerts.refKey,
          title: systemAlerts.title,
          detail: systemAlerts.detail,
          severity: systemAlerts.severity,
          status: systemAlerts.status,
          autoResolved: systemAlerts.autoResolved,
          createdAt: systemAlerts.createdAt,
          resolvedAt: systemAlerts.resolvedAt,
          ownerRole: systemAlerts.ownerRole,
          actionHref: systemAlerts.actionHref,
          dedupeKey: systemAlerts.dedupeKey,
          sourceRule: systemAlerts.sourceRule,
          paramsSnapshot: systemAlerts.paramsSnapshot,
          lastHitAt: systemAlerts.lastHitAt,
          ackedBy: systemAlerts.ackedBy,
          ackedAt: systemAlerts.ackedAt,
          ackedByName: users.name,
        })
        .from(systemAlerts)
        .leftJoin(users, eq(systemAlerts.ackedBy, users.id))
        .where(cond)
        .orderBy(ordering, desc(systemAlerts.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      // This summary is category-wide and scope-filtered, not a count of the requested keys.
      lookupKeys === null ? Promise.resolve(null) : db.select({ count: sql<number>`count(*)::int` })
        .from(systemAlerts).where(and(categoryScope, isNull(systemAlerts.ackedAt))),
    ]);
    /* 已关闭视图：补最近一条 close 事件（台账 alert_events 只追加，取 id 最大的一条即最新） */
    let withClose = rows;
    // 单条深链不带 status，行本身可能已关闭——同样要补关闭原因，否则"为什么关的"又只剩台账里有
    if ((focusId != null || status !== "open") && rows.length > 0) {
      const events: {
        alertId: number; reasonCode: string | null; note: string | null; at: Date | null; actorName: string | null;
      }[] = await db
        .select({
          alertId: alertEvents.alertId, reasonCode: alertEvents.reasonCode, note: alertEvents.note,
          at: alertEvents.at, actorName: users.name,
        })
        .from(alertEvents)
        .leftJoin(users, eq(alertEvents.actorId, users.id))
        .where(and(eq(alertEvents.event, "close"), inArray(alertEvents.alertId, rows.map((r) => r.id))))
        .orderBy(desc(alertEvents.id));
      const latest = new Map<number, (typeof events)[number]>();
      for (const e of events) if (!latest.has(e.alertId)) latest.set(e.alertId, e);
      withClose = rows.map((r) => {
        const e = latest.get(r.id);
        return {
          ...r,
          closeReasonCode: e?.reasonCode ?? null,
          closeNote: e?.note ?? null,
          closedAt: e?.at ?? null,
          closedByName: e?.actorName ?? null,
        };
      });
    }
    const response = NextResponse.json({ rows: maskSensitive(withClose, user.roles), total: Number(total ?? 0), page, pageSize,
      ...(unacked ? { unackedTotal: Number(unacked[0]?.count ?? 0) } : {}) });
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (e) {
    return errorResponse(e);
  }
}
