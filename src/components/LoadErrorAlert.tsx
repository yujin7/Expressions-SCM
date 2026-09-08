"use client";

import { Alert, Button } from "antd";

interface LoadErrorAlertProps {
  error: string | null;
  onRetry: () => void;
  subject?: string;
  retrying?: boolean;
}

/**
 * 列表/报表首次加载的持久错误态。Toast 会消失，不能承担“当前数据未加载”的业务语义。
 */
export default function LoadErrorAlert({
  error,
  onRetry,
  subject = "数据",
  retrying = false,
}: LoadErrorAlertProps) {
  if (!error) return null;

  return (
    <Alert
      type="error"
      showIcon
      message={`${subject}加载失败`}
      description={`${error}。本次请求未完成，未返回的指标保持未知，不会用 0 代替；请重试。`}
      action={<Button size="small" aria-label={`重试${subject}`} aria-busy={retrying} loading={retrying} onClick={onRetry}>重试</Button>}
      style={{ marginBottom: 12 }}
    />
  );
}
