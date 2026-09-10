import BinClient from "./bin-client";
import { Suspense } from "react";

export default function BinMasterPage() {
  return <Suspense fallback={<p>正在读取库位…</p>}><BinClient /></Suspense>;
}
