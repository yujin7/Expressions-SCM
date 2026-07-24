import { Suspense } from "react";
import PcClient from "./pc-client";

export default function OutsourcePcPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><PcClient /></Suspense>;
}
