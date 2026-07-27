"use client";

import { Form, Input, Select, Switch, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import CrudTable from "@/components/CrudTable";
import RemoteSelect from "@/components/RemoteSelect";
import { hasAnyRole, useMe } from "@/components/useMe";

interface BinRow {
  id: number;
  warehouseId: number;
  warehouseCode: string;
  warehouseName: string;
  code: string;
  name: string | null;
  kind: "normal" | "quarantine" | "staging";
  active: boolean;
  remark: string | null;
}

const KIND_LABELS: Record<BinRow["kind"], string> = {
  normal: "普通",
  quarantine: "隔离",
  staging: "暂存",
};

const KIND_COLORS: Record<BinRow["kind"], string> = {
  normal: "blue",
  quarantine: "red",
  staging: "gold",
};

export default function BinClient() {
  const me = useMe();
  const canWrite = hasAnyRole(me, "warehouse");
  const columns: ColumnsType<BinRow> = [
    {
      title: "仓库",
      dataIndex: "warehouseCode",
      width: 190,
      sorter: (a, b) => a.warehouseCode.localeCompare(b.warehouseCode),
      render: (_value, row) => `${row.warehouseCode} · ${row.warehouseName}`,
    },
    {
      title: "库位编码",
      dataIndex: "code",
      width: 150,
      sorter: (a, b) => a.code.localeCompare(b.code),
    },
    {
      title: "名称",
      dataIndex: "name",
      sorter: (a, b) => (a.name ?? "").localeCompare(b.name ?? ""),
      render: (value: string | null) => value || "—",
    },
    {
      title: "用途",
      dataIndex: "kind",
      width: 100,
      filters: Object.entries(KIND_LABELS).map(([value, text]) => ({ value, text })),
      onFilter: (value, row) => row.kind === value,
      render: (value: BinRow["kind"]) => <Tag color={KIND_COLORS[value]}>{KIND_LABELS[value]}</Tag>,
    },
    {
      title: "状态",
      dataIndex: "active",
      width: 90,
      filters: [{ text: "启用", value: true }, { text: "停用", value: false }],
      onFilter: (value, row) => row.active === value,
      render: (value: boolean) => value ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>,
    },
    { title: "备注", dataIndex: "remark", ellipsis: true, render: (value: string | null) => value || "—" },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>库位主数据</Typography.Title>
      <Typography.Paragraph type="secondary">
        仅实时仓维护库位。隔离与暂存是可审计的作业状态；仓库库存总账仍是数量真相。
      </Typography.Paragraph>
      <CrudTable<BinRow>
        entityName="库位"
        apiPath="/api/master/bin"
        loadDetailOnEdit
        canCreate={canWrite}
        canEdit={() => canWrite}
        searchPlaceholder="搜索库位编码/名称"
        columns={columns}
        formItems={() => (
          <>
            <Form.Item name="warehouseId" label="所属实时仓" rules={[{ required: true, message: "请选择所属仓库" }]}>
              <RemoteSelect
                api="/api/master/warehouse"
                getLabel={(row) => `${String(row.code)} · ${String(row.name)}`}
                filterRow={(row) => row.accountingMode === "realtime" && row.active === true}
                placeholder="选择实时仓库"
              />
            </Form.Item>
            <Form.Item name="code" label="库位编码" rules={[{ required: true, message: "库位编码必填" }]}>
              <Input maxLength={40} placeholder="如 A-01-01" />
            </Form.Item>
            <Form.Item name="name" label="库位名称">
              <Input maxLength={80} placeholder="可选，如 成品拣货区" />
            </Form.Item>
            <Form.Item name="kind" label="用途" initialValue="normal" rules={[{ required: true }]}>
              <Select options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))} />
            </Form.Item>
            <Form.Item name="remark" label="备注">
              <Input.TextArea maxLength={300} showCount rows={3} />
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
