import { Suspense } from "react";
import SupplierLifecycleClient from "./supplier-lifecycle-client";

export const metadata = { title: "供应商准入与整改" };

export default function Page() {
  return (
    <Suspense>
      <SupplierLifecycleClient />
    </Suspense>
  );
}
