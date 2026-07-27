import { Suspense } from "react";

import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";
import ProcessMiningClient from "./process-mining-client";

export const metadata = { title: "流程效率与瓶颈" };

export default async function Page() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  const allowed = roles.includes("admin") || roles.some((role) => ["pmc", "finance"].includes(role));
  if (!allowed) return <NoAccess need="管理员、生产计划或财务" />;
  return (
    <Suspense>
      <ProcessMiningClient />
    </Suspense>
  );
}
