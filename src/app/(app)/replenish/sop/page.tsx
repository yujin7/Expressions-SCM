import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";

import SopClient from "./sop-client";

export const metadata = { title: "S&OP 计划周期" };

export default async function SopPage() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  const allowed = roles.includes("admin") || roles.some((role) =>
    ["pmc", "purchasing", "ops", "finance"].includes(role));
  if (!allowed) return <NoAccess need="管理员、生产计划、运营、采购或财务" />;
  return <SopClient />;
}
