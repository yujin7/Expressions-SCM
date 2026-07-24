import { Suspense } from "react";
import ForecastAccuracyClient from "./forecast-accuracy-client";

export const metadata = { title: "预测复盘" };

export default function Page() {
  // useSearchParams（列表页状态平台 E6-P1）需要 Suspense 边界
  return <Suspense><ForecastAccuracyClient /></Suspense>;
}
