"use client";

import { Button, Result } from "antd";

export default function ErrorBoundary({ reset }: { reset: () => void }) {
  return (
    <Result
      status="error"
      title="页面加载失败"
      subTitle="请重试；若问题持续，请记录当前页面和时间。"
      extra={<Button onClick={reset}>重新加载</Button>}
    />
  );
}
