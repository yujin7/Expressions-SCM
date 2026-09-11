import InboundCalendarClient from "./inbound-calendar-client";
import { Suspense } from "react";

export const metadata = { title: "到货日历" };

export default function Page() {
  return <Suspense fallback={<p>正在读取到货与承诺数据…</p>}><InboundCalendarClient /></Suspense>;
}
