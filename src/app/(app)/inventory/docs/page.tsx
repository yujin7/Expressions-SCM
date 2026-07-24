import { Suspense } from "react";
import DocsClient from "./docs-client";

export default function InventoryDocsPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><DocsClient /></Suspense>;
}
