import { Suspense } from "react";
import LedgerClient from "./ledger-client";

export default function InventoryLedgerPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><LedgerClient /></Suspense>;
}
