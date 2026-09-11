"use client";

import { Form, Input, Select, Switch, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import CrudTable from "@/components/CrudTable";
import { useListState } from "@/components/useListState";
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
  const list = useListState({ key: "master-bin", defaults: { q: "", sort: "warehouseCode", order: "asc", kind: "", active: "", warehouseId: "" }, defaultPageSize: 20, defaultDensity: "middle" });
  const sortOrder = (key: string) => list.filters.sort === key ? list.filters.order === "desc" ? "descend" as const : "ascend" as const : null;
  const me = useMe();
  const canWrite = hasAnyRole(me, "warehouse");
  const columns: ColumnsType<BinRow> = [
    {
      title: "仓库",
      key: "warehouseCode",
      dataIndex: "warehouseCode",
      width: 190,
      sorter: true, sortOrder: sortOrder("warehouseCode"),
      render: (_value, row) => `${row.warehouseCode} · ${row.warehouseName}`,
    },
    {
      title: "库位编码",
      key: "code",
      dataIndex: "code",
      width: 150,
      sorter: true, sortOrder: sortOrder("code"),
    },
    {
      title: "名称",
      key: "name",
      dataIndex: "name",
      sorter: true, sortOrder: sortOrder("name"),
      render: (value: string | null) => value || "—",
    },
    {
      title: "用途",
      key: "kind",
      dataIndex: "kind",
      width: 100,
      filters: Object.entries(KIND_LABELS).map(([value, text]) => ({ value, text })),
      filterMultiple: false, filteredValue: list.filters.kind ? [list.filters.kind] : null,
      render: (value: BinRow["kind"]) => <Tag color={KIND_COLORS[value]}>{KIND_LABELS[value]}</Tag>,
    },
    {
      title: "状态",
      key: "active",
      dataIndex: "active",
      width: 90,
      filters: [{ text: "启用", value: true }, { text: "停用", value: false }],
      filterMultiple: false, filteredValue: list.filters.active ? [list.filters.active === "true"] : null,
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
        listState={list}
        toolbarFilters={<RemoteSelect api="/api/master/warehouse" placeholder="筛选所属仓库" aria-label="筛选所属仓库" allowClear
          getLabel={row => `${String(row.code)} · ${String(row.name)}`}
          style={{ width: 220 }} value={list.filters.warehouseId ? Number(list.filters.warehouseId) : undefined}
          onChange={value => list.setFilter({ warehouseId: value == null ? "" : String(value) })} />}
        tableProps={{ onChange: (_page, filters, sorter, extra) => {
          if (extra.action === "paginate") return;
          const current = Array.isArray(sorter) ? sorter[0] : sorter;
          list.setFilter({ sort: current.order ? String(current.columnKey) : "warehouseCode", order: current.order === "descend" ? "desc" : "asc", kind: String(filters.kind?.[0] ?? ""), active: String(filters.active?.[0] ?? "") });
        } }}
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
