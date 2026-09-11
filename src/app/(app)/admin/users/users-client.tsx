"use client";

/**
 * 用户管理（仅 admin）：建号 / 角色 / 审批人 / 停用 / 重置密码 / 数据范围（D62）。
 * 服务端已有自锁保护（不可停用自己、不可摘own admin）；前端同步禁用对应控件。
 * 数据范围：渠道多选 + 部门（=角色）多选，PUT /api/admin/users/[id]/scopes 整体替换；
 * 范围变化会令该用户既有会话失效（服务端 bump session_version），页面据返回的 sessionInvalidated 提示。
 */
import { useCallback, useEffect, useState } from "react";
import { App, Alert, Button, Form, Input, Modal, Select, Space, Switch, Table, Tag, Typography } from "antd";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { fetchJson, patchJson, postJson, putJson } from "@/components/fetchJson";
import RemoteSelect from "@/components/RemoteSelect";
import { ROLE_LABELS } from "@/server/core/constants";
import type { UserScopesResult } from "@/server/modules/admin/user-scopes";
import type { UserRow } from "@/server/modules/admin/users";

const ROLE_OPTIONS = Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }));
/** 部门先=角色（D61）；admin 不受范围限制，不作为部门键提供 */
const DEPT_OPTIONS = ROLE_OPTIONS.filter((o) => o.value !== "admin");

export default function UsersClient() {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [me, setMe] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState<UserRow | null>(null);
  const [bindRow, setBindRow] = useState<UserRow | null>(null);
  const [scopeRow, setScopeRow] = useState<UserRow | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [bindForm] = Form.useForm();
  const [scopeForm] = Form.useForm<{ channelIds: number[]; deptKeys: string[] }>();

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

  const handleBindFeishu = async () => {
    if (!bindRow) return;
    const v = await bindForm.validateFields();
    setSaving(true);
    try {
      await putJson(`/api/admin/users/${bindRow.id}/feishu-binding`, { unionId: v.unionId });
      message.success("已绑定飞书登录");
      setBindRow(null);
      bindForm.resetFields();
      if (bindRow.id === me) {
        window.location.assign("/signout");
        return;
      }
      void load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** D62：打开数据范围抽屉——先从服务端取当前范围（唯一权威），再回填表单 */
  const openScope = async (row: UserRow) => {
    setScopeRow(row);
    scopeForm.setFieldsValue({ channelIds: [], deptKeys: [] });
    setScopeLoading(true);
    try {
      const cur = await fetchJson<UserScopesResult>(`/api/admin/users/${row.id}/scopes`);
      scopeForm.setFieldsValue({ channelIds: cur.channelScope ?? [], deptKeys: cur.deptScope ?? [] });
    } catch (e) {
      message.error((e as Error).message);
      setScopeRow(null);
    } finally {
      setScopeLoading(false);
    }
  };

  const handleSaveScope = async () => {
    if (!scopeRow) return;
    const v = await scopeForm.validateFields();
    setSaving(true);
    try {
      // [] = 清空（= 不限）；两类都整体替换
      const r = await putJson<UserScopesResult>(`/api/admin/users/${scopeRow.id}/scopes`, {
        channelIds: v.channelIds ?? [],
        deptKeys: v.deptKeys ?? [],
      });
      message.success(
        r.sessionInvalidated
          ? `已保存 ${scopeRow.name} 的数据范围；该用户既有会话已失效，需重新登录后生效`
          : `已保存 ${scopeRow.name} 的数据范围（无变化）`,
      );
      setScopeRow(null);
      if (r.sessionInvalidated && scopeRow.id === me) {
        window.location.assign("/signout");
      }
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const confirmUnbindFeishu = (row: UserRow) => {
    modal.confirm({
      title: `解绑 ${row.name} 的飞书登录？`,
      content: "解绑后已登录会话将失效；本页不会显示或回传 union ID。",
      okText: "确认解绑",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        try {
          await fetchJson(`/api/admin/users/${row.id}/feishu-binding`, { method: "DELETE" });
          message.success("已解绑飞书登录");
          if (row.id === me) {
            window.location.assign("/signout");
            return;
          }
          await load();
        } catch (error) {
          message.error((error as Error).message);
          throw error;
        }
      },
    });
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
      render: (v: boolean) =>
        !v ? <Tag color="default">已停用</Tag> : <Tag color="green">正常</Tag>,
    },
    {
      title: "飞书登录",
      dataIndex: "feishuBound",
      width: 105,
      render: (v: boolean) => (v ? <Tag color="blue">已绑定</Tag> : <Tag>未绑定</Tag>),
    },
    {
      title: "操作",
      width: 260,
      render: (_, r) => (
        <Space size={0}>
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
          <Button type="link" size="small" onClick={() => void openScope(r)}>
            数据范围
          </Button>
          {r.feishuBound ? (
            <Button type="link" danger size="small" disabled={!r.active} onClick={() => confirmUnbindFeishu(r)}>
              解绑飞书
            </Button>
          ) : (
            <Button
              type="link"
              size="small"
              disabled={!r.active}
              onClick={() => {
                setBindRow(r);
                bindForm.resetFields();
              }}
            >
              绑定飞书
            </Button>
          )}
        </Space>
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

      <Modal
        title={`数据范围：${scopeRow?.name ?? ""}`}
        open={scopeRow != null}
        onOk={() => void handleSaveScope()}
        confirmLoading={saving}
        onCancel={() => setScopeRow(null)}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: scopeLoading }}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="渠道范围只对非管理员生效（D62）"
          description={
            <>
              留空 = 不限。登记了渠道后，该用户在经营驾驶舱 / 决策工作室 / 销量归因 / 备货申请列表只看到所选渠道；
              库存总量、临期、到货日历等非渠道维内容仍公开；销售金额对运营角色始终不下发。
              范围变化会令其既有登录失效，需重新登录。
            </>
          }
        />
        <Form form={scopeForm} layout="vertical" disabled={scopeLoading}>
          <Form.Item name="channelIds" label="可见渠道（多选，留空=不限）">
            <RemoteSelect
              api="/api/master/channel"
              mode="multiple"
              getLabel={(r) => `${String(r.name ?? r.code)}${r.active === false ? "（停用）" : ""}`}
              placeholder="选择渠道主档中的渠道"
              loading={scopeLoading}
            />
          </Form.Item>
          <Form.Item name="deptKeys" label="所属部门（=角色，多选，留空=不限；用于部门维目标查阅）">
            <Select mode="multiple" options={DEPT_OPTIONS} placeholder="选择部门" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`绑定飞书登录：${bindRow?.name ?? ""}`}
        open={bindRow != null}
        onOk={() => void handleBindFeishu()}
        confirmLoading={saving}
        onCancel={() => {
          setBindRow(null);
          bindForm.resetFields();
        }}
        okText="确认绑定"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary">
          请从受信任的飞书管理员或身份查询流程复制 union ID。绑定后系统只显示“已绑定”，不再回显原值。
        </Typography.Paragraph>
        <Form form={bindForm} layout="vertical">
          <Form.Item
            name="unionId"
            label="Feishu union ID"
            rules={[
              { required: true, whitespace: true, message: "请输入飞书 union ID" },
              { max: 128, message: "最多 128 个字符" },
            ]}
          >
            <Input.Password placeholder="粘贴 union ID" autoComplete="off" visibilityToggle={false} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
