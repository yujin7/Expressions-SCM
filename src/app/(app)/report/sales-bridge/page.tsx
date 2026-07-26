import { Suspense } from "react";
import SalesBridgeClient from "./sales-bridge-client";

export const metadata = { title: "销量变化归因" };

export default function Page() {
  return <Suspense><SalesBridgeClient /></Suspense>;
}
