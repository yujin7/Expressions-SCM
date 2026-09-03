import { Suspense } from "react";
import { Skeleton } from "antd";
import AlertsClient from "./alerts-client";

export const metadata = { title: "系统告警" };

/** 系统告警列表：筛选/分页写进 URL（useListState），必须包 Suspense。 */
export default function Page() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
      <AlertsClient />
    </Suspense>
  );
}
