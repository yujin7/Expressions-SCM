import { Suspense } from "react";
import ShClient from "./sh-client";

export default function MatflowShPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><ShClient /></Suspense>;
}
