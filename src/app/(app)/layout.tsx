import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import AppShell from "@/components/AppShell";
import { getDbAsync } from "@/db";
import { users } from "@/db/schema";
import { auth } from "@/server/auth";
import { ROLE_LABELS, type Role } from "@/server/core/constants";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // 首登强制改密（RT5 #5）：DB 实时查旗标，由 AppShell 弹不可关闭引导（避免布局层重定向环）
  let mustChangePassword = false;
  const uid = Number((session.user as { id?: string | number }).id);
  if (Number.isFinite(uid)) {
    const db = await getDbAsync();
    const [u] = await db
      .select({ mustChange: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, uid));
    mustChangePassword = u?.mustChange ?? false;
  }
  const roles = ((session.user as { roles?: string[] }).roles ?? []) as Role[];
  const roleText = roles.map((r) => ROLE_LABELS[r] ?? r).join("/");
  return (
    <AppShell userName={session.user.name ?? "用户"} roleText={roleText} roles={roles} mustChangePassword={mustChangePassword}>
      {children}
    </AppShell>
  );
}
