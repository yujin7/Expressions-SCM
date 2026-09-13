import type { ModalProps } from "antd";

/** Keep long form actions visible on narrow/short screens; scroll only the body. */
export const viewportModalProps = {
  centered: true,
  style: { maxWidth: "calc(100vw - 32px)", paddingBottom: 0 },
  styles: {
    content: { maxHeight: "calc(100dvh - 32px)", display: "flex", flexDirection: "column" },
    body: { minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" },
    header: { flexShrink: 0, paddingInlineEnd: 32, overflowWrap: "anywhere" },
    footer: { flexShrink: 0 },
  },
} satisfies Pick<ModalProps, "centered" | "style" | "styles">;
