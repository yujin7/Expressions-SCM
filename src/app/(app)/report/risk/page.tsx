import { Suspense } from "react";
import RiskClient from "./risk-client";

export const metadata = { title: "风险库存处置" };

export default function Page() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return <Suspense><RiskClient /></Suspense>;
}
