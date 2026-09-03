import { Suspense } from "react";
import { Skeleton } from "antd";
import AlertsClient from "./alerts-client";

export const metadata = { title: "库存预警与爆单" };

/** 库存预警表 + 爆单预警（D56/D57）。Tab 与筛选写进 URL（useListState），必须包 Suspense。 */
export default function Page() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
      <AlertsClient />
    </Suspense>
  );
}
