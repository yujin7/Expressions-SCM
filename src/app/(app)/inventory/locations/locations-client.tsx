"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import RemoteSelect from "@/components/RemoteSelect";
import SearchInput from "@/components/SearchInput";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { hasAnyRole, useMe } from "@/components/useMe";

type BinKind = "normal" | "quarantine" | "staging";
type Operation = "locate" | "move" | "unlocate" | "quarantine" | "release";

interface InventoryRow {
  key: string;
  warehouseId: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  batchId: number | null;
  batchNo: string | null;
  expiryDate: string | null;
  binId: number | null;
  binCode: string | null;
  binName: string | null;
  binKind: BinKind | null;
  qty: string;
  locationState: "located" | "unlocated";
}

interface BinRow {
  id: number;
  code: string;
  name: string | null;
  kind: BinKind;
  active: boolean;
}

interface MovementRow {
  id: number;
  operation: Operation;
  skuCode: string;
  skuName: string;
  batchNo: string | null;
  fromBinCode: string;
  toBinCode: string;
  qty: string;
  reason: string;
  createdByName: string;
  occurredAt: string;
}

interface LocationsResponse {
  inventory: {
    warehouse: { id: number; code: string; name: string };
    rows: InventoryRow[];
    totals: { located: string; unlocated: string; normal: string; quarantine: string; staging: string };
    integrityIssues: {
      skuId: number;
      skuCode: string;
      batchId: number | null;
      batchNo: string | null;
      warehouseQty: string;
      locatedQty: string;
    }[];
  };
  movements: MovementRow[];
}

const KIND_LABELS: Record<BinKind, string> = { normal: "普通", quarantine: "隔离", staging: "暂存" };
const KIND_COLORS: Record<BinKind, string> = { normal: "blue", quarantine: "red", staging: "gold" };
const OP_LABELS: Record<Operation, string> = {
  locate: "定位",
  move: "移库",
  unlocate: "取消定位",
  quarantine: "隔离",
  release: "放行",
};

function allowedOperations(row: InventoryRow): Operation[] {
  if (row.locationState === "unlocated") return ["locate", "quarantine"];
  if (row.binKind === "quarantine") return ["release"];
  return ["move", "quarantine", "unlocate"];
}

function defaultOperation(row: InventoryRow): Operation {
  return allowedOperations(row)[0];
}

