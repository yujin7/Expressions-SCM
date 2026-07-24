import AuditClient from "./audit-client";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";

export const metadata = { title: "审计日志" };

/** 审计日志（admin/finance——财务为只读审计员，UAT 横切裁定；服务端 API 再守卫一次） */
export default async function Page() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  const allowed = roles.includes("admin") || roles.includes("finance");
  if (!allowed) return <NoAccess need="管理员或财务" />;
  return <AuditClient isAdmin={roles.includes("admin")} />;
}
