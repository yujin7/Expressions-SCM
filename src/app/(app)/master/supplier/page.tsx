import SupplierClient from "./supplier-client";
import { Suspense } from "react";

export default function SupplierPage() {
  return <Suspense fallback={<p>正在读取供应商…</p>}><SupplierClient /></Suspense>;
}
