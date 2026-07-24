import HealthClient from "./health-client";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";

export const metadata = { title: "运维面板" };

export default async function Page() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  if (!roles.includes("admin")) return <NoAccess need="管理员" />;
  return <HealthClient />;
}
