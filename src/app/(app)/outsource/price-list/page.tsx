import { Suspense } from "react";
import PriceListClient from "./price-list-client";

export const metadata = { title: "采购价目表" };

export default function Page() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return <Suspense><PriceListClient /></Suspense>;
}
