import { Suspense } from "react";
import DataQualityClient from "./data-quality-client";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";

export const metadata = { title: "数据质量" };

const VIEW_ROLES = ["admin", "pmc", "finance", "warehouse", "purchasing"];
const REVIEW_ROLES = ["admin", "pmc", "finance", "warehouse"];

export default async function Page() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  if (!VIEW_ROLES.some((r) => roles.includes(r))) return <NoAccess need="生产计划（PMC）、财务、仓库、采购或管理员" />;
  const canReview = REVIEW_ROLES.some((r) => roles.includes(r));
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return (
    <Suspense>
      <DataQualityClient canReview={canReview} />
    </Suspense>
  );
}
