import { Suspense } from "react";
import SegmentationClient from "./segmentation-client";

export const metadata = { title: "库存分层 (ABC/XYZ)" };

export default function Page() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return <Suspense><SegmentationClient /></Suspense>;
}
