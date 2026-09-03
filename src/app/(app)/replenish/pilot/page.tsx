import { Suspense } from "react";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";
import PilotClient from "./pilot-client";

export const metadata = { title: "补货试点候选" };

export default async function PilotPage() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  const allowed = roles.includes("admin") || roles.some((r) => ["pmc", "purchasing", "ops", "finance"].includes(r));
  if (!allowed) return <NoAccess need="管理员、生产计划、采购、运营或财务" />;
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return (
    <Suspense>
      <PilotClient canManage={roles.includes("admin") || roles.includes("pmc")} />
    </Suspense>
  );
}
