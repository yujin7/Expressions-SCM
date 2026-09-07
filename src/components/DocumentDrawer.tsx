"use client";

import { Drawer, type DrawerProps } from "antd";
import styles from "./DocumentDrawer.module.css";

/** Document titles stay readable; action rows wrap separately on narrow screens. */
export default function DocumentDrawer({ className, ...props }: DrawerProps) {
  return <Drawer {...props} className={[styles.drawer, className].filter(Boolean).join(" ")} />;
}
