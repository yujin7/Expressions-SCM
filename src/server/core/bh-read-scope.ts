import { and, eq, exists, inArray, or, sql, type SQL } from "drizzle-orm";
import { bhDocs, userDataScopes } from "@/db/schema";
import type { ScopeUser } from "@/server/core/data-scope";
import type { AnyDb } from "@/server/core/svc";

export type BhReadUser = ScopeUser & { id: number };

/** D62: own creator or shared channel. Apply before LIMIT and before loading details/lines. */
export function bhReadScope(db: AnyDb, user?: BhReadUser): SQL | undefined {
  if (!user || user.roles.includes("admin") || user.channelScope == null) return undefined;
  const own = eq(bhDocs.createdBy, user.id);
  const allowed = [...new Set(user.channelScope)];
  if (!allowed.length) return own;
  return or(own, exists(db.select({ one: sql`1` }).from(userDataScopes).where(and(
    eq(userDataScopes.userId, bhDocs.createdBy),
    eq(userDataScopes.scopeKind, "channel"),
    inArray(userDataScopes.targetId, allowed),
  ))));
}
