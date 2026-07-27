import { Suspense } from "react";

import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";

import PlanVersionsClient from "./plan-versions-client";

export const metadata = { title: "计划版本与周差异" };

export default async function PlanVersionsPage() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  const allowed = roles.includes("admin") || roles.some((role) => ["pmc", "purchasing"].includes(role));
  if (!allowed) return <NoAccess need="管理员、生产计划或采购" />;
  return (
    <Suspense>
      <PlanVersionsClient canCapture={roles.includes("admin") || roles.includes("pmc")} />
    </Suspense>
  );
}
