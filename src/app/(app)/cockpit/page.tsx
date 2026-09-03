import { Suspense } from "react";
import { Skeleton } from "antd";
import CockpitClient from "./cockpit-client";

export const metadata = { title: "驾驶舱四屏" };

/**
 * 驾驶舱四屏（D50）：数据来源与总量 / 预警 / 库存管控 / 日常事务。
 * Tab 写进 URL（?tab=sources|alerts|inventory|ops）；客户端用 useSearchParams，所以必须包 Suspense。
 */
export default function Page() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 12 }} />}>
      <CockpitClient />
    </Suspense>
  );
}
