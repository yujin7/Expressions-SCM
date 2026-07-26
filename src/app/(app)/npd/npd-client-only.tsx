"use client";

import dynamic from "next/dynamic";

const NpdProjectsClient = dynamic(() => import("./npd-projects-client"), {
  ssr: false,
  loading: () => (
    <div role="status" style={{ padding: 24 }}>
      正在加载 NPD 项目…
    </div>
  ),
});

export default function NpdClientOnly() {
  return <NpdProjectsClient />;
}
