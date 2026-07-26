import { Suspense } from "react";
import PriceCompareClient from "./price-compare-client";

export const metadata = { title: "物料比价" };

export default function Page() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return <Suspense><PriceCompareClient /></Suspense>;
}
