import { Suspense } from "react";
import { Skeleton } from "antd";

import DecisionStudioClient from "./decision-studio-client";

export const metadata = { title: "决策工作室" };

export default function Page() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 14 }} />}>
      <DecisionStudioClient />
    </Suspense>
  );
}
