import { Suspense } from "react";
import ClosedLoopClient from "./closed-loop-client";

export const metadata = { title: "建议闭环追踪" };

export default function Page() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><ClosedLoopClient /></Suspense>;
}
