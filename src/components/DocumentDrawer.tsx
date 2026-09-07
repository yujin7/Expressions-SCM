"use client";

import { Alert, Button, Drawer, type DrawerProps } from "antd";
import styles from "./DocumentDrawer.module.css";

/** Document titles stay readable; action rows wrap separately on narrow screens. */
export default function DocumentDrawer({ className, readError, onRetry, children, ...props }: DrawerProps & {
  readError?: string | null; onRetry?: () => void;
}) {
  return <Drawer {...props} extra={readError ? null : props.extra}
    loading={readError ? false : props.loading} className={[styles.drawer, className].filter(Boolean).join(" ")}>
    {readError ? <Alert type="error" showIcon message="单据详情暂不可用" description={readError}
      action={onRetry ? <Button onClick={onRetry}>重试</Button> : undefined} /> : children}
  </Drawer>;
}
