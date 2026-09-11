"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { documentTarget, documentTargetPath } from "@/lib/document-links";

/** URL owns selection; native history integrates with Next without a server navigation waterfall. */
export function useDocumentTarget() {
  const search = useSearchParams();
  const target = documentTarget(search.toString());
  const setId = useCallback((id: number | null) => {
    const { pathname, search, hash } = window.location;
    const next = documentTargetPath(pathname, search, id, hash);
    if (next === `${pathname}${search}${hash}`) return;
    if (id === null) window.history.replaceState(null, "", next);
    else window.history.pushState(null, "", next);
  }, []);
  return { ...target, setId };
}
