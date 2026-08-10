import ApprovalConfigClient from "./approval-config-client";
import NoAccess from "@/components/NoAccess";
import { auth } from "@/server/auth";

export const metadata = { title: "审批节点配置" };

/**
 * 审批节点配置只对管理员开放：这是 maker-checker 那道闸本身的配置，
 * 能改它等于能改"谁有权批准"，比普通运行参数更敏感。
 * 服务端仍会再判一次角色——页面级隐藏不算授权。
 */
export default async function Page() {
  const session = await auth();
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  if (!roles.includes("admin")) return <NoAccess need="管理员" />;
  return <ApprovalConfigClient />;
}
