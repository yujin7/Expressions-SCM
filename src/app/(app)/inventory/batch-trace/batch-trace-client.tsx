"use client";

import SearchInput from "@/components/SearchInput";

/** E4-01 批次追溯：召回场景的"这批货从哪来、现在在哪"。出库侧覆盖情况如实标注。 */
import { useCallback, useState } from "react";
import {
  Alert, App, Button, Card, Descriptions, Empty, Form, Input, InputNumber, Modal, Select, Space,
  Table, Tag, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson, postJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";
import { hasAnyRole, useMe } from "@/components/useMe";

interface StockRow { warehouse: string; qty: number; stocktakeDate: string }

/** W2-6：批次的物理分布（库位子账），隔离/放行的作业对象 */
interface PlacementRow {
  key: string;
  warehouseId: number;
  warehouseName: string;
  binId: number | null;
  binCode: string | null;
  binName: string | null;
  binKind: string | null;
  qty: string;
  locationState: "located" | "unlocated";
}
interface PlacementBin { id: number; warehouseId: number; code: string; name: string | null; kind: string }

const BIN_KIND_LABELS: Record<string, string> = { normal: "普通", quarantine: "隔离", staging: "暂存" };
const BIN_KIND_COLORS: Record<string, string> = { normal: "blue", quarantine: "red", staging: "gold" };
interface LedgerRow { occurredAt: string; warehouse: string; qtyDelta: number; sourceDocType: string; sourceDocId: number }

interface Trace {
  batch: { id: number; skuId: number; batchNo: string; skuCode: string; skuName: string; prodDate: string | null; expiryDate: string | null };
  source: { docType: string | null; docId: number | null };
  stockByWarehouse: StockRow[];
  ledger: LedgerRow[];
  coverage: { outboundTraceable: boolean; note: string };
}

export default function BatchTraceClient() {
  const { message } = App.useApp();
  const [sku, setSku] = useState("");
  const [batch, setBatch] = useState("");
  const [data, setData] = useState<Trace | null>(null);
  const [loading, setLoading] = useState(false);
  const me = useMe();
  const canOperate = hasAnyRole(me, "warehouse");
  const [placements, setPlacements] = useState<{ rows: PlacementRow[]; bins: PlacementBin[] } | null>(null);
  const [acting, setActing] = useState<{ row: PlacementRow; intent: "quarantine" | "release" } | null>(null);
  const [saving, setSaving] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [form] = Form.useForm();

  const loadPlacements = useCallback(async (skuId: number, batchId: number) => {
    try {
      setPlacements(
        await fetchJson<{ rows: PlacementRow[]; bins: PlacementBin[] }>(
          `/api/inventory/quarantine?skuId=${skuId}&batchId=${batchId}`,
        ),
      );
    } catch {
      setPlacements(null); // 分布查不到不应挡住追溯本身
    }
  }, []);

  const run = useCallback(async () => {
    if (!sku.trim() || !batch.trim()) { message.warning("请填写 SKU 编码与批次号"); return; }
    setLoading(true);
    setData(null);
    setPlacements(null);
    try {
      const trace = await fetchJson<Trace>(`/api/inventory/batch-trace?sku=${encodeURIComponent(sku.trim())}&batch=${encodeURIComponent(batch.trim())}`);
      setData(trace);
      void loadPlacements(trace.batch.skuId, trace.batch.id);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sku, batch, message, loadPlacements]);

  const openAction = (row: PlacementRow, intent: "quarantine" | "release") => {
    setActing({ row, intent });
    setIdempotencyKey(crypto.randomUUID());
    form.resetFields();
    form.setFieldsValue({ qty: Number(row.qty), reason: "", toBinId: undefined });
  };

  const targetBins = (placements?.bins ?? []).filter((bin) => {
    if (!acting) return false;
    if (bin.warehouseId !== acting.row.warehouseId) return false;
    if (bin.id === acting.row.binId) return false;
    return acting.intent === "quarantine" ? bin.kind === "quarantine" : ["normal", "staging"].includes(bin.kind);
  });

  const submitAction = async () => {
    if (!acting || !data) return;
    try {
      const values = await form.validateFields();
      setSaving(true);
      await postJson("/api/inventory/quarantine", {
        idempotencyKey,
        intent: acting.intent,
        warehouseId: acting.row.warehouseId,
        skuId: data.batch.skuId,
        batchId: data.batch.id,
        fromBinId: acting.row.binId,
        toBinId: values.toBinId ?? null,
        qty: String(values.qty),
        reason: values.reason,
      });
      message.success(acting.intent === "quarantine" ? "已隔离该批次库存" : "已放行该批次库存");
      setActing(null);
      await loadPlacements(data.batch.skuId, data.batch.id);
    } catch (e) {
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const placementColumns: ColumnsType<PlacementRow> = [
    { title: "仓库", dataIndex: "warehouseName", width: 150 },
    {
      title: "库位",
      dataIndex: "binCode",
      width: 170,
      render: (_v, r) => r.binCode ? `${r.binCode}${r.binName ? ` · ${r.binName}` : ""}` : <Tag>未定位</Tag>,
    },
    {
      title: "状态",
      dataIndex: "binKind",
      width: 90,
      render: (v: string | null) => v
        ? <Tag color={BIN_KIND_COLORS[v] ?? "default"}>{BIN_KIND_LABELS[v] ?? v}</Tag>
        : <Tag>未定位</Tag>,
    },
    { title: "数量", dataIndex: "qty", width: 120, align: "right", render: (v: string) => formatQty(v) },
    {
      title: "操作",
      key: "_actions",
      width: 130,
      render: (_v, r) => {
        if (!canOperate) return "—";
        return r.binKind === "quarantine" ? (
          <Button type="link" size="small" onClick={() => openAction(r, "release")}>放行</Button>
        ) : (
          <Button danger type="link" size="small" onClick={() => openAction(r, "quarantine")}>隔离</Button>
        );
      },
    },
  ];

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>批次追溯</Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="召回/质量事件时回答「这批货从哪来、现在在哪」。批次登记自收货单采集；管效期的 SKU 收货必须填批次号。"
      />
      <Space style={{ marginBottom: 16 }} wrap>
        <Input placeholder="SKU 编码" value={sku} onChange={(e) => setSku(e.target.value)} style={{ width: 200 }} onPressEnter={() => void run()} />
        <Input placeholder="批次号" value={batch} onChange={(e) => setBatch(e.target.value)} style={{ width: 200 }} onPressEnter={() => void run()} />
        <SearchInput enterButton="追溯" loading={loading} onSearch={() => void run()} style={{ width: 120 }} />
      </Space>

      {!data ? (
        <Empty description="输入 SKU 编码与批次号开始追溯" />
      ) : (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Alert
            type={data.coverage.outboundTraceable ? "success" : "warning"}
            showIcon
            message={data.coverage.outboundTraceable ? "出库侧可追溯" : "出库侧覆盖有限"}
            description={data.coverage.note}
          />
          <Card size="small" title="批次登记">
            <Descriptions column={2} size="small">
              <Descriptions.Item label="SKU">{data.batch.skuCode} {data.batch.skuName}</Descriptions.Item>
              <Descriptions.Item label="批次号">{data.batch.batchNo}</Descriptions.Item>
              <Descriptions.Item label="生产日期">{data.batch.prodDate ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="到期日">{data.batch.expiryDate ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="来源单据">
                {data.source.docType ? `${data.source.docType.toUpperCase()} #${data.source.docId}` : "—"}
              </Descriptions.Item>
            </Descriptions>
          </Card>
          <Card size="small" title="批次库存分布（参考层）">
            <Table<StockRow>
              rowKey={(r) => r.warehouse}
              size="small"
              pagination={false}
              dataSource={data.stockByWarehouse}
              locale={{ emptyText: "该批次当前无参考层库存记录" }}
              columns={[
                { title: "仓库", dataIndex: "warehouse" },
                { title: "数量", dataIndex: "qty", align: "right", render: (v: number) => formatQty(String(v)) },
                { title: "盘点期间", dataIndex: "stocktakeDate", width: 120 },
              ]}
            />
          </Card>
          {/* W2-6：召回/检验不合格时，这里才是「把这批货就地隔离」的入口。
              隔离/放行都走 bin_movements 的既有不变量守卫与审计，不另开写路径。 */}
          <Card
            size="small"
            title="物理分布与隔离处置（库位子账）"
            extra={<Typography.Text type="secondary">仓库总账仍是数量真相；隔离只改「货在哪」，不改库存数量</Typography.Text>}
          >
            <Table<PlacementRow>
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={placements?.rows ?? []}
              columns={placementColumns}
              locale={{ emptyText: "该批次在实时仓无可作业库存（快照仓不参与库位作业）" }}
            />
          </Card>
          <Card size="small" title="台账流水（带批次的部分）">
            <Table<LedgerRow>
              rowKey={(r) => `${r.occurredAt}-${r.sourceDocId}`}
              size="small"
              pagination={false}
              dataSource={data.ledger}
              locale={{ emptyText: "暂无带该批次的台账流水（见上方覆盖说明）" }}
              columns={[
                { title: "日期", dataIndex: "occurredAt", width: 110 },
                { title: "仓库", dataIndex: "warehouse" },
                { title: "方向", width: 80, render: (_: unknown, r: LedgerRow) => <Tag color={r.qtyDelta >= 0 ? "green" : "orange"}>{r.qtyDelta >= 0 ? "入库" : "出库"}</Tag> },
                { title: "数量", dataIndex: "qtyDelta", align: "right", render: (v: number) => formatQty(String(Math.abs(v))) },
                { title: "来源单据", render: (_: unknown, r: LedgerRow) => `${r.sourceDocType} #${r.sourceDocId}` },
              ]}
            />
          </Card>
        </Space>
      )}

      <Modal
        open={acting != null}
        title={acting ? `${acting.intent === "quarantine" ? "隔离" : "放行"} · ${data?.batch.skuCode} / ${data?.batch.batchNo}` : ""}
        okText="确认作业"
        cancelText="取消"
        confirmLoading={saving}
        maskClosable={false}
        onOk={() => void submitAction()}
        onCancel={() => setActing(null)}
        destroyOnHidden
      >
        {acting ? (
          <>
            <Descriptions size="small" bordered column={1} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="仓库">{acting.row.warehouseName}</Descriptions.Item>
              <Descriptions.Item label="来源位置">{acting.row.binCode ?? "未定位"}</Descriptions.Item>
              <Descriptions.Item label="可作业量">{formatQty(acting.row.qty)}</Descriptions.Item>
            </Descriptions>
            <Form form={form} layout="vertical">
              <Form.Item
                name="toBinId"
                label={acting.intent === "quarantine" ? "目标隔离库位" : "放行目标库位"}
                rules={[{ required: targetBins.length > 1, message: "请选择目标库位" }]}
                extra={targetBins.length === 1 ? "该仓仅一个候选库位，留空即自动使用" : undefined}
              >
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder={targetBins.length ? "选择目标库位" : "该仓尚无可用库位，请先维护库位主数据"}
                  options={targetBins.map((bin) => ({
                    value: bin.id,
                    label: `${bin.code}${bin.name ? ` · ${bin.name}` : ""}（${BIN_KIND_LABELS[bin.kind] ?? bin.kind}）`,
                  }))}
                />
              </Form.Item>
              <Form.Item name="qty" label="数量" rules={[{ required: true, message: "数量必填" }]}>
                <InputNumber min={0.0001} precision={4} style={{ width: 180 }} />
              </Form.Item>
              <Form.Item name="reason" label="作业原因" rules={[{ required: true, message: "作业原因必填" }]}>
                <Input.TextArea rows={3} maxLength={300} showCount placeholder="如：批次召回 / 检验不合格 / 复检合格放行" />
              </Form.Item>
            </Form>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
