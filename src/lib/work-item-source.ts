/** 待办是工作记录，来源告警/复核项有独立生命周期。只生成受控站内深链，不解析 detail 里的任意 URL。 */
export interface WorkItemSourceAction {
  href: string;
  label: string;
  completionHint: string;
}

export function workItemSourceAction(item: { sourceKind: string | null; sourceRef: string | null }): WorkItemSourceAction | null {
  const ref = item.sourceRef?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(ref) || !Number.isSafeInteger(Number(ref)) || Number(ref) > 2_147_483_647) return null;
  if (item.sourceKind === "alert") return {
    href: `/alerts?id=${ref}`,
    label: "查看来源告警",
    completionHint: "仅完成待办，不会关闭来源告警；请按实际处置结果在告警页记录原因。",
  };
  if (item.sourceKind === "review") return {
    href: `/review/checklist?id=${ref}`,
    label: "查看来源复核",
    completionHint: "仅完成待办，不会代替来源复核；请在复核清单中记录通过或改判意见。",
  };
  return null;
}
