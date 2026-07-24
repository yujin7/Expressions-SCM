import { Suspense } from "react";
import CountClient from "./count-client";

export default function InventoryCountPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><CountClient /></Suspense>;
}
