import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { auth } from "@/server/auth";
import { ROLE_LABELS, type Role } from "@/server/core/constants";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const roles = ((session.user as { roles?: string[] }).roles ?? []) as Role[];
  const roleText = roles.map((r) => ROLE_LABELS[r] ?? r).join("/");
  return (
    <AppShell userName={session.user.name ?? "用户"} roleText={roleText}>
      {children}
    </AppShell>
  );
}
