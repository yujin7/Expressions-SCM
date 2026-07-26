"use client";

import SearchInput from "@/components/SearchInput";

/** E4-01 批次追溯：召回场景的"这批货从哪来、现在在哪"。出库侧覆盖情况如实标注。 */
import { useCallback, useState } from "react";
import { Alert, App, Card, Descriptions, Empty, Input, Space, Table, Tag, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";
import { formatQty } from "@/components/format";

interface StockRow { warehouse: string; qty: number; stocktakeDate: string }
interface LedgerRow { occurredAt: string; warehouse: string; qtyDelta: number; sourceDocType: string; sourceDocId: number }

interface Trace {
  batch: { id: number; batchNo: string; skuCode: string; skuName: string; prodDate: string | null; expiryDate: string | null };
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

  const run = useCallback(async () => {
    if (!sku.trim() || !batch.trim()) { message.warning("请填写 SKU 编码与批次号"); return; }
    setLoading(true);
    setData(null);
    try {
      setData(await fetchJson<Trace>(`/api/inventory/batch-trace?sku=${encodeURIComponent(sku.trim())}&batch=${encodeURIComponent(batch.trim())}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sku, batch, message]);

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
    </div>
  );
}
