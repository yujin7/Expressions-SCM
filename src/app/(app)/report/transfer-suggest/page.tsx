import { Suspense } from "react";
import TransferSuggestClient from "./transfer-suggest-client";

export const metadata = { title: "调拨建议" };

export default function Page() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><TransferSuggestClient /></Suspense>;
}
