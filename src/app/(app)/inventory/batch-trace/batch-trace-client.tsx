"use client";

/** E4-01 批次追溯：召回场景的"这批货从哪来、现在在哪"。出库侧覆盖情况如实标注。 */
import { useRef, useState } from "react";
import {
  Alert, App, Button, Card, Descriptions, Empty, Form, Input, InputNumber, Modal, Select, Space,
  Table, Tag, Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import { useDocumentRead } from "@/components/useDocumentRead";
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
  const [query, setQuery] = useState<{ sku: string; batch: string } | null>(null);
  const traceRead = useDocumentRead<Trace>(query ? `/api/inventory/batch-trace?sku=${encodeURIComponent(query.sku)}&batch=${encodeURIComponent(query.batch)}` : null);
  const trace = traceRead.data;
  const validTrace = trace != null && trace.batch?.skuCode === query?.sku && trace.batch?.batchNo === query?.batch
    && Number.isInteger(trace.batch.id) && trace.batch.id > 0 && Number.isInteger(trace.batch.skuId) && trace.batch.skuId > 0
    && Array.isArray(trace.ledger) && Array.isArray(trace.stockByWarehouse) && trace.coverage != null && trace.source != null;
  const data = validTrace ? trace : null;
  const traceError = traceRead.error ?? (traceRead.phase === "success" && !validTrace ? "批次身份或响应结构不匹配，请重新核对" : null);
  const loading = traceRead.phase === "loading";
  const me = useMe();
  const canOperate = hasAnyRole(me, "warehouse");
  const placementRead = useDocumentRead<{ rows: PlacementRow[]; bins: PlacementBin[] }>(data ? `/api/inventory/quarantine?skuId=${data.batch.skuId}&batchId=${data.batch.id}` : null);
  const placements = placementRead.data && Array.isArray(placementRead.data.rows) && Array.isArray(placementRead.data.bins) ? placementRead.data : null;
  const placementError = placementRead.error ?? (placementRead.phase === "success" && !placements ? "库位分布响应不完整，请重试" : null);
  const [acting, setActing] = useState<{ row: PlacementRow; intent: "quarantine" | "release"; trace: Trace; placements: NonNullable<typeof placements> } | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [form] = Form.useForm();
  const current = useRef({ data, placements, canOperate });
  current.current = { data, placements, canOperate };
  const active = acting && acting.trace === data && acting.placements === placements && canOperate ? acting : null;

  const editQuery = (kind: "sku" | "batch", value: string) => {
    if (busy.current) return;
    if (kind === "sku") setSku(value); else setBatch(value);
    setQuery(null);
    setActing(null);
    setWriteError(null);
  };
  const run = () => {
    if (busy.current) return;
    if (!sku.trim() || !batch.trim()) { message.warning("请填写 SKU 编码与批次号"); return; }
    setActing(null);
    setWriteError(null);
    setQuery({ sku: sku.trim(), batch: batch.trim() });
    traceRead.retry();
    placementRead.retry();
  };

  const openAction = (row: PlacementRow, intent: "quarantine" | "release") => {
    if (busy.current || !canOperate || !data || !placements || !placements.rows.includes(row)) return;
    setActing({ row, intent, trace: data, placements });
    setWriteError(null);
    setIdempotencyKey(crypto.randomUUID());
    form.resetFields();
    form.setFieldsValue({ qty: row.qty, reason: "", toBinId: undefined });
  };

  const targetBins = (placements?.bins ?? []).filter((bin) => {
    if (!active) return false;
    if (bin.warehouseId !== active.row.warehouseId) return false;
    if (bin.id === active.row.binId) return false;
    return active.intent === "quarantine" ? bin.kind === "quarantine" : ["normal", "staging"].includes(bin.kind);
  });

  const submitAction = async () => {
    if (!active || busy.current || writeError) return;
    const target = active;
    busy.current = true;
    setSaving(true);
    const request = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const values = await form.validateFields();
      if (current.current.data !== target.trace || current.current.placements !== target.placements || !current.current.canOperate) {
        throw new Error("批次或库位信息已变更，请重新查询后操作");
      }
      timeout = setTimeout(() => request.abort(), 30_000);
      await fetchJson("/api/inventory/quarantine", { method: "POST", signal: request.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        idempotencyKey,
        intent: target.intent,
        warehouseId: target.row.warehouseId,
        skuId: target.trace.batch.skuId,
        batchId: target.trace.batch.id,
        fromBinId: target.row.binId,
        toBinId: values.toBinId ?? null,
        qty: String(values.qty),
        reason: values.reason,
      }) });
      message.success(target.intent === "quarantine" ? "已隔离该批次库存" : "已放行该批次库存");
      setActing(null);
      placementRead.retry();
    } catch (e) {
      if (request.signal.aborted) setWriteError("操作等待超时，服务端可能已完成。请先核对库位分布与作业记录，勿重复提交。");
      else if (e instanceof Error && e.message) setWriteError(e.message);
    } finally {
      if (timeout) clearTimeout(timeout);
      busy.current = false;
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
        <Input aria-label="SKU 编码" placeholder="SKU 编码" value={sku} disabled={saving} onChange={(e) => editQuery("sku", e.target.value)} style={{ width: 200, maxWidth: "100%" }} onPressEnter={(e) => { if (!e.nativeEvent.isComposing && e.keyCode !== 229) run(); }} />
        <Input aria-label="批次号" placeholder="批次号" value={batch} disabled={saving} onChange={(e) => editQuery("batch", e.target.value)} style={{ width: 200, maxWidth: "100%" }} onPressEnter={(e) => { if (!e.nativeEvent.isComposing && e.keyCode !== 229) run(); }} />
        <Button type="primary" loading={loading} disabled={saving} onClick={run}>追溯</Button>
      </Space>
      <LoadErrorAlert subject="批次追溯" error={traceError} onRetry={run} />

      {!data ? (
        <Empty description={loading ? "正在读取当前批次…" : traceError ? "当前批次尚未加载，请重试或核对编码" : "输入 SKU 编码与批次号开始追溯"} />
      ) : (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Alert
            type={data.coverage.outboundTraceable ? "success" : "warning"}
            showIcon
            message={data.coverage.outboundTraceable ? "出库侧可追溯" : "出库侧覆盖有限"}
            description={data.coverage.note}
          />
          <Card size="small" title="批次登记">
            <Descriptions column={{ xs: 1, sm: 2 }} size="small">
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
              scroll={{ x: 420 }}
              locale={{ emptyText: "该批次当前无参考层库存记录" }}
              columns={[
                { title: "仓库", dataIndex: "warehouse", width: 180 },
                { title: "数量", dataIndex: "qty", width: 120, align: "right", render: (v: number) => formatQty(String(v)) },
                { title: "盘点期间", dataIndex: "stocktakeDate", width: 120 },
              ]}
            />
          </Card>
          {/* W2-6：召回/检验不合格时，这里才是「把这批货就地隔离」的入口。
              隔离/放行都走 bin_movements 的既有不变量守卫与审计，不另开写路径。 */}
          <Card
            size="small"
            title="物理分布与隔离处置（库位子账）"
          >
            <div style={{ marginBottom: 12 }}><Typography.Text type="secondary">仓库总账仍是数量真相；隔离只改「货在哪」，不改库存数量</Typography.Text></div>
            <LoadErrorAlert subject="库位分布" error={placementError} onRetry={() => { if (!busy.current) { setActing(null); placementRead.retry(); } }} />
            <Table<PlacementRow>
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={placements?.rows ?? []}
              loading={placementRead.phase === "loading"}
              scroll={{ x: 660 }}
              columns={placementColumns}
              locale={{ emptyText: placements ? "该批次在实时仓无可作业库存（快照仓不参与库位作业）" : "库位分布尚未加载，不能判断可作业库存" }}
            />
          </Card>
          <Card size="small" title="台账流水（带批次的部分）">
            <Table<LedgerRow>
              rowKey={(r) => `${r.occurredAt}-${r.sourceDocId}`}
              size="small"
              pagination={false}
              dataSource={data.ledger}
              scroll={{ x: 650 }}
              locale={{ emptyText: "暂无带该批次的台账流水（见上方覆盖说明）" }}
              columns={[
                { title: "日期", dataIndex: "occurredAt", width: 110 },
                { title: "仓库", dataIndex: "warehouse", width: 150 },
                { title: "方向", width: 80, render: (_: unknown, r: LedgerRow) => <Tag color={r.qtyDelta >= 0 ? "green" : "orange"}>{r.qtyDelta >= 0 ? "入库" : "出库"}</Tag> },
                { title: "数量", dataIndex: "qtyDelta", width: 130, align: "right", render: (v: number) => formatQty(String(Math.abs(v))) },
                { title: "来源单据", width: 180, render: (_: unknown, r: LedgerRow) => `${r.sourceDocType} #${r.sourceDocId}` },
              ]}
            />
          </Card>
        </Space>
      )}

      <Modal
        open={active != null}
        title={active ? `${active.intent === "quarantine" ? "隔离" : "放行"} · ${active.trace.batch.skuCode} / ${active.trace.batch.batchNo}` : ""}
        okText="确认作业"
        cancelText="取消"
        confirmLoading={saving}
        okButtonProps={{ disabled: !active || saving || writeError != null }}
        cancelButtonProps={{ disabled: saving }}
        closable={!saving}
        keyboard={!saving}
        maskClosable={false}
        onOk={() => void submitAction()}
        onCancel={() => { if (!busy.current) setActing(null); }}
        destroyOnHidden
      >
        {active ? (
          <>
            {writeError ? <Alert type="error" showIcon message="操作未确认，请先核对结果" description={writeError}
              action={<Button onClick={() => { if (!busy.current) { setActing(null); setWriteError(null); placementRead.retry(); } }}>核对当前分布</Button>} style={{ marginBottom: 12 }} /> : null}
            <Descriptions size="small" bordered column={1} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="仓库">{active.row.warehouseName}</Descriptions.Item>
              <Descriptions.Item label="来源位置">{active.row.binCode ?? "未定位"}</Descriptions.Item>
              <Descriptions.Item label="可作业量">{formatQty(active.row.qty)}</Descriptions.Item>
            </Descriptions>
            <Form form={form} layout="vertical" disabled={saving || writeError != null}>
              <Form.Item
                name="toBinId"
                label={active.intent === "quarantine" ? "目标隔离库位" : "放行目标库位"}
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
                <InputNumber stringMode min="0.0001" precision={4} style={{ width: 180 }} />
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
