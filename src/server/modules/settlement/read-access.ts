import { eq } from "drizzle-orm";
import { approvalConfigs } from "@/db/schema";
import { ROUTE_REGISTRY, isRouteVisible } from "@/lib/route-access";
import type { ScopeUser } from "@/server/core/data-scope";
import type { AnyDb } from "@/server/core/svc";
import { approvalRoleError } from "@/server/docflow/approval";

type Reader = ScopeUser & { isApprover?: boolean };

/** Read access is not approval or price visibility. Configured checkers need a rejection/history path. */
export function canReadSettlement(user: Reader, approverRole: string | null): boolean {
  if (user.roles.includes("admin")) return true;
  // JS has no reliable channel grain; an explicit scope cannot be treated as unrestricted.
  if (user.channelScope != null) return false;
  return isRouteVisible(ROUTE_REGISTRY.settlement_js, user.roles)
    || approvalRoleError({ roles: user.roles, isApprover: user.isApprover === true }, approverRole) === null;
}

export async function loadSettlementReadPolicy(db: AnyDb, user: Reader) {
  const [config] = await db.select({ role: approvalConfigs.approverRole }).from(approvalConfigs)
    .where(eq(approvalConfigs.docType, "js"));
  const approverRole = config?.role ?? null;
  return { allowed: canReadSettlement(user, approverRole), approverRole };
}
