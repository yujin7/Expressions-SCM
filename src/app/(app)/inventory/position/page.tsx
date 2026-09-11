import { Suspense } from "react";
import PositionClient from "./position-client";

export const metadata = { title: "库存日级走向" };

export default function Page() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><PositionClient /></Suspense>;
}
