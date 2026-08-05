"use client";

import { useEffect } from "react";
import { Button, Result, Space, Typography } from "antd";
import { HomeOutlined, ReloadOutlined } from "@ant-design/icons";
import { usePathname } from "next/navigation";
import { isStaleBundleError } from "@/components/stale-bundle";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  const reference = error.digest ? `错误编号 ${error.digest}` : "客户端页面异常";
  const message = error.message;
  const digest = error.digest;
  const stack = error.stack;
  const stale = isStaleBundleError(error);

  useEffect(() => {
    console.error("[app-error-boundary]", {
      pathname,
      message,
      digest,
      stack,
    });
  }, [digest, message, pathname, stack]);

  /*
   * 陈旧包体自愈：服务端重新构建后 BUILD_ID 变了，但用户标签页还引用旧 chunk，
   * 客户端跳转时取不到 → 整页落到这个边界。这不是业务缺陷，重新加载即可恢复，
   * 所以不该把它呈现成"本页无法显示"让人以为数据坏了。
   * 每个路径 30 秒内只自动重载一次——真正的渲染错误不会被反复刷新掩盖成死循环。
   */
  useEffect(() => {
    if (!stale || typeof window === "undefined") return;
    const key = `scm:stale-reload:${pathname}`;
    const last = Number(window.sessionStorage.getItem(key) ?? "0");
    if (Date.now() - last < 30_000) return;
    window.sessionStorage.setItem(key, String(Date.now()));
    window.location.reload();
  }, [stale, pathname]);

  return (
    <div className="app-error-boundary" role="alert">
      <Result
        status={stale ? "warning" : "error"}
        title={stale ? "版本已更新，正在重新加载…" : "本页暂时无法显示"}
        subTitle={
          <Space direction="vertical" size={2}>
            <Typography.Text type="secondary">
              页面：{pathname}
            </Typography.Text>
            <Typography.Text type="secondary">
              {stale
                ? "系统刚发布了新版本，当前标签页还在用旧版资源。页面会自动刷新；若没有反应，请手动刷新一次。"
                : `${reference}。可先重试本页；若仍失败，请把下面这一行发给管理员。`}
            </Typography.Text>
            {/* 错误原文必须可见：此前只 console.error，用户看不到，等于每次排障都要重新复现一遍 */}
            {!stale && message ? (
              <Typography.Text code copyable style={{ fontSize: 12 }}>
                {message.slice(0, 300)}
              </Typography.Text>
            ) : null}
          </Space>
        }
        extra={
          <Space wrap>
            <Button type="primary" icon={<ReloadOutlined />} onClick={reset}>
              重试本页
            </Button>
            <Button href="/workbench" icon={<HomeOutlined />}>
              返回工作台
            </Button>
          </Space>
        }
      />
    </div>
  );
}
