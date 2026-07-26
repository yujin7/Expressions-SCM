import { Suspense } from "react";
import FunnelClient from "./funnel-client";

export const metadata = { title: "全链达成漏斗" };

export default function Page() {
  return <Suspense><FunnelClient /></Suspense>;
}
