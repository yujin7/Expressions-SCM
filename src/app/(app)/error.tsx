"use client";

import { Button, Result, Space, Typography } from "antd";
import { HomeOutlined, ReloadOutlined } from "@ant-design/icons";
import { usePathname } from "next/navigation";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  const reference = error.digest ? `错误编号 ${error.digest}` : "客户端页面异常";

  return (
    <div className="app-error-boundary" role="alert">
      <Result
        status="error"
        title="本页暂时无法显示"
        subTitle={
          <Space direction="vertical" size={2}>
            <Typography.Text type="secondary">
              页面：{pathname}
            </Typography.Text>
            <Typography.Text type="secondary">
              {reference}。可先重试本页；若仍失败，请把这一行发给管理员。
            </Typography.Text>
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
