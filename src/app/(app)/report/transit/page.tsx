import { Suspense } from "react";
import TransitClient from "./transit-client";

export const metadata = { title: "在途参考" };

export default function Page() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return <Suspense><TransitClient /></Suspense>;
}
