import { Suspense } from "react";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";
import PlanEventsClient from "./plan-events-client";

export const metadata = { title: "大促与计划事件" };

/**
 * 运营计划事件（ops_plan_events）的**唯一人工入口**。
 * 读：pmc/ops/purchasing/finance（admin 兜底）；写（新建/改/删）：ops/pmc（admin 兜底），与服务端 requireAnyRole 同口径。
 */
export default async function PlanningEventsPage() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  const isAdmin = roles.includes("admin");
  const allowed = isAdmin || roles.some((r) => ["pmc", "ops", "purchasing", "finance"].includes(r));
  if (!allowed) return <NoAccess need="管理员、生产计划、运营、采购或财务" />;
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return (
    <Suspense>
      <PlanEventsClient canWrite={isAdmin || roles.includes("ops") || roles.includes("pmc")} />
    </Suspense>
  );
}
