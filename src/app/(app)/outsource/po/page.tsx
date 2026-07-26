import { Suspense } from "react";
import PoClient from "./po-client";

export default function OutsourcePoPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><PoClient /></Suspense>;
}
