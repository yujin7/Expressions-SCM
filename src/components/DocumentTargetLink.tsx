"use client";

import type { MouseEvent, ReactNode } from "react";
import { Typography } from "antd";
import { usePathname, useSearchParams } from "next/navigation";
import { documentTargetPath } from "@/lib/document-links";

/** A wrapped document number must have one continuous pointer and keyboard target. */
export default function DocumentTargetLink({ id, onOpen, children }: {
  id: number;
  onOpen: (id: number) => void;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  return <Typography.Link
    href={documentTargetPath(pathname, search.toString(), id)}
    style={{ display: "inline-block", minHeight: 24, maxWidth: "100%", overflowWrap: "anywhere" }}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      // Modified clicks retain native open-in-tab/window behavior and a copyable URL.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpen(id);
    }}
  >{children}</Typography.Link>;
}
