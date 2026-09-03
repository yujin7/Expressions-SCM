import { Suspense } from "react";
import { Skeleton } from "antd";
import DashboardClient from "./dashboard-client";
import { getFreshSessionUser } from "@/server/core/dto";
import { getDashboard } from "@/server/modules/report/dashboard";

export const metadata = { title: "经营驾驶舱" };

/**
 * 跨维筛选从 URL 读：本页是服务端取数后整体下发的，筛选走 searchParams
 * 才能保持"链接即口径"（复制链接给别人看到的是同一份筛选结果）。
 * 注意筛选**只作用于销售类聚合**，库存/临期/待审批等不跟随——
 * getDashboard 返回体的 scope.notAppliedTo 会把这一点交代给界面。
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string; channel?: string }>;
}) {
  const user = await getFreshSessionUser();
  const sp = await searchParams;
  // D62：整个身份（含回查 DB 的渠道范围）交给服务层，受限用户由 resolveChannelScope 强制裁剪
  const initialData = await getDashboard(user, {
    brand: sp.brand?.trim() || undefined,
    channel: sp.channel?.trim() || undefined,
  });
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 12 }} />}>
      <DashboardClient initialData={initialData} />
    </Suspense>
  );
}
