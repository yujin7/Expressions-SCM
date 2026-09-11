import WarehouseClient from "./warehouse-client";
import { Suspense } from "react";

export default function WarehousePage() {
  return <Suspense fallback={<p>正在读取仓库…</p>}><WarehouseClient /></Suspense>;
}
