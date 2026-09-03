import { Suspense } from "react";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";
import ReconcileClient from "./reconcile-client";

export const metadata = { title: "运营提报核对" };

export default async function ReconcilePage() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  const allowed = roles.includes("admin") || roles.some((r) => ["pmc", "ops", "purchasing", "finance"].includes(r));
  if (!allowed) return <NoAccess need="管理员、生产计划、运营、采购或财务" />;
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return (
    <Suspense>
      <ReconcileClient canSubmit={roles.includes("admin") || roles.includes("pmc") || roles.includes("ops")} />
    </Suspense>
  );
}
