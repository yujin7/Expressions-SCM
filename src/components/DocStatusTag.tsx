"use client";

import { Tag } from "antd";
import { DOC_STATUS_LABELS } from "./labels";

const STATUS_COLORS: Record<string, string> = {
  draft: "default",
  pending: "processing",
  approved: "blue",
  in_progress: "geekblue",
  completed: "success",
  closed: "warning",
  void: "default",
};

/** 统一单据状态 Tag（《01》§4 状态机） */
export default function DocStatusTag({ status }: { status: string }) {
  return (
    <Tag
      color={STATUS_COLORS[status] ?? "default"}
      style={status === "void" ? { textDecoration: "line-through" } : undefined}
    >
      {DOC_STATUS_LABELS[status] ?? status}
    </Tag>
  );
}
