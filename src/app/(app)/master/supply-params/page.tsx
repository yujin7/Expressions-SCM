import { Suspense } from "react";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";
import SupplyParamsClient from "./supply-params-client";

export const metadata = { title: "周期主数据补录" };

export default async function SupplyParamsPage() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  const allowed = roles.includes("admin") || roles.some((r) => ["pmc", "purchasing"].includes(r));
  if (!allowed) return <NoAccess need="管理员、生产计划或采购" />;
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return (
    <Suspense>
      <SupplyParamsClient key={session?.user?.id} userId={Number(session?.user?.id)} canOverride={roles.includes("admin") || roles.includes("pmc")} />
    </Suspense>
  );
}
