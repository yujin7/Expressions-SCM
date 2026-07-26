import { Suspense } from "react";
import BalanceClient from "./balance-client";

export default function InventoryBalancePage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><BalanceClient /></Suspense>;
}
