import { Suspense } from "react";
import TlClient from "./tl-client";

export default function MatflowTlPage() {
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><TlClient /></Suspense>;
}
