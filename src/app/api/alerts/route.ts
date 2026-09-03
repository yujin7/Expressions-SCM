import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { systemAlerts, users } from "@/db/schema";
import { maskSensitive } from "@/server/core/dto";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";

/**
 * struct#15 系统告警（看门狗产出，与人工裁决 review_items 分家）。
 * 查询参数：status（缺省 open）、category、severity、acked=0（只看未知悉）、page/pageSize（缺省 1/50，上限 500）。
 * 返回 { rows, total, page, pageSize }；rows 带 ackedByName；params_snapshot 可能带金额键，统一经 maskSensitive。
 */
export async function GET(req: NextRequest) {
  try {
    const user = await guardRead();
    const db = await getDbAsync();
    const { page, pageSize: rawPageSize, searchParams } = parseListQuery(req.url);
    const pageSize = Math.min(500, searchParams.get("pageSize") ? rawPageSize : 50);
    const status = searchParams.get("status")?.trim() || "open";
    const category = searchParams.get("category")?.trim() || "";
    const severity = searchParams.get("severity")?.trim() || "";
    const unackedOnly = searchParams.get("acked") === "0";
    const where: SQL[] = [eq(systemAlerts.status, status)];
    if (category) where.push(eq(systemAlerts.category, category));
    if (severity) where.push(eq(systemAlerts.severity, severity));
    if (unackedOnly) where.push(isNull(systemAlerts.ackedAt));
    const cond = and(...where);
    const [[{ total }], rows] = await Promise.all([
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
        .orderBy(desc(systemAlerts.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);
    return NextResponse.json({ rows: maskSensitive(rows, user.roles), total: Number(total ?? 0), page, pageSize });
  } catch (e) {
    return errorResponse(e);
  }
}
