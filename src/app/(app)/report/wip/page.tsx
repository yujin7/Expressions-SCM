import { Suspense } from "react";
import WipClient from "./wip-client";

export default function ReportWipPage() {
  return <Suspense><WipClient /></Suspense>;
}
