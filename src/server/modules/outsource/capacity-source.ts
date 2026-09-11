import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { systemAlerts, users, workItems } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { loadUserScopes, resolveChannelScope } from "@/server/core/data-scope";
import { ApiError } from "@/server/modules/master/common";
import { alertShopNames, channelScopedAlertCondition, visibleChannelScopedAlertIds } from "@/server/modules/report/shop-channel-scope";
import { loadShopChannelMap } from "@/server/modules/report/channel-observation";
import { workItemVisibilitySql } from "@/server/modules/todo/service";
import { requireAnyRole, type AnyDb } from "./common";

export const capacityFingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Same source scope as the alert list; a visible task alone cannot grant source access. */
export async function capacitySource(actor: SessionUser, alertId: number, skuId: number, db: AnyDb) {
  requireAnyRole(actor, "purchasing", "pmc", "ops");
  const scope = resolveChannelScope(actor, null);
  const [row] = await db.select().from(systemAlerts).where(and(eq(systemAlerts.id, alertId),
    scope.forced ? channelScopedAlertCondition(await visibleChannelScopedAlertIds(db, scope)) : undefined));
  if (!row) throw new ApiError(404, "来源告警不存在或当前不可见");
  if (!((row.category === "inventory_cover" && row.dedupeKey === `inventory_cover:${skuId}`)
    || (row.category === "sales_spike" && row.dedupeKey === `sales_spike:sku:${skuId}`))) {
    throw new ApiError(400, "来源告警与成品SKU不匹配，请从对应预警重新核对");
  }
  // Freeze the channel attribution, not just the mutable alert ID. Later narrowing of the
  // current alert or alias mapping must not authorize wider historical quantities.
  const shops = row.category === "sales_spike" ? alertShopNames(row) : [];
  const mapping = row.category === "sales_spike" && shops?.length ? await loadShopChannelMap(db, shops) : null;
  const channelIds = row.category !== "sales_spike" ? [] : !mapping || mapping.unmapped.length ? null
    : [...new Set(shops!.map(shop => mapping.byShop[shop] as number))].sort((a, b) => a - b);
  return { id: row.id as number, category: row.category as string, title: row.title as string, channelIds,
    status: row.status as string, lastHitAt: row.lastHitAt?.toISOString() ?? null,
    fingerprint: capacityFingerprint({ detail: row.detail, params: row.paramsSnapshot, lastHitAt: row.lastHitAt, status: row.status }) };
}

export async function capacityHandoffOptions(actor: SessionUser, alertId: number, skuId: number, db: AnyDb) {
  const source = await capacitySource(actor, alertId, skuId, db);
  const items: { id: number; title: string; assigneeId: number; assigneeName: string; assigneeRoles: SessionUser["roles"]; updatedAt: Date }[] = source.status !== "open" ? [] : await db
    .select({ id: workItems.id, title: workItems.title, assigneeId: workItems.assigneeId,
      assigneeName: users.name, assigneeRoles: users.roles, updatedAt: workItems.updatedAt }).from(workItems)
    .innerJoin(users, eq(users.id, workItems.assigneeId))
    .where(and(eq(workItems.sourceKind, "alert"), eq(workItems.sourceRef, String(alertId)),
      inArray(workItems.status, ["open", "in_progress"]), eq(users.active, true), workItemVisibilitySql(actor)))
    .orderBy(asc(workItems.id));
  const ownerAccess = new Map<number, Promise<boolean>>();
  const eligible = await Promise.all(items.map(async row => {
    if (!ownerAccess.has(row.assigneeId)) ownerAccess.set(row.assigneeId, (async () => {
      const owner: SessionUser = { id: row.assigneeId, name: row.assigneeName, roles: row.assigneeRoles, isApprover: false,
        ...await loadUserScopes(db, row.assigneeId) };
      try { await capacitySource(owner, alertId, skuId, db); return true; }
      catch (error) { if (error instanceof ApiError && [400, 403, 404].includes(error.status)) return false; throw error; }
    })());
    return await ownerAccess.get(row.assigneeId) ? { id: row.id, title: row.title, assigneeId: row.assigneeId,
      assigneeName: row.assigneeName, updatedAt: row.updatedAt.toISOString() } : null;
  }));
  return { source, items: eligible.filter((row): row is NonNullable<typeof row> => row !== null) };
}
