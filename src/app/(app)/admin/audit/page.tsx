import { Suspense } from "react";
import AuditClient from "./audit-client";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";

export const metadata = { title: "审计日志" };

/** 审计日志（admin/finance——财务为只读审计员，UAT 横切裁定；服务端 API 再守卫一次） */
export default async function Page() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  const allowed = roles.includes("admin") || roles.includes("finance");
  // Suspense 必须包住真正用 useSearchParams 的那个组件（AuditClient），
  // 而不是无权限提示。此前边界被加在了 NoAccess 分支上——对真正看得到这一页的
  // admin/finance 而言等于没有边界，整页水合失败（路由仍 200、单测仍全绿）。
  if (!allowed) return <NoAccess need="管理员或财务" />;
  return (
    <Suspense>
      <AuditClient isAdmin={roles.includes("admin")} />
    </Suspense>
  );
}
