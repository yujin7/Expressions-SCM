import { Suspense } from "react";
import TransferRoutesClient from "./transfer-routes-client";

export const metadata = { title: "调拨线路与费用" };

export default function Page() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><TransferRoutesClient /></Suspense>;
}
