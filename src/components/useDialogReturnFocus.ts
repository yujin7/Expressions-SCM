"use client";

import { useCallback, useEffect, useRef } from "react";

/** Hidden responsive copies, disabled controls and inert/hidden regions are not return targets. */
export function canReturnDialogFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.closest('[inert], [hidden], [aria-hidden="true"]') || element.matches(':disabled, [aria-disabled="true"]')) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return element.getClientRects().length > 0 && style?.visibility !== "hidden" && style?.visibility !== "collapse";
}

/** For parent-owned dialogs removed on close. Capture the stable trigger, never a transient menu item.
 * A replacement key locates the same action after list refresh or desktop/mobile reconstruction.
 * Do not return focus on owner unmount, navigation, handoff to another dialog, or a newer user focus.
 */
export function useDialogReturnFocus(open: boolean) {
  const scopeRef = useRef<HTMLElement>(null);
  const target = useRef<{ element: HTMLElement | null; key?: string; href: string } | null>(null);
  const wasOpen = useRef(false);
  const remember = useCallback((element: HTMLElement | null, key?: string) => {
    target.current = { element, key, href: window.location.href };
  }, []);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed) return;
    const captured = target.current;
    const frame = requestAnimationFrame(() => {
      const scope = scopeRef.current;
      if (!scope?.isConnected || (captured && captured.href !== window.location.href)) return;
      const doc = scope.ownerDocument;
      // Unmount leaves BODY focused. Anything else belongs to the user or a new dialog.
      if (doc.activeElement && doc.activeElement !== doc.body) return;
      if (Array.from(doc.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).some(canReturnDialogFocus)) return;
      const replacement = captured?.key ? Array.from(scope.querySelectorAll<HTMLElement>('[data-dialog-return]'))
        .find(element => element.getAttribute("data-dialog-return") === captured.key && canReturnDialogFocus(element)) : null;
      const destination = [captured?.element ?? null, replacement ?? null, scope, scope.closest<HTMLElement>('[data-dialog-fallback]')].find(canReturnDialogFocus);
      destination?.focus(); // Reveal the returned control if it moved below the viewport.
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return { scopeRef, remember };
}
