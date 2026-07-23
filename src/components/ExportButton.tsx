"use client";

import { Button } from "antd";
import { DownloadOutlined } from "@ant-design/icons";

/**
 * 通用 CSV 导出按钮：href 由调用方按当前筛选拼好（/api/export/*），
 * window.open 交给浏览器按 Content-Disposition 下载（脱敏在服务端列级完成——R9 含导出）。
 */
export default function ExportButton({ href, label = "导出 CSV" }: { href: string; label?: string }) {
  return (
    <Button icon={<DownloadOutlined />} onClick={() => window.open(href, "_blank")}>
      {label}
    </Button>
  );
}
