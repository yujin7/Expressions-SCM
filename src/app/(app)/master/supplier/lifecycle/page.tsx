import { Suspense } from "react";
import SupplierLifecycleClient from "./supplier-lifecycle-client";

export const metadata = { title: "供应商工作项 · 准入、整改与账期谈判" };

export default function Page() {
  return (
    <Suspense>
      <SupplierLifecycleClient />
    </Suspense>
  );
}
