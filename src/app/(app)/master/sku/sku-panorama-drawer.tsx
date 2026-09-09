"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Collapse, Descriptions, Drawer, Empty, Spin, Table, Tag, Typography } from "antd";
import dynamic from "next/dynamic";
import Link from "next/link";
import { fetchJson } from "@/components/fetchJson";
import { formatQty, LIFECYCLE_LABELS } from "@/components/format";
import { DOC_STATUS_LABELS, LEDGER_SOURCE_LABELS, SKU_TYPE_LABELS, WAREHOUSE_KIND_LABELS } from "@/components/labels";
import { useMe, hasAnyRole } from "@/components/useMe";

const SourceStatusPanel = dynamic(() => import("./sku-source-status-panel"), { loading: () => <Spin /> });

/** /api/master/sku/[id]/panorama 载荷（纯数量口径） */
interface Panorama {
  sku: {
    id: number;
    code: string;
    name: string;
    spec: string | null;
    version: string | null;
    baseUom: string;
    skuType: string;
    lifecycle: string;
    active: boolean;
    attrs: Record<string, unknown> | null;
    brandName: string | null;
    spuCode: string;
    spuName: string;
  };
  balances: { warehouseId: number; warehouseName: string; warehouseKind: string; qty: string }[];
  snapshots: { warehouseId: number; warehouseName: string; bizDate: string; qty: string; ageDays: number }[];
  batches: { warehouseName: string; batchNo: string | null; prodDate: string | null; expiryDate: string; daysLeft: number; qty: string }[];
  sales: { months: string[]; byMonth: { month: string; qty: number }[]; topChannels: { name: string; qty: number }[] };
  openDocs: {
    poLines: { poId: number; docNo: string; status: string; supplierName: string; expectedDate: string | null; openQty: string }[];
    woDocs: { woId: number; docNo: string; status: string; supplierName: string; qty: string; dueDate: string | null }[];
  };
  ledger: { id: number; occurredAt: string; sourceDocType: string; docNo: string | null; warehouseName: string; qtyDelta: string; action: string }[];
  activeBom: { id: number; versionNo: string; lineCount: number } | null;
}

const SKU_TYPE_COLORS: Record<string, string> = { finished: "blue", raw: "green", packaging: "orange" };
const LIFECYCLE_COLORS: Record<string, string> = { on_sale: "success", trial: "processing", halted: "warning", retired: "default" };

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Typography.Title level={5} style={{ marginTop: 20, marginBottom: 8 }}>
      {children}
    </Typography.Title>
  );
}

/** attrs 中的复核类标记 → 标签（needsReview 专项 + 其余真值兜底展示） */
function attrTags(attrs: Record<string, unknown> | null): React.ReactNode[] {
  if (!attrs || typeof attrs !== "object") return [];
  const tags: React.ReactNode[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (!v) continue;
    if (k === "needsReview") tags.push(<Tag key={k} color="orange">待复核</Tag>);
    else if (typeof v === "string") tags.push(<Tag key={k}>{`${k}: ${v}`}</Tag>);
    else tags.push(<Tag key={k}>{k}</Tag>);
  }
  return tags;
}

function expiryTag(daysLeft: number): React.ReactNode {
  if (daysLeft <= 0) return <Tag color="red">已到期</Tag>;
  if (daysLeft <= 92) return <Tag color="red">{daysLeft} 天</Tag>;
  if (daysLeft <= 183) return <Tag color="orange">{daysLeft} 天</Tag>;
  return <Tag>{daysLeft} 天</Tag>;
}

