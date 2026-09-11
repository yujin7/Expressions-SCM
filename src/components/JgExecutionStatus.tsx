"use client";

import { Tag, Typography } from "antd";
import DocStatusTag from "@/components/DocStatusTag";
import ContextHelp from "@/components/ContextHelp";
import { jgExecutionView, type JgExecutionFacts } from "@/lib/jg-execution";

/** One compact status surface, shared by the JG list and its detail header. */
export default function JgExecutionStatus({ facts, docNo }: { facts: JgExecutionFacts; docNo: string }) {
  const view = jgExecutionView(facts);
  return <div style={{ display: "grid", gap: 4 }}>
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
      <DocStatusTag status={facts.status} />
      <ContextHelp label={`查看${docNo}执行口径`} title="加工执行口径"
        content={<><p>{view.explanation}</p><p>{view.flagExplanation}</p></>} />
    </div>
    {!view.terminal ? <Typography.Text type={view.warning ? "warning" : "secondary"} style={{ fontSize: 12 }}>
      {view.phase}
    </Typography.Text> : null}
    {view.flags.length ? <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {view.flags.map(flag => <Tag key={flag.text} color={flag.color} style={{ marginInlineEnd: 0 }}>{flag.text}</Tag>)}
    </div> : null}
  </div>;
}
