import { Suspense } from "react";
import JgClient from "./jg-client";

export default function OutsourceJgPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><JgClient /></Suspense>;
}
