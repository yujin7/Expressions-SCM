import { Suspense } from "react";
import ReplenishClient from "./replenish-client";

export default function ReplenishPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><ReplenishClient /></Suspense>;
}
