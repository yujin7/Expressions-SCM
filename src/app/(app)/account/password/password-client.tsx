"use client";

/**
 * 自助改密码（UAT 缺口 #1）：原密码 + 新密码 + 确认。
 * 成功后注销全部旧会话并要求用新密码重登；首登强制修改由布局层重定向到本页。
 */
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { LockOutlined } from "@ant-design/icons";
import { fetchJson } from "@/components/fetchJson";

interface FormValues {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export default function PasswordClient() {
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const current = useRef<{ controller: AbortController; timer?: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => () => {
    const attempt = current.current;
    current.current = null;
    if (attempt) { clearTimeout(attempt.timer); attempt.controller.abort(); }
  }, []);

  const onFinish = async (v: FormValues) => {
    if (submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    const attempt: NonNullable<typeof current.current> = { controller: new AbortController() };
    current.current = attempt;
    attempt.timer = setTimeout(() => {
      if (current.current !== attempt) return;
      current.current = null;
      attempt.controller.abort();
      submitting.current = false;
      setSaving(false);
      setError("等待修改结果超时。密码可能已修改，请先尝试用新密码登录，勿重复提交。");
    }, 15_000);
    try {
      const result = await fetchJson<{ ok: boolean }>("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword: v.oldPassword, newPassword: v.newPassword }),
        signal: attempt.controller.signal,
      });
      if (current.current !== attempt) return;
      if (result?.ok !== true) throw new Error("修改结果未确认，请先尝试用新密码登录，勿重复提交");
    } catch (e) {
      if (current.current !== attempt) return;
      setError(e instanceof Error ? e.message : "修改结果未确认，请先尝试用新密码登录，勿重复提交");
      submitting.current = false;
      setSaving(false);
      return;
    } finally {
      clearTimeout(attempt.timer);
      if (current.current === attempt) current.current = null;
    }
    // The server has atomically invalidated every old session. A second logout
    // request must not turn that committed password change into a reported failure.
    form.resetFields();
    setSaved(true);
    setSaving(false);
    try { window.location.replace("/login?passwordChanged=1"); } catch { /* The confirmed receipt retains an explicit login link. */ }
  };

  return (
    <Card style={{ maxWidth: 480, margin: "40px auto" }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        <LockOutlined style={{ marginRight: 8 }} />
        修改密码
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        新密码为 8–72 位，且不能与原密码相同；修改成功后所有旧会话立即失效，请重新登录。若使用管理员重置的临时密码，请将它填在「原密码」。
      </Typography.Paragraph>
      {saved ? <Alert type="success" showIcon message="密码已修改，请使用新密码重新登录" description={<Typography.Link href="/login?passwordChanged=1">前往登录</Typography.Link>} /> : null}
      {error ? <Alert type="error" showIcon role="alert" message={error} description={<Typography.Link href="/login">前往登录核对密码</Typography.Link>} style={{ marginBottom: 16 }} /> : null}
      {!saved ? <Form<FormValues> form={form} layout="vertical" onFinish={onFinish} disabled={saving}>
        <Form.Item name="oldPassword" label="原密码" rules={[{ required: true, message: "请输入原密码" }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码"
          dependencies={["oldPassword"]}
          rules={[
            { required: true, message: "请输入新密码" },
            { min: 8, message: "至少 8 位" },
            { max: 72, message: "最多 72 位" },
            ({ getFieldValue }) => ({
              validator: (_, value: string) =>
                value && value === getFieldValue("oldPassword")
                  ? Promise.reject(new Error("新密码不能与原密码相同"))
                  : Promise.resolve(),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label="确认新密码"
          dependencies={["newPassword"]}
          rules={[
            { required: true, message: "请再次输入新密码" },
            ({ getFieldValue }) => ({
              validator: (_, value: string) =>
                !value || value === getFieldValue("newPassword")
                  ? Promise.resolve()
                  : Promise.reject(new Error("两次输入的密码不一致")),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0 }}>
          <Button type="primary" htmlType="submit" loading={saving} block>
            确认修改
          </Button>
        </Form.Item>
      </Form> : null}
    </Card>
  );
}
