import { Suspense } from "react";
import ExpiryClient from "./expiry-client";

export const metadata = { title: "效期批次" };

export default function Page() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><ExpiryClient /></Suspense>;
}
