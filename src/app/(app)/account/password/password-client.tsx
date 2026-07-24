"use client";

/**
 * 自助改密码（UAT 缺口 #1）：原密码 + 新密码 + 确认。
 * 成功后提示并跳转工作台；首登强制修改（mustChangePassword）由布局层重定向到本页。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Card, Form, Input, Typography } from "antd";
import { LockOutlined } from "@ant-design/icons";
import { postJson } from "@/components/fetchJson";

interface FormValues {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export default function PasswordClient() {
  const { message } = App.useApp();
  const router = useRouter();
  const [form] = Form.useForm<FormValues>();
  const [saving, setSaving] = useState(false);

  const onFinish = async (v: FormValues) => {
    setSaving(true);
    try {
      await postJson("/api/account/password", {
        oldPassword: v.oldPassword,
        newPassword: v.newPassword,
      });
      message.success("密码已修改");
      router.replace("/workbench");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card style={{ maxWidth: 480, margin: "40px auto" }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        <LockOutlined style={{ marginRight: 8 }} />
        修改密码
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        新密码至少 8 位，且不能与原密码相同；修改成功后返回工作台。
      </Typography.Paragraph>
      <Form<FormValues> form={form} layout="vertical" onFinish={(v) => void onFinish(v)}>
        <Form.Item name="oldPassword" label="原密码" rules={[{ required: true, message: "请输入原密码" }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[
            { required: true, message: "请输入新密码" },
            { min: 8, message: "至少 8 位" },
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
      </Form>
    </Card>
  );
}
