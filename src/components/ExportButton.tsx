"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Space, Typography } from "antd";
import { DownloadOutlined, CloudDownloadOutlined } from "@ant-design/icons";
import { serverErrorMessage } from "./fetchJson";

/**
 * 通用 CSV 导出按钮（href 由调用方按当前筛选拼好 `/api/export/*`；脱敏在服务端列级完成——R9 含导出）。
 *
 * W2-4 修的真实缺陷：此前实现是把同步导出 URL 直接丢给浏览器新标签页。同步导出路由在超过 5000 行时返回
 * **202 `{jobId}`**（已自动建好异步任务），浏览器于是新开一个标签页把这段 JSON 原样显示出来——
 * 用户看到的是 `{"jobId":37,"message":"…"}`，既不像下载也不像错误。现在改为 fetch：
 * - 200 → 用 Blob 触发下载（文件名取服务端 Content-Disposition 的 filename\\*）；
 * - 202 → 持续展示任务回执和「导出任务」入口，不依赖弹窗或自动重试；
 * - 其他 → 持续错误、30秒超时与停止等待；查询变化/卸载取消本次读取，不下载迟到文件。
 * 停止等待不声称取消后台任务；回执未知时先查任务，避免自动重复创建。
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

export default function ExportButton({ href: endpoint, label = "导出 CSV", mode = "export", job }: {
  href: string;
  label?: string;
  mode?: "export" | "download";
  /** Only AsyncExportButton supplies this; both entry paths share one bounded lifecycle. */
  job?: { kind: string; params: Record<string, unknown> };
}) {
  const requestBody = job ? JSON.stringify(job) : undefined;
  // Primitive identity: inline params objects can be recreated without cancelling a request.
  // Changed filters immediately withdraw the old receipt and invalidate its late response.
  const href = requestBody ? JSON.stringify([endpoint, requestBody]) : endpoint;
  const active = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout>; href: string } | null>(null);
  const [state, setState] = useState<{ href: string; busy: boolean; notice?: string; failed?: boolean; jobs?: boolean } | null>(null);
  const visible = state?.href === href ? state : null;
  useEffect(() => () => {
    if (active.current) { clearTimeout(active.current.timer); active.current.controller.abort(); active.current = null; }
  }, [href]);

  const cancel = () => {
    if (!active.current) return;
    clearTimeout(active.current.timer); active.current.controller.abort(); active.current = null;
    setState({ href, busy: false, notice: mode === "download" ? "已停止下载等待；可重新下载，无需创建新任务。" : "已停止等待；不会取消已创建的后台任务，请先核对导出任务。", jobs: mode === "export" });
  };

  const run = async () => {
    if (active.current) return;
    const controller = new AbortController();
    const request = { controller, href, timer: setTimeout(() => {
      if (active.current !== request) return;
      controller.abort(); active.current = null;
      setState({ href, busy: false, failed: true, notice: mode === "download" ? "文件下载超时，请重新下载；不会创建新任务。" : "导出等待超时；后台任务可能已创建，请先核对再重试。", jobs: mode === "export" });
    }, 30000) };
    active.current = request;
    const current = () => active.current === request && !controller.signal.aborted;
    setState({ href, busy: true });
    try {
      const res = await fetch(endpoint, {
        credentials: "same-origin", signal: controller.signal,
        ...(requestBody ? { method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody } : {}),
      });
      if (!current()) return;
      if (requestBody && res.ok) {
        const body = (await res.json().catch(() => null)) as { job?: { id?: unknown } } | null;
        if (!current()) return;
        const jobId = body?.job?.id;
        if (res.status !== 201 || !Number.isSafeInteger(jobId) || Number(jobId) <= 0) throw new Error("导出任务回执不完整，请核对任务列表");
        setState({ href, busy: false, notice: `已创建导出任务 #${jobId}；按本次筛选读取执行时最新数据。`, jobs: true });
        return;
      }
      if (res.status === 202) {
        if (mode === "download") throw new Error("文件尚未生成，请刷新任务状态后重试");
        const body = (await res.json().catch(() => null)) as { jobId?: number; message?: string } | null;
        if (!current()) return;
        if (!body || !Number.isSafeInteger(body.jobId) || Number(body.jobId) <= 0) throw new Error("导出任务回执不完整，请核对任务列表");
        setState({ href, busy: false, notice: `${body.message ?? "已创建异步导出任务"}（任务 #${body.jobId}）`, jobs: true });
        return;
      }
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw new Error(serverErrorMessage(body) ?? `${mode === "download" ? "下载" : "导出"}失败（${res.status}）`);
      }
      if (!res.headers.get("Content-Type")?.toLowerCase().includes("text/csv")) throw new Error("未收到CSV文件，请检查登录状态后重试");
      const blob = await res.blob();
      if (!current()) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFromDisposition(res.headers.get("Content-Disposition"));
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setState({ href, busy: false, notice: "下载已开始" });
    } catch (e) {
      if (current()) setState({ href, busy: false, failed: true, notice: mode === "download" ? (e as Error).message : `${(e as Error).message}；如请求已提交，请先核对导出任务。`, jobs: mode === "export" });
    } finally {
      clearTimeout(request.timer);
      if (active.current === request) active.current = null;
    }
  };

  return (
    <Space direction="vertical" size={4} style={{ maxWidth: "100%", minWidth: 0 }}>
      <Space wrap size={4}>
        <Button icon={job ? <CloudDownloadOutlined /> : <DownloadOutlined />} aria-label={label} aria-busy={visible?.busy ?? false} loading={visible?.busy} onClick={() => void run()}>{label}</Button>
        {visible?.busy ? <Button onClick={cancel} title={mode === "download" ? "仅停止本次文件下载，不删除任务或文件" : "停止等待不会取消已创建的后台任务"}>停止等待</Button> : null}
      </Space>
      {visible?.notice ? <div role={visible.failed ? "alert" : "status"} style={{ maxWidth: 320, overflowWrap: "anywhere" }}>
        <Typography.Text type={visible.failed ? "danger" : "secondary"}>{visible.notice}</Typography.Text>
        {visible.jobs ? <> <a href={EXPORT_JOBS_PATH}>查看导出任务</a></> : null}
      </div> : null}
    </Space>
  );
}

/**
 * 「转异步导出」按钮：直接 POST `/api/export/jobs` 建任务（EXPORT_KINDS 已登记的种类）。
 * 复用同步转异步入口的防重、停止等待、超时、查询绑定和持续任务回执。
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
  return <ExportButton href="/api/export/jobs" label={label} job={{ kind, params }} />;
}
