"use client";

/**
 * 用户管理（仅 admin）：建号 / 角色 / 审批人 / 停用 / 重置密码。
 * 服务端已有自锁保护（不可停用自己、不可摘own admin）；前端同步禁用对应控件。
 */
import { useCallback, useEffect, useState } from "react";
import { App, Button, Form, Input, Modal, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { fetchJson, patchJson, postJson } from "@/components/fetchJson";
import { ROLE_LABELS } from "@/server/core/constants";
import type { UserRow } from "@/server/modules/admin/users";

const ROLE_OPTIONS = Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }));

export default function UsersClient() {
  const { message } = App.useApp();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [me, setMe] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState<UserRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, meRes] = await Promise.all([
        fetchJson<{ rows: UserRow[] }>("/api/admin/users"),
        fetchJson<{ id: number }>("/api/me"),
      ]);
      setRows(res.rows);
      setMe(meRes.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    const v = await createForm.validateFields();
    setSaving(true);
    try {
      await postJson("/api/admin/users", v);
      message.success(`已创建账号 ${v.username}`);
      setCreateOpen(false);
      createForm.resetFields();
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async () => {
    if (!editRow) return;
    const v = await editForm.validateFields();
    setSaving(true);
    try {
      await patchJson(`/api/admin/users/${editRow.id}`, { ...v, password: v.password?.trim() || undefined });
      message.success("已保存");
      setEditRow(null);
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<UserRow> = [
    { title: "ID", dataIndex: "id", width: 60 },
    { title: "账号", dataIndex: "username", width: 130, render: (v, r) => <>{v ?? "—"}{r.id === me ? <Tag style={{ marginLeft: 6 }}>本人</Tag> : null}</> },
    { title: "姓名", dataIndex: "name", width: 130 },
    {
      title: "角色",
      dataIndex: "roles",
      render: (roles: string[]) => roles.map((r) => <Tag key={r} color={r === "admin" ? "red" : "blue"}>{ROLE_LABELS[r as keyof typeof ROLE_LABELS] ?? r}</Tag>),
    },
    { title: "审批人", dataIndex: "isApprover", width: 90, render: (v: boolean) => (v ? <Tag color="green">是</Tag> : "—") },
    {
      title: "状态",
      dataIndex: "active",
      width: 110,
      render: (v: boolean, r) =>
        !v ? <Tag color="default">已停用</Tag> : r.lockedUntil && new Date(r.lockedUntil) > new Date() ? <Tag color="red">已锁定</Tag> : <Tag color="green">正常</Tag>,
    },
    {
      title: "操作",
      width: 90,
      render: (_, r) => (
        <Button
          type="link"
          size="small"
          onClick={() => {
            setEditRow(r);
            editForm.setFieldsValue({ name: r.name, roles: r.roles, isApprover: r.isApprover, active: r.active, password: "" });
          }}
        >
          编辑
        </Button>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ justifyContent: "space-between", width: "100%", marginBottom: 12 }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          用户管理
        </Typography.Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建账号
          </Button>
        </Space>
      </Space>
      <Table<UserRow>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={false}
        scroll={{ x: "max-content" }}
      />

      <Modal title="新建账号" open={createOpen} onOk={() => void handleCreate()} confirmLoading={saving} onCancel={() => setCreateOpen(false)} okText="创建" cancelText="取消">
        <Form form={createForm} layout="vertical" initialValues={{ roles: [], isApprover: false }}>
          <Form.Item name="username" label="账号" rules={[{ required: true, min: 3, message: "账号至少 3 位" }]}>
            <Input placeholder="登录用账号，如 pmc03" autoComplete="off" />
          </Form.Item>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: "姓名必填" }]}>
            <Input placeholder="真实姓名（审批留痕显示）" />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 8, message: "至少 8 位" }]}>
            <Input.Password placeholder="至少 8 位；请让同事首次登录后自行修改" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="roles" label="角色" rules={[{ required: true, message: "至少一个角色" }]}>
            <Select mode="multiple" options={ROLE_OPTIONS} placeholder="可多选" />
          </Form.Item>
          <Form.Item name="isApprover" label="审批人" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`编辑：${editRow?.username ?? ""}`} open={editRow != null} onOk={() => void handleEdit()} confirmLoading={saving} onCancel={() => setEditRow(null)} okText="保存" cancelText="取消">
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label="姓名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="roles" label="角色" rules={[{ required: true, message: "至少一个角色" }]}>
            <Select mode="multiple" options={ROLE_OPTIONS} disabled={editRow?.id === me} />
          </Form.Item>
          <Form.Item name="isApprover" label="审批人" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="active" label="启用" valuePropName="checked">
            <Switch disabled={editRow?.id === me} />
          </Form.Item>
          <Form.Item name="password" label="重置密码（留空=不改；重置同时解除锁定）">
            <Input.Password placeholder="至少 8 位" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
