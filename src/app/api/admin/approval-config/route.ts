import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser, requireRole } from "@/server/core/dto";
import { errorResponse, readJson } from "@/server/modules/master/common";
import {
  ASSIGNABLE_APPROVER_ROLES,
  listApprovalConfigs,
  updateApprovalConfig,
} from "@/server/modules/admin/approval-config";

/**
 * 审批节点配置（单据类型 → 审批角色）。
 * 读=管理员（这是 maker-checker 闸的配置，不对普通业务角色暴露）；写=管理员。
 * 身份一律回查 DB（新鲜身份），不吃 8h JWT 缓存。
 */
export async function GET() {
  try {
    const user = await getFreshSessionUser();
    requireRole(user, "admin");
    return NextResponse.json({
      rows: await listApprovalConfigs(),
      assignableRoles: ASSIGNABLE_APPROVER_ROLES,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getFreshSessionUser();
    // 角色判定在服务层（updateApprovalConfig 内再查一次），此处不重复放行
    return NextResponse.json(await updateApprovalConfig(user, await readJson(req)));
  } catch (e) {
    return errorResponse(e);
  }
}
