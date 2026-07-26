import { Suspense } from "react";
import DataHealthClient from "./data-health-client";

export const metadata = { title: "主数据健康度" };

export default function Page() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return <Suspense><DataHealthClient /></Suspense>;
}
