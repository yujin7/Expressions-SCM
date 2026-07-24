import { Suspense } from "react";
import DetectorsClient from "./detectors-client";

export const metadata = { title: "异动侦测" };

export default function Page() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return <Suspense><DetectorsClient /></Suspense>;
}
