"use client";

/**
 * 单据审批轨迹（无状态展示件）。
 *
 * 此前这段 `<Timeline items={approvals.map(...)}/>` 在 11 个单据客户端逐字复制，
 * 复制体之间已经开始分叉：
 *   · 9 处写了 `approverName ?? "—"`，2 处漏写 → 审批人账号被删后**整行渲染空白**
 *     （已于 c9503c3 修掉，本组件把兜底固化下来，不再依赖每个复制体各自记得写）；
 *   · 只有 bh-client 传了 `key`，其余 10 处没传。
 *
 * `approverName` 可空不是意外：服务端 `docflow/loadApprovalHistory` 走 leftJoin(users)，
 * 账号删除/停用后必然取到 null。**类型上就允许 null，渲染必须兜底。**
 *
 * 零命中不占位：`items` 为空时返回 null，由调用方决定要不要显示标题。
 */
import { Timeline, Typography } from "antd";
import { formatAsOf } from "@/components/format";

export interface ApprovalTimelineItem {
  /** 审批人姓名；账号被删/停用后为 null */
  approverName: string | null;
  /** approve = 通过，其余按驳回呈现 */
  action: string;
  comment: string | null;
  createdAt: string | Date;
}

export default function ApprovalTimeline({ items }: { items: ApprovalTimelineItem[] }) {
  if (!items || items.length === 0) return null;
  return (
    <Timeline
      items={items.map((a, i) => ({
        key: i,
        color: a.action === "approve" ? "green" : "red",
        children: (
          <div>
            <div>
              {a.approverName ?? "—"} {a.action === "approve" ? "审批通过" : "驳回"}
              <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                {formatAsOf(typeof a.createdAt === "string" ? a.createdAt : Number.isFinite(a.createdAt.getTime()) ? a.createdAt.toISOString() : null)}（上海时间）
              </Typography.Text>
            </div>
            {a.comment ? <Typography.Text type="secondary">{a.comment}</Typography.Text> : null}
          </div>
        ),
      }))}
    />
  );
}
