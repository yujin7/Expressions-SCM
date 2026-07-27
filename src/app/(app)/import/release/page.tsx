import ReleaseClient from "./release-client";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";

export const metadata = { title: "放行工作台" };

export default async function Page() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  const canPlan = ["admin", "pmc"].some((role) => roles.includes(role));
  const canFinance = ["admin", "finance"].some((role) => roles.includes(role));
  if (!canPlan && !canFinance) return <NoAccess need="生产计划（PMC）、财务或管理员" />;
  return <ReleaseClient canPlan={canPlan} canFinance={canFinance} />;
}
