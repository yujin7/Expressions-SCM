import { Suspense } from "react";
import ChecklistClient from "./checklist-client";

export const metadata = { title: "在案复核清单" };

export default function ReviewChecklistPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><ChecklistClient /></Suspense>;
}
