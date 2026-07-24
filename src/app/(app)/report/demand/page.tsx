import { Suspense } from "react";
import DemandClient from "./demand-client";

export const metadata = { title: "需求达成参考" };

export default function Page() {
  return <Suspense><DemandClient /></Suspense>;
}