export default function SkuPanoramaDrawer({ skuId, onClose }: { skuId: number | null; onClose: () => void }) {
  const me = useMe();
  const [data, setData] = useState<Panorama | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [sourcePending, setSourcePending] = useState(false);

  useEffect(() => {
    if (skuId == null) return;
    const controller = new AbortController();
    setData(null);
    setError(null);
    setLoading(true);
    fetchJson<Panorama>(`/api/master/sku/${skuId}/panorama`, { signal: controller.signal })
      .then(next => { if (!controller.signal.aborted) setData(next); })
      .catch(e => { if (!controller.signal.aborted) setError((e as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [skuId, retry]);

  const maxMonthQty = Math.max(1, ...(data?.sales.byMonth.map((r) => r.qty) ?? [1]));

  return (
    <Drawer
      title={data?.sku.id === skuId ? `SKU 全景 · ${data.sku.code} ${data.sku.name}` : "SKU 全景"}
      width={720}
      open={skuId != null}
      onClose={onClose}
      closable={!sourcePending}
      maskClosable={!sourcePending}
      keyboard={!sourcePending}
      destroyOnHidden
    >
      {loading && <Spin style={{ display: "block", margin: "48px auto" }} />}
      {!loading && error && <Alert type="error" showIcon message="SKU 全景读取失败" description={error} action={<Button onClick={() => setRetry(value => value + 1)}>重新读取</Button>} />}
      {!loading && !error && data?.sku.id === skuId && (
        <div>
          <Descriptions
            size="small"
            column={{ xs: 1, sm: 2 }}
            bordered
            items={[
              { key: "code", label: "编码", children: data.sku.code },
              { key: "name", label: "名称", children: data.sku.name },
              { key: "brand", label: "品牌", children: data.sku.brandName ?? "—" },
              { key: "spu", label: "所属 SPU", children: `${data.sku.spuCode} ${data.sku.spuName}` },
              { key: "uom", label: "基础单位", children: data.sku.baseUom },
              {
                key: "type",
                label: "类型",
                children: <Tag color={SKU_TYPE_COLORS[data.sku.skuType]}>{SKU_TYPE_LABELS[data.sku.skuType] ?? data.sku.skuType}</Tag>,
              },
              {
                key: "lifecycle",
                label: "生命周期",
                children: (
                  <>
                    <Tag color={LIFECYCLE_COLORS[data.sku.lifecycle]}>{LIFECYCLE_LABELS[data.sku.lifecycle] ?? data.sku.lifecycle}</Tag>
                    {!data.sku.active && <Tag>已停用</Tag>}
                    {attrTags(data.sku.attrs)}
                  </>
                ),
              },
              { key: "spec", label: "规格", children: data.sku.spec ?? "—" },
            ]}
          />

          {hasAnyRole(me, "pmc", "purchasing", "warehouse") && <Collapse style={{ marginTop: 12 }} items={[{
            key: "source-status", label: "来源状态与人工核对（聚水潭 / 简道云）",
            children: <SourceStatusPanel key={data.sku.id} skuId={data.sku.id} onPendingChange={setSourcePending} onConfirmed={lifecycle => setData(previous => previous?.sku.id === skuId ? { ...previous, sku: { ...previous.sku, lifecycle } } : previous)} />,
          }]} />}

          <SectionTitle>库存（实时账）</SectionTitle>
          <Table
            size="small"
            rowKey="warehouseId"
            pagination={false}
            dataSource={data.balances}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无实时库存" /> }}
            columns={[
              { title: "仓库", dataIndex: "warehouseName" },
              { title: "仓类", dataIndex: "warehouseKind", width: 90, render: (v: string) => WAREHOUSE_KIND_LABELS[v] ?? v },
              { title: "数量", dataIndex: "qty", width: 120, align: "right", render: (v: string) => formatQty(v) },
            ]}
          />
          {data.snapshots.length > 0 && (
            <Table
              size="small"
              rowKey="warehouseId"
              pagination={false}
              style={{ marginTop: 8 }}
              dataSource={data.snapshots}
              columns={[
                { title: "快照仓", dataIndex: "warehouseName" },
                { title: "快照日期", dataIndex: "bizDate", width: 110 },
                {
                  title: "数据龄",
                  dataIndex: "ageDays",
                  width: 90,
                  render: (v: number) => <Tag color={v > 3 ? "orange" : "green"}>{v} 天</Tag>,
                },
                { title: "数量", dataIndex: "qty", width: 120, align: "right", render: (v: string) => formatQty(v) },
              ]}
            />
          )}

          <SectionTitle>效期（最近到期批次）</SectionTitle>
          <Table
            size="small"
            rowKey={(r) => `${r.warehouseName}-${r.batchNo ?? ""}-${r.expiryDate}-${r.prodDate ?? ""}`}
            pagination={false}
            dataSource={data.batches}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无效期批次记录" /> }}
            columns={[
              { title: "仓库", dataIndex: "warehouseName" },
              { title: "批次", dataIndex: "batchNo", render: (v: string | null) => v ?? "—" },
              { title: "到期日", dataIndex: "expiryDate", width: 110 },
              { title: "剩余", dataIndex: "daysLeft", width: 100, render: (v: number) => expiryTag(v) },
              { title: "数量", dataIndex: "qty", width: 110, align: "right", render: (v: string) => formatQty(v) },
            ]}
          />

          <SectionTitle>销量（近 6 月，全渠道合计）</SectionTitle>
          {data.sales.byMonth.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无销量记录" />
          ) : (
            <div>
              {data.sales.byMonth.map((r) => (
                <div key={r.month} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ width: 64, fontSize: 12, color: "#666" }}>{r.month}</span>
                  <div style={{ flex: 1, background: "#f0f0f0", borderRadius: 2, height: 14 }}>
                    <div
                      style={{
                        width: `${Math.max(r.qty > 0 ? 2 : 0, Math.round((r.qty / maxMonthQty) * 100))}%`,
                        background: "#1677ff",
                        height: 14,
                        borderRadius: 2,
                      }}
                    />
                  </div>
                  <span style={{ width: 90, textAlign: "right", fontSize: 12 }}>{formatQty(r.qty)}</span>
                </div>
              ))}
              <div style={{ marginTop: 8 }}>
                {data.sales.topChannels.map((c) => (
                  <Tag key={c.name} color="blue">
                    {c.name} {formatQty(c.qty)}
                  </Tag>
                ))}
              </div>
            </div>
          )}

          <SectionTitle>在途 / 在制</SectionTitle>
          <Table
            size="small"
            rowKey={(r) => `po-${r.poId}-${r.docNo}`}
            pagination={false}
            dataSource={data.openDocs.poLines}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无在途采购" /> }}
            columns={[
              {
                title: "采购单",
                dataIndex: "docNo",
                render: (v: string) => <Link href="/outsource/po">{v}</Link>,
              },
              { title: "供应商", dataIndex: "supplierName" },
              { title: "状态", dataIndex: "status", width: 90, render: (v: string) => DOC_STATUS_LABELS[v] ?? v },
              { title: "预计到货", dataIndex: "expectedDate", width: 100, render: (v: string | null) => v ?? "—" },
              { title: "未收数量", dataIndex: "openQty", width: 110, align: "right", render: (v: string) => formatQty(v) },
            ]}
          />
          {data.openDocs.woDocs.length > 0 && (
            <Table
              size="small"
              rowKey="woId"
              pagination={false}
              style={{ marginTop: 8 }}
              dataSource={data.openDocs.woDocs}
              columns={[
                {
                  title: "委外工单",
                  dataIndex: "docNo",
                  render: (v: string) => <Link href="/outsource/wo">{v}</Link>,
                },
                { title: "加工厂", dataIndex: "supplierName" },
                { title: "状态", dataIndex: "status", width: 90, render: (v: string) => DOC_STATUS_LABELS[v] ?? v },
                { title: "交期", dataIndex: "dueDate", width: 100, render: (v: string | null) => v ?? "—" },
                { title: "数量", dataIndex: "qty", width: 110, align: "right", render: (v: string) => formatQty(v) },
              ]}
            />
          )}

          <SectionTitle>近期流水（最近 10 条）</SectionTitle>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={data.ledger}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无流水" /> }}
            columns={[
              {
                title: "时间",
                dataIndex: "occurredAt",
                width: 150,
                render: (v: string) => new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hourCycle: "h23" }),
              },
              { title: "来源", dataIndex: "sourceDocType", width: 100, render: (v: string) => LEDGER_SOURCE_LABELS[v] ?? v },
              { title: "单号", dataIndex: "docNo", render: (v: string | null) => v ?? "—" },
              { title: "仓库", dataIndex: "warehouseName", width: 110 },
              {
                title: "数量变动",
                dataIndex: "qtyDelta",
                width: 110,
                align: "right",
                render: (v: string) => (
                  <span style={{ color: Number(v) < 0 ? "#cf1322" : "#3f8600" }}>{formatQty(v)}</span>
                ),
              },
            ]}
          />

          <SectionTitle>BOM</SectionTitle>
          {data.activeBom ? (
            <div>
              生效版本 <Tag color="success">{data.activeBom.versionNo}</Tag>
              {data.activeBom.lineCount} 行物料 ·{" "}
              <Link href={`/master/bom?q=${encodeURIComponent(data.sku.code)}`}>查看 BOM</Link>
            </div>
          ) : (
            <Typography.Text type="secondary">无生效 BOM</Typography.Text>
          )}
        </div>
      )}
    </Drawer>
  );
}
