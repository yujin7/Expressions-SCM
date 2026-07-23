"use client";

import { useState } from "react";
import { App, Button, Card, Divider, Form, Input, Tooltip, Typography } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "用户名或密码错误",
  disabled: "账号已停用，请联系管理员",
  locked: "连续失败次数过多，账号已锁定，请 15 分钟后重试",
};

function getCallbackUrl(): string {
  if (typeof window === "undefined") return "/";
  const raw = new URLSearchParams(window.location.search).get("callbackUrl");
  // 仅允许站内相对路径，防开放重定向
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/";
}

function LoginFormInner({ feishuEnabled }: { feishuEnabled: boolean }) {
  const { message } = App.useApp();
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await signIn("local", {
        username: values.username,
        password: values.password,
        redirect: false,
      });
      if (res?.error) {
        message.error(ERROR_MESSAGES[res.code ?? ""] ?? "登录失败，请重试");
        return;
      }
      const target = getCallbackUrl();
      router.replace(target);
      router.refresh();
    } catch {
      message.error("登录失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  const feishuButton = (
    <Button
      block
      size="large"
      disabled={!feishuEnabled}
      onClick={() => {
        void signIn("feishu", { redirectTo: getCallbackUrl() });
      }}
    >
      飞书扫码登录
    </Button>
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f0f2f5",
      }}
    >
      <Card style={{ width: 380 }}>
        <Typography.Title level={4} style={{ textAlign: "center", marginBottom: 24 }}>
          供应链系统登录
        </Typography.Title>
        <Form<{ username: string; password: string }> onFinish={onFinish} size="large">
          <Form.Item name="username" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 12 }}>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form.Item>
        </Form>
        <Divider plain style={{ margin: "12px 0" }}>
          或
        </Divider>
        {feishuEnabled ? (
          feishuButton
        ) : (
          <Tooltip title="未配置飞书应用">{feishuButton}</Tooltip>
        )}
      </Card>
    </div>
  );
}

export default function LoginForm({ feishuEnabled }: { feishuEnabled: boolean }) {
  return (
    <App>
      <LoginFormInner feishuEnabled={feishuEnabled} />
    </App>
  );
}
