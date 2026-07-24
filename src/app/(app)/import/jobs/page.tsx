import { Suspense } from "react";
import JobsClient from "./jobs-client";

export default function ImportJobsPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><JobsClient /></Suspense>;
}
