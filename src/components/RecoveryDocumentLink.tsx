"use client";

import type { MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { DOCUMENT_PAGES, recoveryDocumentHref } from "@/lib/document-links";

/** Native copy/new-tab links; same-page activation keeps the mounted workspace and its read context. */
export default function RecoveryDocumentLink({ docType, id, children, onOpen }: {
  docType: string; id: number; children: ReactNode; onOpen?: () => void;
}) {
  const pathname = usePathname(), search = useSearchParams();
  const href = recoveryDocumentHref(docType, id, pathname, search.toString());
  if (!href) return <span>{children}</span>;
  return <Link href={href} prefetch={false} scroll={false}
    style={{ display: "inline-block", minHeight: 24, maxWidth: "100%", overflowWrap: "anywhere" }}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const current = window.location;
      if (DOCUMENT_PAGES[docType] !== current.pathname) return;
      const next = recoveryDocumentHref(docType, id, current.pathname, current.search, current.hash);
      if (!next) return;
      event.preventDefault();
      onOpen?.();
      if (next !== `${current.pathname}${current.search}${current.hash}`) window.history.pushState(null, "", next);
    }}>{children}</Link>;
}
