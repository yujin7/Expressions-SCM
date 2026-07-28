import { Suspense } from "react";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";
import QualityClient from "./quality-client";

export const metadata = { title: "质量与合规" };

export default async function QualityPage() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  const allowed = roles.includes("admin") || roles.some((role) =>
    ["quality", "purchasing", "warehouse", "pmc", "ops"].includes(role));

  if (!allowed) return <NoAccess need="质量、采购、仓库、生产计划、运营或管理员" />;

  return (
    <Suspense>
      <QualityClient />
    </Suspense>
  );
}
