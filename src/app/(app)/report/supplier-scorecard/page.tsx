import { Suspense } from "react";
import SupplierScorecardClient from "./supplier-scorecard-client";

export const metadata = { title: "供应商记分卡" };

export default function Page() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><SupplierScorecardClient /></Suspense>;
}
