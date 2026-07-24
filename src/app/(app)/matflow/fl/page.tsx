import { Suspense } from "react";
import FlClient from "./fl-client";

export default function MatflowFlPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><FlClient /></Suspense>;
}
