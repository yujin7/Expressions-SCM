import { Suspense } from "react";
import BhClient from "./bh-client";

export default function OutsourceBhPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><BhClient /></Suspense>;
}
