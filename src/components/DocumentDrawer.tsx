"use client";

import Link from "next/link";
import { Alert, Button, Drawer, Space, type DrawerProps } from "antd";
import { safeWorkReturn, type WorkReturn } from "@/lib/document-links";
import styles from "./DocumentDrawer.module.css";

/** Document titles stay readable; action rows wrap separately on narrow screens. */
export default function DocumentDrawer({ className, readError, onRetry, workReturn, children, ...props }: DrawerProps & {
  readError?: string | null; onRetry?: () => void; workReturn?: WorkReturn | null;
}) {
  const back = workReturn ? safeWorkReturn(workReturn.href) : null;
  const actions = readError ? null : props.extra;
  return <Drawer {...props} extra={back ? <Space wrap size={8}>
    <Link href={back.href} prefetch={false} style={{ display: "inline-block", minHeight: 24 }}>返回{back.label}</Link>{actions}
  </Space> : actions}
    loading={readError ? false : props.loading} className={[styles.drawer, className].filter(Boolean).join(" ")}>
    {readError ? <Alert type="error" showIcon message="单据详情暂不可用" description={readError}
      action={onRetry ? <Button onClick={onRetry}>重试</Button> : undefined} /> : children}
  </Drawer>;
}
