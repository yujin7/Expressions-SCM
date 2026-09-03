import { Suspense } from "react";
import GoalsClient from "./goals-client";

export const metadata = { title: "供应链目标" };

export default function Page() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><GoalsClient /></Suspense>;
}
