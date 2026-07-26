import { Suspense } from "react";
import { Skeleton } from "antd";
import DashboardClient from "./dashboard-client";
import { getFreshSessionUser } from "@/server/core/dto";
import { getDashboard } from "@/server/modules/report/dashboard";

export const metadata = { title: "经营驾驶舱" };

export default async function Page() {
  const user = await getFreshSessionUser();
  const initialData = await getDashboard(user.roles);
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 12 }} />}>
      <DashboardClient initialData={initialData} />
    </Suspense>
  );
}
