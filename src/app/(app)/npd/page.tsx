import { Suspense } from "react";
import NpdClientOnly from "./npd-client-only";

export const metadata = { title: "新品开发（NPD）" };

/** 页签写进 URL（`?tab=templates`）→ useSearchParams，必须包 Suspense 边界 */
export default function Page() {
  return (
    <Suspense>
      <NpdClientOnly />
    </Suspense>
  );
}
