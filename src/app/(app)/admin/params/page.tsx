import ParamsClient from "./params-client";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";

export const metadata = { title: "运行参数" };

export default async function Page() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  if (!["admin", "pmc", "purchasing", "finance"].some((r) => roles.includes(r))) {
    return <NoAccess need="管理员/生产计划/采购/财务" />;
  }
  // D59：补货参数（replenish 键组）写权限下放 pmc，其余仍仅 admin；逐键可写性由 API 的 writableBy 决定
  return <ParamsClient canWrite={roles.includes("admin") || roles.includes("pmc")} isAdmin={roles.includes("admin")} />;
}
