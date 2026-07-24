import ExceptionsClient from "./exceptions-client";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";

export const metadata = { title: "别名认领" };

export default async function Page() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  if (!["admin", "pmc", "purchasing", "warehouse"].some((r) => roles.includes(r))) return <NoAccess need="生产计划/采购/仓管或管理员" />;
  return <ExceptionsClient />;
}
