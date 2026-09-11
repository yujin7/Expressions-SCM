import { isRouteVisible, routeByPath } from "@/lib/route-access";
import type { ScopeUser } from "@/server/core/data-scope";

/** Navigation summaries cannot disclose destinations the actor may not read.
 * This is a route gate, not row authorization; channel-scoped sources still filter their rows.
 */
export function canReadInboxDestination(path: string, user: ScopeUser): boolean {
  const route = routeByPath(path);
  if (!route || !isRouteVisible(route, user.roles)) return false;
  return user.roles.includes("admin") || user.channelScope == null || route.scopedMode !== "denied";
}
