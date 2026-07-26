import { Suspense } from "react";
import MarginClient from "./margin-client";

export const metadata = { title: "毛利视角" };

export default function Page() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><MarginClient /></Suspense>;
}
