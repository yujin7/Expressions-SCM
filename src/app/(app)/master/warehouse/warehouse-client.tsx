"use client";

import { Form, Input, Select, Switch, Tag, Typography } from "antd";
import CrudTable from "@/components/CrudTable";
import RemoteSelect from "@/components/RemoteSelect";
import { WAREHOUSE_KIND_LABELS, toOptions } from "@/components/labels";

interface WarehouseRow {
  id: number;
  code: string;
  name: string;
  kind: string;
  accountingMode: string;
  supplierId: number | null;
  supplierName: string | null;
  active: boolean;
}

const KIND_COLORS: Record<string, string> = {
  finished: "blue",
  raw: "green",
  packaging: "orange",
  outsource: "purple",
  transit: "cyan",
  snapshot: "default",
};

export default function WarehouseClient() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        仓库
      </Typography.Title>
      <CrudTable<WarehouseRow>
        entityName="仓库"
        apiPath="/api/master/warehouse"
        searchPlaceholder="搜索编码/名称"
        columns={[
          { title: "编码", dataIndex: "code", width: 140 },
          { title: "名称", dataIndex: "name" },
          {
            title: "类型",
            dataIndex: "kind",
            width: 110,
            render: (v: string) => <Tag color={KIND_COLORS[v]}>{WAREHOUSE_KIND_LABELS[v] ?? v}</Tag>,
          },
          {
            title: "关联供应商",
            dataIndex: "supplierName",
            width: 160,
            render: (v: string | null) => v ?? "—",
          },
          {
            title: "状态",
            dataIndex: "active",
            width: 80,
            render: (v: boolean) => (v ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>),
          },
        ]}
        formItems={() => (
          <>
            <Form.Item name="code" label="编码" rules={[{ required: true, message: "编码必填" }]}>
              <Input maxLength={30} placeholder="如 WH-CP" />
            </Form.Item>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: "名称必填" }]}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="kind" label="类型" rules={[{ required: true, message: "必须选择仓库类型" }]}>
              <Select options={toOptions(WAREHOUSE_KIND_LABELS)} placeholder="选择仓库类型" />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, cur) => prev.kind !== cur.kind}>
              {({ getFieldValue }) =>
                getFieldValue("kind") === "outsource" ? (
                  <Form.Item
                    name="supplierId"
                    label="委外供应商"
                    tooltip="委外仓按加工厂建仓，允许负余额=垫料"
                    rules={[{ required: true, message: "委外仓必须指定供应商" }]}
                  >
                    <RemoteSelect
                      api="/api/master/supplier"
                      getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                      filterRow={(r) => Array.isArray(r.kinds) && (r.kinds as string[]).includes("processor")}
                      placeholder="选择加工厂"
                    />
                  </Form.Item>
                ) : null
              }
            </Form.Item>
            <Form.Item name="active" label="启用" valuePropName="checked" initialValue={true}>
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
          </>
        )}
      />
    </div>
  );
}
