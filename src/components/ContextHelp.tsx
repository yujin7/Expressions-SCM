"use client";

import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { CloseOutlined, InfoCircleOutlined } from "@ant-design/icons";
import { Dropdown } from "antd";

/** Shared non-modal explanation. Uses the existing floating layer, not a second metric definition. */
export default function ContextHelp({ label, title, content, children, className = "" }: {
  label: string;
  title: string;
  content: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (!next || (!trigger.current?.contains(next) && !panel.current?.contains(next))) setOpen(false);
  };
  const onKey = (event: KeyboardEvent<HTMLElement>, inside: boolean) => {
    if (!open || !["Escape", "Tab"].includes(event.key)) return;
    // rc-dropdown owns global menu keys; explanation content must keep its own tab order and IME.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (!inside) {
      if (event.shiftKey) setOpen(false);
      else { event.preventDefault(); panel.current?.focus(); }
      return;
    }
    const targets = Array.from(panel.current?.querySelectorAll<HTMLElement>(
      'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
    ) ?? []).filter(node => node.getClientRects().length > 0 && node.tabIndex >= 0);
    const active = document.activeElement;
    if ((event.shiftKey && (active === panel.current || active === targets[0])) ||
      (!event.shiftKey && active === targets.at(-1))) {
      // Leave the disclosure without trapping focus in a body-level portal.
      event.preventDefault(); close();
    }
  };

  return (
    <Dropdown open={open} onOpenChange={setOpen} trigger={["click"]} placement="bottomLeft"
      autoAdjustOverflow destroyOnHidden overlayClassName="scm-context-help-layer"
      overlayStyle={{ padding: 8 }}
      // rc-trigger reapplies the placement offset after shifting. Dropdown's default
      // ±4px offset can still clip a long dialog at a viewport edge; use zero here.
      align={{ offset: [0, 0], overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true } }}
      popupRender={() => (
        <section ref={panel} id={id} role="dialog" aria-labelledby={`${id}-title`} tabIndex={-1}
          className="context-help-panel" onBlur={onBlur} onKeyDown={event => onKey(event, true)}>
          <header className="context-help-panel__header">
            <strong id={`${id}-title`}>{title}</strong>
            <button type="button" className="context-help-trigger" aria-label={`关闭${title}`} onClick={close}>
              <CloseOutlined aria-hidden />
            </button>
          </header>
          <div className="context-help-panel__content">{content}</div>
        </section>
      )}>
      <button ref={trigger} type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? id : undefined} className={`context-help-trigger ${className}`}
        onBlur={onBlur} onKeyDown={event => onKey(event, false)}>
        {children ?? <InfoCircleOutlined aria-hidden />}
      </button>
    </Dropdown>
  );
}
