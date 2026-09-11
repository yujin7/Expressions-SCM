"use client";

/**
 * 渠道主数据（审计 #11）。
 *
 * 六个页面拿渠道当选择器，此前唯一写入者却是 seed：新开一个店或一个部门，
 * 业务只能等人改 seed 重播数据库。本页与 /master/category 同型（CrudTable）。
 *
 * 停用不是删除：存量 SKU 仍引用它，列表照常返回停用渠道——隐藏只会把真实关系变成不可见 ID。
 */
import { Form, Input, Select, Switch, Tag, Typography } from "antd";
import CrudTable from "@/components/CrudTable";
import { hasAnyRole, useMe } from "@/components/useMe";

interface ChannelRow {
  id: number;
  code: string;
  name: string;
  kind: "platform" | "dept";
  active: boolean;
}

const KIND_LABELS: Record<string, string> = { platform: "电商平台", dept: "业务部门" };

export default function ChannelClient() {
  const me = useMe();
  const canWrite = hasAnyRole(me, "pmc");
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        渠道
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        渠道编码是别名解析与外部平台映射的稳定业务键，建后不可修改；渠道不再使用时改为「停用」，
        不做删除——存量 SKU、销量与观察数据都还引用着它。
      </Typography.Paragraph>
      <CrudTable<ChannelRow>
        canCreate={canWrite}
        canEdit={() => canWrite}
        entityName="渠道"
        apiPath="/api/master/channel"
        loadDetailOnEdit
        searchPlaceholder="搜索渠道编码/名称"
        columns={[
          { title: "编码", dataIndex: "code", width: 140 },
          { title: "名称", dataIndex: "name" },
          {
            title: "类型",
            dataIndex: "kind",
            width: 120,
            render: (v: string) => <Tag color={v === "platform" ? "blue" : "geekblue"}>{KIND_LABELS[v] ?? v}</Tag>,
          },
          {
            title: "状态",
            dataIndex: "active",
            width: 100,
            render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
          },
        ]}
        formItems={(editing) => (
          <>
            <Form.Item
              name="code"
              label="渠道编码"
              rules={[
                { required: true, message: "渠道编码必填" },
                { pattern: /^[a-z0-9_-]+$/, message: "只允许小写字母、数字、下划线与连字符" },
              ]}
              tooltip="别名解析与外部映射的稳定业务键；建后不可修改"
            >
              <Input maxLength={30} disabled={editing != null} placeholder="如 tmall / douyin / biz" />
            </Form.Item>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: "渠道名称必填" }]}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="kind" label="类型" rules={[{ required: true, message: "渠道类型必选" }]} initialValue="platform">
              <Select
                options={[
                  { value: "platform", label: "电商平台" },
                  { value: "dept", label: "业务部门" },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="active"
              label="启用"
              valuePropName="checked"
              initialValue
              tooltip="停用只是不再出现在新建选项里；历史数据仍然引用它"
            >
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
          </>
        )}
      />
    </div>
  );
}