export default function LocationsClient() {
  const { message } = App.useApp();
  const params = useSearchParams();
  const me = useMe();
  const canWrite = hasAnyRole(me, "warehouse");
  const initialWarehouseId = Number(params.get("warehouseId"));
  const [warehouseId, setWarehouseId] = useState<number | undefined>(
    Number.isInteger(initialWarehouseId) && initialWarehouseId > 0 ? initialWarehouseId : undefined,
  );
  const [q, setQ] = useState("");
  const [data, setData] = useState<LocationsResponse | null>(null);
  const [bins, setBins] = useState<BinRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<InventoryRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [form] = Form.useForm();
  const operation = Form.useWatch<Operation>("operation", form);

  const load = useCallback(async () => {
    if (!warehouseId) {
      setData(null);
      setBins([]);
      return;
    }
    setLoading(true);
    try {
      const [result, binResult] = await Promise.all([
        fetchJson<LocationsResponse>(`/api/inventory/bin-operations?warehouseId=${warehouseId}&q=${encodeURIComponent(q)}`),
        fetchJson<{ data: BinRow[] }>(`/api/master/bin?warehouseId=${warehouseId}&active=true&page=1&pageSize=999`),
      ]);
      setData(result);
      setBins(binResult.data);
    } catch (error) {
      message.error((error as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [message, q, warehouseId]);

  useEffect(() => { void load(); }, [load]);

  const openOperation = (row: InventoryRow, selected?: Operation) => {
    const nextOperation = selected ?? defaultOperation(row);
    setEditing(row);
    setIdempotencyKey(crypto.randomUUID());
    form.resetFields();
    form.setFieldsValue({ operation: nextOperation, qty: row.qty, reason: "" });
  };

  const targetBins = useMemo(() => {
    if (!editing || !operation) return [];
    return bins.filter((bin) => {
      if (bin.id === editing.binId) return false;
      if (operation === "quarantine") return bin.kind === "quarantine";
      if (operation === "release" || operation === "locate" || operation === "move") {
        return bin.kind === "normal" || bin.kind === "staging";
      }
      return false;
    });
  }, [bins, editing, operation]);

  const submit = async () => {
    if (!editing) return;
    try {
      const values = await form.validateFields();
      setSaving(true);
      const selectedOperation = values.operation as Operation;
      await postJson("/api/inventory/bin-operations", {
        idempotencyKey,
        warehouseId: editing.warehouseId,
        skuId: editing.skuId,
        batchId: editing.batchId,
        fromBinId: editing.binId,
        toBinId: selectedOperation === "unlocate" ? null : values.toBinId,
        qty: values.qty,
        operation: selectedOperation,
        reason: values.reason,
      });
      message.success(`${OP_LABELS[selectedOperation]}成功`);
      setEditing(null);
      await load();
    } catch (error) {
      if (error instanceof Error && error.message) message.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const inventoryColumns: ColumnsType<InventoryRow> = [
    { title: "SKU 编码", dataIndex: "skuCode", width: 140, sorter: (a, b) => a.skuCode.localeCompare(b.skuCode) },
    { title: "名称", dataIndex: "skuName", ellipsis: true, sorter: (a, b) => a.skuName.localeCompare(b.skuName) },
    { title: "批次", dataIndex: "batchNo", width: 130, render: (v: string | null) => v || "无批次" },
    {
      title: "库位",
      dataIndex: "binCode",
      width: 150,
      sorter: (a, b) => (a.binCode ?? "").localeCompare(b.binCode ?? ""),
      render: (_value, row) => row.binCode ? `${row.binCode}${row.binName ? ` · ${row.binName}` : ""}` : <Tag>未定位</Tag>,
    },
    {
      title: "状态",
      dataIndex: "binKind",
      width: 90,
      filters: [
        { text: "未定位", value: "unlocated" },
        ...Object.entries(KIND_LABELS).map(([value, text]) => ({ value, text })),
      ],
      onFilter: (value, row) => value === "unlocated" ? row.locationState === "unlocated" : row.binKind === value,
      render: (value: BinKind | null) => value ? <Tag color={KIND_COLORS[value]}>{KIND_LABELS[value]}</Tag> : <Tag>未定位</Tag>,
    },
    {
      title: "数量",
      dataIndex: "qty",
      width: 140,
      align: "right",
      sorter: (a, b) => Number(a.qty) - Number(b.qty),
      render: (value: string, row) => `${formatQty(value)} ${row.baseUom}`,
    },
    {
      title: "操作",
      key: "actions",
      width: 210,
      fixed: "right",
      render: (_value, row) => canWrite ? (
        <Space size={0} wrap>
          {allowedOperations(row).map((item) => (
            <Button key={item} type="link" size="small" danger={item === "quarantine"} onClick={() => openOperation(row, item)}>
              {OP_LABELS[item]}
            </Button>
          ))}
        </Space>
      ) : "—",
    },
  ];

  const movementColumns: ColumnsType<MovementRow> = [
    { title: "时间", dataIndex: "occurredAt", width: 180, render: (v: string) => new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) },
    { title: "作业", dataIndex: "operation", width: 90, render: (v: Operation) => OP_LABELS[v] ?? v },
    { title: "SKU", dataIndex: "skuCode", width: 140, sorter: (a, b) => a.skuCode.localeCompare(b.skuCode) },
    { title: "批次", dataIndex: "batchNo", width: 130, render: (v: string | null) => v || "无批次" },
    { title: "路径", key: "path", width: 210, render: (_v, row) => `${row.fromBinCode} → ${row.toBinCode}` },
    { title: "数量", dataIndex: "qty", width: 110, align: "right", render: (v: string) => formatQty(v) },
    { title: "原因", dataIndex: "reason", ellipsis: true },
    { title: "操作人", dataIndex: "createdByName", width: 120 },
  ];

  const totals = data?.inventory.totals;
  return (
    <div>
      <Space align="start" style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }} wrap>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>库位作业</Typography.Title>
          <Typography.Text type="secondary">
            仓库总账是数量真相；库位子账只回答货在哪里。出库仅消耗未定位量，拣货请先取消定位，隔离量必须放行。
          </Typography.Text>
        </div>
        <Button href="/master/bin">维护库位主数据</Button>
      </Space>
      <Card styles={{ body: { padding: 20 } }}>
        <Space wrap style={{ marginBottom: 20 }}>
          <RemoteSelect
            value={warehouseId}
            api="/api/master/warehouse"
            getLabel={(row) => `${String(row.code)} · ${String(row.name)}`}
            filterRow={(row) => row.accountingMode === "realtime" && row.active === true}
            placeholder="选择实时仓库"
            style={{ width: 280 }}
            onChange={(value) => setWarehouseId(Number(value))}
          />
          <SearchInput
            allowClear
            placeholder="搜索 SKU 编码/名称"
            style={{ width: 260 }}
            onSearch={(value) => setQ(value.trim())}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
        </Space>
        {!warehouseId ? (
          <Alert type="info" showIcon message="请选择一个实时仓库，开始定位、移库、隔离或放行作业。" />
        ) : (
          <>
            {data?.inventory.integrityIssues.length ? (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                message={`发现 ${data.inventory.integrityIssues.length} 个库位余额超过仓库总账的完整性异常`}
                description="已停止隐藏负的“未定位”差额。请先核对并纠正数据，再继续定位该 SKU。"
              />
            ) : null}
            <Row gutter={[10, 10]} className="compact-kpi-row">
              {[
                ["已定位", totals?.located ?? "0"],
                ["未定位", totals?.unlocated ?? "0"],
                ["隔离", totals?.quarantine ?? "0"],
                ["暂存", totals?.staging ?? "0"],
              ].map(([title, value]) => (
                <Col key={title} xs={12} lg={6}>
                  <Card size="small"><Statistic title={title} value={formatQty(value)} /></Card>
                </Col>
              ))}
            </Row>
            <Tabs
              items={[
                {
                  key: "inventory",
                  label: `位置库存（${data?.inventory.rows.length ?? 0}）`,
                  children: (
                    <Table<InventoryRow>
                      rowKey="key"
                      size="middle"
                      loading={loading}
                      dataSource={data?.inventory.rows ?? []}
                      columns={inventoryColumns}
                      pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (n) => `共 ${n} 条` }}
                      scroll={{ x: 1050 }}
                    />
                  ),
                },
                {
                  key: "movements",
                  label: `最近作业（${data?.movements.length ?? 0}）`,
                  children: (
                    <Table<MovementRow>
                      rowKey="id"
                      size="middle"
                      dataSource={data?.movements ?? []}
                      columns={movementColumns}
                      pagination={{ pageSize: 20, showSizeChanger: true }}
                      scroll={{ x: 1150 }}
                    />
                  ),
                },
              ]}
            />
          </>
        )}
      </Card>
      <Modal
        open={editing != null}
        title={editing ? `${editing.skuCode} · 库位作业` : "库位作业"}
        okText="确认过账"
        cancelText="取消"
        confirmLoading={saving}
        maskClosable={false}
        onOk={() => void submit()}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
        {editing ? (
          <>
            <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="SKU" span={2}>{editing.skuCode} · {editing.skuName}</Descriptions.Item>
              <Descriptions.Item label="批次">{editing.batchNo || "无批次"}</Descriptions.Item>
              <Descriptions.Item label="当前位置">{editing.binCode || "未定位"}</Descriptions.Item>
              <Descriptions.Item label="可操作量">{formatQty(editing.qty)} {editing.baseUom}</Descriptions.Item>
            </Descriptions>
            <Form form={form} layout="vertical">
              <Form.Item name="operation" label="作业类型" rules={[{ required: true }]}>
                <Select
                  options={allowedOperations(editing).map((value) => ({ value, label: OP_LABELS[value] }))}
                  onChange={() => form.setFieldValue("toBinId", undefined)}
                />
              </Form.Item>
              {operation !== "unlocate" ? (
                <Form.Item name="toBinId" label="目标库位" rules={[{ required: true, message: "请选择目标库位" }]}>
                  <Select
                    showSearch
                    optionFilterProp="label"
                    placeholder={targetBins.length ? "选择目标库位" : "请先维护匹配用途的启用库位"}
                    options={targetBins.map((bin) => ({
                      value: bin.id,
                      label: `${bin.code}${bin.name ? ` · ${bin.name}` : ""}（${KIND_LABELS[bin.kind]}）`,
                    }))}
                  />
                </Form.Item>
              ) : null}
              <Form.Item name="qty" label="数量" rules={[{ required: true, message: "数量必填" }, { pattern: /^\d+(\.\d{1,4})?$/, message: "最多 4 位小数" }]}>
                <Input inputMode="decimal" />
              </Form.Item>
              <Form.Item name="reason" label="作业原因" rules={[{ required: true, message: "作业原因必填" }]}>
                <Input.TextArea maxLength={300} showCount rows={3} />
              </Form.Item>
            </Form>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
