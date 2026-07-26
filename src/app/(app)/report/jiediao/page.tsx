import { Suspense } from "react";
import JiediaoClient from "./jiediao-client";

export const metadata = { title: "借调对账" };

export default function Page() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return <Suspense><JiediaoClient /></Suspense>;
}
