import { isRouteVisible, routeByPath } from "@/lib/route-access";
import type { ScopeUser } from "@/server/core/data-scope";
import type { AnyDb } from "@/server/core/svc";
import { loadSettlementReadPolicy } from "@/server/modules/settlement/read-access";

/** Navigation summaries cannot disclose destinations the actor may not read.
 * This is a route gate, not row authorization; channel-scoped sources still filter their rows.
 */
export function canReadInboxDestination(path: string, user: ScopeUser, settlementAllowed?: boolean): boolean {
  if (path === "/settlement/js" && settlementAllowed !== undefined) return settlementAllowed;
  const route = routeByPath(path);
  if (!route || !isRouteVisible(route, user.roles)) return false;
  return user.roles.includes("admin") || user.channelScope == null || route.scopedMode !== "denied";
}

/** Resolve dynamic JS checker access once per read, never by pretending the actor has a financial role. */
export async function loadDestinationReader(db: AnyDb, user: ScopeUser & { isApprover?: boolean }) {
  const settlement = await loadSettlementReadPolicy(db, user);
  return (path: string) => canReadInboxDestination(path, user, settlement.allowed);
}
