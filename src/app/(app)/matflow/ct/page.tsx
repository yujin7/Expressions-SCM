import { Suspense } from "react";
import CtClient from "./ct-client";

export default function MatflowCtPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><CtClient /></Suspense>;
}
