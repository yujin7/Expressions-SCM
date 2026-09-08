import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import ReplenishClient from "./replenish-client";

export default async function ReplenishPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  // Older spike read-model caches and shared links used sku; this list consumes q.
  // Normalize before mounting so no unfiltered request or stale saved view flashes.
  if (query.sku !== undefined) {
    const canonical = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key === "sku" || value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) canonical.append(key, entry);
    }
    // Explicit q (even empty) wins. Never guess between ambiguous legacy targets.
    if (query.q === undefined) {
      if (Array.isArray(query.sku)) notFound();
      canonical.set("q", query.sku);
    }
    redirect(`/replenish?${canonical}`);
  }
  // useSearchParams（列表页状态平台）需要 Suspense 边界
  return <Suspense><ReplenishClient /></Suspense>;
}
