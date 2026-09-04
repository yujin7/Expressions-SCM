"use client";

import { useState } from "react";
import { App, Button } from "antd";
import { DownloadOutlined, CloudDownloadOutlined } from "@ant-design/icons";
import { postJson } from "./fetchJson";

/**
 * 通用 CSV 导出按钮（href 由调用方按当前筛选拼好 `/api/export/*`；脱敏在服务端列级完成——R9 含导出）。
 *
 * W2-4 修的真实缺陷：此前实现是把同步导出 URL 直接丢给浏览器新标签页。同步导出路由在超过 5000 行时返回
 * **202 `{jobId}`**（已自动建好异步任务），浏览器于是新开一个标签页把这段 JSON 原样显示出来——
 * 用户看到的是 `{"jobId":37,"message":"…"}`，既不像下载也不像错误。现在改为 fetch：
 * - 200 → 用 Blob 触发下载（文件名取服务端 Content-Disposition 的 filename\\*）；
 * - 202 → 提示「已转异步导出任务」并给出「导出任务」页入口，不再泄漏 JSON；
 * - 其他 → 读 message 报错。
 */

const EXPORT_JOBS_PATH = "/report/exports";

function filenameFromDisposition(disposition: string | null): string {
  if (!disposition) return "export.csv";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* 服务端总是 encodeURIComponent 过的；解码失败回落到普通 filename */
    }
  }
  const plain = /filename="([^"]+)"/i.exec(disposition);
  return plain?.[1] ?? "export.csv";
}

export default function ExportButton({ href, label = "导出 CSV" }: { href: string; label?: string }) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const res = await fetch(href, { credentials: "same-origin" });
      if (res.status === 202) {
        const body = (await res.json()) as { jobId?: number; message?: string };
        message.info(
          `${body.message ?? "已创建异步导出任务"}${body.jobId ? `（任务 #${body.jobId}）` : ""}`,
          5,
        );
        window.open(EXPORT_JOBS_PATH, "_blank");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { message?: string });
        throw new Error((body as { message?: string }).message || `导出失败（${res.status}）`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFromDisposition(res.headers.get("Content-Disposition"));
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button icon={<DownloadOutlined />} loading={loading} onClick={() => void run()}>
      {label}
    </Button>
  );
}

/**
 * 「转异步导出」按钮：直接 POST `/api/export/jobs` 建任务（EXPORT_KINDS 已登记的种类）。
 * 给的是那三个页面页脚一直在推销、却从来没有入口的那条路。
 */
export function AsyncExportButton({
  kind,
  params,
  label = "转异步导出",
}: {
  kind: string;
  params: Record<string, unknown>;
  label?: string;
}) {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const res = await postJson<{ job: { id: number } }>("/api/export/jobs", { kind, params });
      message.success(`已创建导出任务 #${res.job.id}，请到「导出任务」页下载`, 5);
      window.open(EXPORT_JOBS_PATH, "_blank");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button icon={<CloudDownloadOutlined />} loading={loading} onClick={() => void run()}>
      {label}
    </Button>
  );
}
