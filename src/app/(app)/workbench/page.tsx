import { Suspense } from "react";
import WorkbenchClient from "./workbench-client";

export const metadata = { title: "工作台" };

/** `?view=digest` 走 useSearchParams（简报视图并入本页），必须包 Suspense 边界 */
export default function WorkbenchPage() {
  return (
    <Suspense>
      <WorkbenchClient />
    </Suspense>
  );
}
