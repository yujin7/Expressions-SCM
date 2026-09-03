"use client";

/**
 * 库存预警表（D57）与爆单预警（D56）。
 * - 预警表：每 SKU 一个主预警；日销三口径并列不相加；阈值来源逐行标注；C 级默认折叠。
 * - 爆单：已映射 SKU 与未映射平台 SKU 分列；「已知悉」写审计。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, App, Button, Card, Col, Row, Space, Statistic, Switch, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import SearchInput from "@/components/SearchInput";
import type { InventoryAlertRow, InventoryAlertsReadModel } from "@/server/modules/report/inventory-alerts";
import type { SalesSpikeReadModel, SpikeHit } from "@/server/modules/report/sales-spike";

const TIER_COLOR: Record<string, string> = { S: "red", A: "orange", B: "gold", C: "default" };
const KIND_LABEL: Record<string, string> = { out_of_stock: "断货", spike: "爆单", low_stock: "低于阈值", near_expiry: "临期", overstock: "超储" };

export default function AlertsClient() {
  const { message } = App.useApp();
  const router = useRouter();
  const sp = useSearchParams();
  const tab = sp.get("tab") === "spike" ? "spike" : "cover";
  const [cover, setCover] = useState<InventoryAlertsReadModel | null>(null);
  const [spike, setSpike] = useState<SalesSpikeReadModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState(sp.get("cover_q") ?? "");
  const [showC, setShowC] = useState(false);
  const [onlyAlert, setOnlyAlert] = useState(true);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const [c, s] = await Promise.all([
        fetchJson<InventoryAlertsReadModel>(`/api/report/inventory-alerts${refresh ? "?refresh=1" : ""}`),
        fetchJson<SalesSpikeReadModel>(`/api/report/sales-spike${refresh ? "?refresh=1" : ""}`),
      ]);
      setCover(c); setSpike(s);
    } catch (e) { message.error((e as Error).message); }
    finally { setLoading(false); }
  }, [message]);
  useEffect(() => { if (!cover) void load(); }, [cover, load]);

  const setTab = (key: string) => { const p = new URLSearchParams(sp.toString()); p.set("tab", key); router.replace(`/inventory/alerts?${p.toString()}`); };

  const rows = useMemo(() => {
    if (!cover) return [];
    const needle = q.trim().toLowerCase();
    return cover.rows.filter((r) => (showC || r.tier !== "C") && (!onlyAlert || r.primary || r.status !== "ok") && (!needle || r.code.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)));
  }, [cover, q, showC, onlyAlert]);

  const coverCols: ColumnsType<InventoryAlertRow> = [
    { title: "等级", dataIndex: "tier", width: 64, render: (v: string | null, r) => v ? <Tag color={TIER_COLOR[v]}>{v}{r.tierSource === "computed" ? "*" : ""}</Tag> : <Tag>未分层</Tag> },
    { title: "SKU", key: "sku", width: 220, render: (_, r) => <Space direction="vertical" size={0}><Typography.Text strong>{r.code}</Typography.Text><Typography.Text type="secondary" ellipsis style={{ maxWidth: 200 }}>{r.name}{r.brand ? ` · ${r.brand}` : ""}</Typography.Text></Space> },
    { title: "日销 外部", key: "de", align: "right", width: 90, render: (_, r) => r.daily.external == null ? "—" : r.daily.external },
    { title: "内部", key: "di", align: "right", width: 80, render: (_, r) => r.daily.internal == null ? "—" : r.daily.internal },
    { title: "实时仓", key: "dl", align: "right", width: 80, render: (_, r) => r.daily.ledger == null ? "—" : r.daily.ledger },
    { title: "近30天净件", dataIndex: "net30External", align: "right", width: 100, render: (v: number | null) => v == null ? "—" : v.toLocaleString("zh-CN") },
    { title: "在库", dataIndex: "onHand", align: "right", width: 90, render: (v: string) => Number(v).toLocaleString("zh-CN") },
    { title: "可销天数", dataIndex: "coverDays", align: "right", width: 90, render: (v: number | null, r) => v == null ? <Typography.Text type="secondary">无日销</Typography.Text> : <Typography.Text type={r.status === "alert" ? "danger" : r.status === "watch" ? "warning" : undefined} strong>{v}d</Typography.Text> },
    { title: "阈值", key: "ad", width: 150, render: (_, r) => <span>{r.alertDays}d {r.usedDefault ? <Tag>缺省周期</Tag> : null}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.alertBasis}</Typography.Text></span> },
    { title: "主预警", key: "p", width: 110, render: (_, r) => r.primary ? <Space size={4} wrap><Tag color={r.primary === "out_of_stock" ? "error" : r.primary === "spike" ? "magenta" : "warning"}>{KIND_LABEL[r.primary]}</Tag>{r.tags.map((t) => <Tag key={t}>{KIND_LABEL[t]}</Tag>)}</Space> : <Typography.Text type="secondary">—</Typography.Text> },
    { title: "动作", key: "a", width: 120, render: (_, r) => <Space size={8}><a href={r.actions.transfer}>调拨</a><a href={r.actions.replenish}>补货</a></Space> },
  ];

  const ack = async (id: number | null) => {
    if (!id) return;
    try { await fetchJson(`/api/alerts/${id}/ack`, { method: "POST", body: JSON.stringify({}) }); message.success("已知悉"); }
    catch (e) { message.error((e as Error).message); }
  };
  const spikeCols: ColumnsType<SpikeHit> = [
    { title: "SKU / 平台 SKU", key: "k", render: (_, r) => r.kind === "sku" ? <Space direction="vertical" size={0}><Typography.Text strong>{r.code}</Typography.Text><Typography.Text type="secondary">{r.name}</Typography.Text></Space> : <Space direction="vertical" size={0}><Tag color="blue">未映射</Tag><Typography.Text>{r.platformSkuId}</Typography.Text></Space> },
    { title: "店铺", dataIndex: "shopName", ellipsis: true },
    { title: "最近各日", key: "d", render: (_, r) => r.days.map((d) => d.qty).join(" / ") },
    { title: "涨幅", dataIndex: "risePct", align: "right", width: 90, render: (v: string | null) => v == null ? "—" : <Typography.Text type="danger" strong>+{v}%</Typography.Text> },
    { title: "基线 / 阈值", key: "b", width: 120, render: (_, r) => `${r.baseline} / ${r.threshold}` },
    { title: "截止", dataIndex: "anchorDate", width: 100 },
    { title: "动作", key: "a", width: 140, render: (_, r) => <a href={r.href}>{r.kind === "sku" ? "看补货" : "认领身份"}</a> },
  ];
  void ack;

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Card size="small" title="库存预警与爆单" extra={<Space><Button size="small" onClick={() => void load(true)} loading={loading}>重算</Button><Button size="small" onClick={() => void load()} loading={loading}>刷新</Button></Space>}>
        {cover ? (
          <Row gutter={[12, 12]}>
            <Col xs={12} md={6}><Statistic title="断货（有需求无在库）" value={cover.totals.outOfStock} valueStyle={{ color: cover.totals.outOfStock ? "#B23A2E" : undefined }} /></Col>
            <Col xs={12} md={6}><Statistic title="低于阈值" value={cover.totals.alert} valueStyle={{ color: cover.totals.alert ? "#B7791F" : undefined }} /></Col>
            <Col xs={12} md={6}><Statistic title="关注" value={cover.totals.watch} /></Col>
            <Col xs={12} md={6}><Statistic title="爆单命中" value={spike ? spike.hits.length + spike.unmappedHits.length : "—"} valueStyle={{ color: spike && (spike.hits.length + spike.unmappedHits.length) ? "#B23A2E" : undefined }} /></Col>
          </Row>
        ) : null}
      </Card>
      <Tabs activeKey={tab} onChange={setTab} items={[{ key: "cover", label: "库存预警表" }, { key: "spike", label: "爆单预警" }]} />
      {tab === "cover" ? (
        <Card size="small" extra={<Space><SearchInput allowClear size="small" placeholder="编码 / 名称" value={q} onChange={(e) => setQ(e.target.value)} onSearch={(v) => setQ(v)} style={{ width: 200 }} /><span>只看预警 <Switch size="small" checked={onlyAlert} onChange={setOnlyAlert} /></span><span>含 C 级 <Switch size="small" checked={showC} onChange={setShowC} /></span></Space>}>
          <Table<InventoryAlertRow> rowKey="skuId" size="small" loading={loading} columns={coverCols} dataSource={rows} pagination={{ pageSize: 50, showSizeChanger: false }} scroll={{ x: 1300 }} />
          {cover ? <Alert type="info" showIcon style={{ marginTop: 12 }} message={<div>{cover.limitations.map((l) => <div key={l}>· {l}</div>)}<div>· 参数：加工缺省 {cover.params.productionDefault} 天 · 在途缺省 {cover.params.logisticsDefault} 天 · 缓冲 {cover.params.bufferDays} 天 · 分层切点 {cover.params.tierCuts.sPct}/{cover.params.tierCuts.aPct}/{cover.params.tierCuts.bPct}%（* 为现算等级）</div></div>} /> : null}
        </Card>
      ) : (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Card size="small" title={`已映射 SKU 爆单 ${spike ? spike.hits.length : "—"}`} extra={spike ? <Tag color={spike.state === "ready" ? "success" : "default"}>{spike.anchorDate ? `截止 ${spike.anchorDate}` : "缺流"}</Tag> : null}>
            <Table<SpikeHit> rowKey={(r) => `${r.kind}:${r.skuId ?? r.platformSkuId}:${r.shopName}`} size="small" loading={loading} columns={spikeCols} dataSource={spike?.hits ?? []} pagination={{ pageSize: 20 }} />
          </Card>
          <Card size="small" title={`未映射平台 SKU 爆单 ${spike ? spike.unmappedHits.length : "—"}`}>
            <Table<SpikeHit> rowKey={(r) => `${r.kind}:${r.skuId ?? r.platformSkuId}:${r.shopName}`} size="small" loading={loading} columns={spikeCols} dataSource={spike?.unmappedHits ?? []} pagination={{ pageSize: 20 }} />
          </Card>
          {spike ? <Alert type="info" showIcon message={<div>{spike.limitations.map((l) => <div key={l}>· {l}</div>)}<div>· 覆盖：平台序列 {spike.coverage.platformSeries}，已映射 {spike.coverage.mappedSeries}，系统 SKU {spike.coverage.systemSkus}</div></div>} /> : null}
        </Space>
      )}
    </Space>
  );
}
