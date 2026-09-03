import { Suspense } from "react";
import TodoClient from "./todo-client";

export const metadata = { title: "待办任务" };

export default function Page() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><TodoClient /></Suspense>;
}
