import { Suspense } from "react";
import InventoryAnalyticsClient from "./inventory-analytics-client";

export const metadata = { title: "库存分析" };

export default function Page() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return <Suspense><InventoryAnalyticsClient /></Suspense>;
}
