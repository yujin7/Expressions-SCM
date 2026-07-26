import { Suspense } from "react";
import BatchTraceClient from "./batch-trace-client";

export const metadata = { title: "批次追溯" };

export default function Page() {
  return (
    <Suspense>
      <BatchTraceClient />
    </Suspense>
  );
}
