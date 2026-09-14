import { Suspense } from "react";
import AutoReplenishClient from "./auto-replenish-client";

export const metadata = { title: "自动补货候选" };

export default function Page() {
  return <Suspense><AutoReplenishClient /></Suspense>;
}
