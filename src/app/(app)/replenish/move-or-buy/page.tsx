import { Suspense } from "react";
import MoveOrBuyClient from "./move-or-buy-client";

export const metadata = { title: "先挪后买 · 统一决策表" };

/** useListState（useSearchParams）必须有 Suspense 边界，否则整页水合失败 */
export default function Page() {
  return (
    <Suspense>
      <MoveOrBuyClient />
    </Suspense>
  );
}
