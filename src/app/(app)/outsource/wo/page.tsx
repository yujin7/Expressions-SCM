import { Suspense } from "react";
import WoClient from "./wo-client";

export default function OutsourceWoPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><WoClient /></Suspense>;
}
