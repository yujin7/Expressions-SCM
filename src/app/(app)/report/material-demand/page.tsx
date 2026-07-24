import { Suspense } from "react";
import MaterialDemandClient from "./material-demand-client";

export const metadata = { title: "物料需求展开（MRP）" };

export default function Page() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return <Suspense><MaterialDemandClient /></Suspense>;
}
