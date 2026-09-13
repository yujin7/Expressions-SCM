"use client";
import { useState } from "react";
import RemoteSelect, { type RemoteSelectProps, type RemoteRow } from "./RemoteSelect";
import { roleLabel } from "./dictionary";

export function todoAssigneeLabel(row: RemoteRow) {
  const roles = Array.isArray(row.roles) ? row.roles.filter((role): role is string => typeof role === "string").map(roleLabel).join("/") : "";
  return `#${row.id} ${typeof row.name === "string" ? row.name : "姓名未提供"}${roles ? ` · ${roles}` : ""}`;
}
export default function TodoAssigneeSelect({ excludeId, ...props }: Omit<RemoteSelectProps, "api" | "getLabel"> & { excludeId?: number }) {
  const [open, setOpen] = useState(false);
  return <RemoteSelect {...props} api={`/api/todo/assignees${excludeId ? `?excludeId=${excludeId}` : ""}`} getLabel={todoAssigneeLabel}
    open={props.open ?? open} onOpenChange={next => { setOpen(next); props.onOpenChange?.(next); }}
    onChange={(value, option) => { setOpen(false); props.onChange?.(value, option); }}
    showSearch allowClear virtual={false} listHeight={240} placeholder="搜索姓名、角色或 #人员ID"
    style={{ width: "100%", ...props.style }}
    optionRender={option => <span style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{option.label}</span>} />;
}
