import { Suspense } from "react";
import PurchaseOrdersClient from "./purchase-orders-client";

export const metadata = { title: "采购订单指标" };

export default function Page() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><PurchaseOrdersClient /></Suspense>;
}
