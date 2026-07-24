import { Suspense } from "react";
import JsClient from "./js-client";

export default function SettlementJsPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><JsClient /></Suspense>;
}
