import UploadClient from "./upload-client";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";

export const metadata = { title: "文件上传" };

export default async function Page() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  if (!["admin", "pmc"].some((r) => roles.includes(r))) return <NoAccess need="生产计划（PMC）或管理员" />;
  return <UploadClient />;
}
