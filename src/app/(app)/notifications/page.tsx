import { Suspense } from "react";
import NotificationsClient from "./notifications-client";

export const metadata = { title: "通知中心" };

/** useListState（useSearchParams）必须有 Suspense 边界，否则整页水合失败 */
export default function Page() {
  return (
    <Suspense>
      <NotificationsClient />
    </Suspense>
  );
}
