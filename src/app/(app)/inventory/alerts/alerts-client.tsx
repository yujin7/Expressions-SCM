"use client";

/**
 * 库存预警表（D57）与爆单预警（D56）。
 * - 预警表：每 SKU 一个主预警；日销三口径并列不相加；阈值来源逐行标注；C 级默认折叠。
 *   筛选/分页在 URL（useListState，paramPrefix=cover）并由服务端执行（/api/report/inventory-alerts?q/tier/primary/onlyAlert/showC）。
 * - 爆单：已映射 SKU 与未映射平台 SKU 分列（paramPrefix=spike）；
 * - 两张表都接 system_alerts：「已知悉」写审计、显示知悉人/时间，展开行看规则来源 / 参数快照 / 触发原因，
 *   并可由责任角色（或 admin）带原因**关闭**告警（AlertCloseModal → POST /api/alerts/[id]/close，
 *   服务端回查会话与角色再判一次）；关闭后刷新告警索引，行上的「已知悉」随之变回「未开告警」。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, App, Button, Col, Empty, Pagination, Row, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import AlertCloseModal from "@/components/AlertCloseModal";
import AlertEvidence, { ackText, type AlertEvidenceFields } from "@/components/AlertEvidence";
import CaliberNote from "@/components/CaliberNote";
import ContextHelp from "@/components/ContextHelp";
import { exportCsv } from "@/components/exportCsv";
import { formatQty } from "@/components/format";
import ListToolbar from "@/components/ListToolbar";
import LoadErrorAlert from "@/components/LoadErrorAlert";
import SearchInput from "@/components/SearchInput";
import { useListState } from "@/components/useListState";
import { hasAnyRole, useMe } from "@/components/useMe";
import { compareDecimalValues } from "@/lib/decimal-sort";
import { inventoryCoverMetricHref } from "@/lib/cockpit-navigation";
import type { InventoryAlertRow } from "@/server/modules/report/inventory-alerts";
import type { InventoryAlertsPage } from "@/server/modules/report/inventory-alerts-query";
import type { SpikeHit } from "@/server/modules/report/sales-spike";
import type { SalesSpikePage } from "@/server/modules/report/sales-spike-query";
import styles from "./inventory-cover.module.css";

const TIER_COLOR: Record<string, string> = { S: "red", A: "orange", B: "gold", C: "default" };
const KIND_LABEL: Record<string, string> = { out_of_stock: "断货", spike: "爆单", low_stock: "低于阈值", near_expiry: "临期", overstock: "超储" };

const dailyText = (value: number | null) => value == null ? "—" : formatQty(value.toFixed(6));
const DAILY_BASIS: Record<string, string> = { external: "外部观察", internal: "内部月销", ledger: "系统销售净出库" };

export function InternalDemandCell({ row }: { row: Pick<InventoryAlertRow, "code" | "daily" | "internalDemand"> }) {
  const evidence = row.internalDemand;
  return <div className={styles.ledger}>
    <span className={styles.ledgerValue}>{dailyText(row.daily.internal)} <ContextHelp label={`${row.code}内部月销口径`} title="内部月销折日口径"
      content={<>
        <p>上海自然月窗口：{evidence.startDay ?? "未知"}（含）至{evidence.endDayExclusive ?? "未知"}（不含），共{evidence.days ?? "未知"}天。</p>
        <p>已登记销量 {formatQty(evidence.salesQty)} ÷ {evidence.days ?? "未知"} 天 = {dailyText(row.daily.internal)} /日。六个月销量不使用三个月91天分母。</p>
        <p>有记录 {evidence.observedMonths}/6 月；不证明每月、各渠道完整，也不证明已更新到当前月份。缺数须补齐，— 不表示零销售。</p>
      </>} /></span>
    {evidence.observedMonths < 6 && evidence.salesQty != null ? <span className={styles.secondary}>仅{evidence.observedMonths}/6月有记录</span> : null}
  </div>;
}

/** Same figures and explanation in the wide table and narrow cards; no demand recomputation. */
export function LedgerDemandCell({ row }: { row: Pick<InventoryAlertRow, "code" | "daily" | "ledgerDemand"> }) {
  const evidence = row.ledgerDemand;
  return <div className={styles.ledger}>
    <span className={styles.ledgerValue}>{dailyText(row.daily.ledger)} /日 <ContextHelp
      label={`${row.code}销售与作业口径`} title="销售与作业口径"
      content={<>
        <p>上海业务日：{evidence.startDay}（含）至{evidence.endDayExclusive}（不含），共{evidence.days}天。</p>
        <p>销售净出库 {formatQty(evidence.salesNetQty)} ÷ {evidence.days} 天。销售红字按纠正日净减。</p>
        <p>作业量是窗口内非销售负向流量合计，未扣正向冲销，不参与需求判断。</p>
        <p>— 表示无对应事件；不证明零需求或全渠道覆盖。零或负销售净量也不作正需求。</p>
      </>} /></span>
    <span className={styles.secondary}>作业 {formatQty(evidence.operationsOutQty)}（窗口合计）</span>
  </div>;
}

type CoverCardRow = Pick<InventoryAlertRow, "code" | "name" | "brand" | "tier" | "tierSource" | "primary" | "tags" | "onHand" | "primaryDaily" | "primaryDailySource" | "coverDays" | "alertDays" | "alertBasis" | "usedDefault" | "daily" | "ledgerDemand" | "internalDemand" | "net30External" | "statusBasis">;

export function InventoryCoverCard({ row, ack, actions, detail }: { row: CoverCardRow; ack: ReactNode; actions: ReactNode; detail?: ReactNode }) {
  return <article className={styles.card} aria-label={`${row.code} 库存预警`}>
    <header className={styles.cardHeader}>
      <strong>{row.code}</strong>
      <span>{row.tier ? <Tag color={TIER_COLOR[row.tier]}>{row.tier}{row.tierSource === "computed" ? "*" : ""}</Tag> : <Tag>未分层</Tag>}
        {row.primary ? <Tag color={row.primary === "out_of_stock" ? "error" : "warning"}>{KIND_LABEL[row.primary]}</Tag> : <span className={styles.secondary}>未形成主预警</span>}
        {row.tags.map(tag => <Tag key={tag}>{KIND_LABEL[tag]}</Tag>)}
      </span>
    </header>
    <p className={styles.name}>{row.name}{row.brand ? ` · ${row.brand}` : ""}</p>
    <dl className={styles.facts}>
      <div><dt>在库</dt><dd>{formatQty(row.onHand)}</dd></div>
      <div><dt>主日销 /日</dt><dd>{dailyText(row.primaryDaily)}</dd></div>
      <div><dt>可销天数</dt><dd>{row.coverDays == null ? "无正日销" : `${row.coverDays}天`}</dd></div>
      <div><dt>阈值</dt><dd>{row.alertDays}天{row.usedDefault ? <small> · 含缺省周期</small> : null}</dd></div>
    </dl>
    <div className={styles.sales}><span className={styles.secondary}>系统销售 / 作业</span><LedgerDemandCell row={row} /></div>
    <p className={styles.basis}>主日销来源：{row.primaryDailySource ? DAILY_BASIS[row.primaryDailySource] : "未取得正日销"}；三口径不相加，作业量不作需求。</p>
    {row.primaryDailySource === "internal" && row.internalDemand.observedMonths < 6 ? <p className={styles.basis}>月销仅{row.internalDemand.observedMonths}/6月有记录，需核对缺失数据。</p> : null}
    <details className={styles.details}><summary>其他口径与阈值依据</summary>
      <dl><dt>外部日销</dt><dd>{dailyText(row.daily.external)}</dd><dt>内部日销</dt><dd><InternalDemandCell row={row} /></dd><dt>外部30天净件</dt><dd>{formatQty(row.net30External)}</dd></dl>
      <p>{row.alertBasis}</p>{row.statusBasis ? <p>{row.statusBasis}</p> : null}
    </details>
    <footer className={styles.footer}>{ack}<div>{actions}</div></footer>
    {detail ? <details className={styles.details}><summary>告警证据与处置</summary>{detail}</details> : null}
  </article>;
}

function CoverActions({ row }: { row: Pick<InventoryAlertRow, "actions" | "primary" | "tags"> }) {
  const kinds = new Set([...(row.primary ? [row.primary] : []), ...row.tags]);
  return <Space size={8} wrap>
    <a href={row.actions.transfer}>调拨</a><a href={row.actions.replenish}>补货</a>
    {kinds.has("near_expiry") ? <a href={row.actions.nearExpiry}>效期</a> : null}
    {kinds.has("overstock") ? <a href={row.actions.overstock}>处置</a> : null}
  </Space>;
}

/* ── system_alerts 索引：按去重键找到读模型行对应的告警（已知悉 / 证据） ── */
interface AlertRef extends AlertEvidenceFields { id: number; dedupeKey: string | null; status: string; ownerRole?: string | null }

function useAlertIndex(category: string) {
  const { message } = App.useApp();
  const [byKey, setByKey] = useState<Record<string, AlertRef>>({});
  const [unacked, setUnacked] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetchJson<{ rows: AlertRef[] }>(`/api/alerts?category=${category}&status=open&pageSize=500`);
      const next: Record<string, AlertRef> = {};
      let n = 0;
      for (const r of res.rows) { if (r.dedupeKey) next[r.dedupeKey] = r; if (!r.ackedAt) n++; }
      setByKey(next);
      setUnacked(n);
    } catch { setUnacked(null); }
  }, [category]);
  useEffect(() => { void load(); }, [load]);
  const ack = useCallback(async (id: number) => {
    try { await fetchJson(`/api/alerts/${id}/ack`, { method: "POST", body: JSON.stringify({}) }); message.success("已知悉（已留审计，告警状态不变）"); await load(); }
    catch (e) { message.error((e as Error).message); }
  }, [load, message]);
  return { byKey, unacked, ack, reload: load };
}

/**
 * 「已知悉」按钮只对持有该告警 ownerRole 的人或 admin 显示（ownerRole 为空的历史行只有 admin）——
 * 与服务端 ackAlert 的判定同口径（安全审计 S2：ack 与 close 现在是同一条权限）；
 * 前端隐藏不是权限，服务端仍会回查会话再判一次。
 */
function AckCell({ alert, onAck }: { alert: AlertRef | undefined; onAck: (id: number) => void }) {
  const me = useMe();
  if (!alert) return <Typography.Text type="secondary">未开告警</Typography.Text>;
  if (alert.ackedAt) return <Tooltip title={ackText(alert)}><Tag color="default">已知悉 · {alert.ackedByName ?? (alert.ackedBy != null ? `#${alert.ackedBy}` : "")}</Tag></Tooltip>;
  const canAck = alert.ownerRole ? hasAnyRole(me, alert.ownerRole) : hasAnyRole(me);
  if (!canAck) return <Typography.Text type="secondary">未知悉</Typography.Text>;
  return <Button size="small" onClick={() => onAck(alert.id)}>已知悉</Button>;
}

/**
 * 展开行：证据（规则/参数快照/why）+ 人工关闭。
 * 关闭按钮只对持有该告警 ownerRole 的人或 admin 显示（ownerRole 为空的历史行只有 admin）——
 * 与服务端 closeAlert 的判定同口径；前端隐藏不是权限，服务端仍会回查会话再判一次。
 */
function AlertRowDetail({ alert, onClosed }: { alert: AlertRef; onClosed: () => void }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const canClose = alert.status === "open" && (alert.ownerRole ? hasAnyRole(me, alert.ownerRole) : hasAnyRole(me));
  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <AlertEvidence alert={alert} />
      {canClose ? (
        <>
          <Button size="small" danger onClick={() => setOpen(true)}>关闭告警</Button>
          <AlertCloseModal
            open={open}
            alertId={alert.id}
            onCancel={() => setOpen(false)}
            onClosed={() => { setOpen(false); onClosed(); }}
          />
        </>
      ) : null}
    </Space>
  );
}

/* ── Tab 1：库存预警表 ── */
type CoverFilters = { q?: string; tier?: string; primary?: string; status?: string; onlyAlert?: string; showC?: string };

function CoverTab() {
  const { message } = App.useApp();
  const me = useMe();
  const canRefresh = hasAnyRole(me, "pmc"); // 与 /api/report/inventory-alerts?refresh=1 的 requireAnyRole(pmc, admin) 一致
  const listState = useListState<CoverFilters>({ key: "inventory-alerts-cover", paramPrefix: "cover", defaults: { q: "", tier: "", primary: "", status: "", onlyAlert: "1", showC: "" }, defaultPageSize: 50 });
  const { filters } = listState;
  const [snapshot, setSnapshot] = useState<{ query: string; value: InventoryAlertsPage } | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alerts = useAlertIndex("inventory_cover");
  const query = listState.queryString();
  const data = snapshot?.query === query ? snapshot.value : null;
  const load = useCallback(async (refresh = false) => {
    readRequest.current?.abort();
    const request = new AbortController(); readRequest.current = request;
    setLoading(true);
    setError(null);
    setSnapshot(null);
    const timeout = setTimeout(() => {
      if (readRequest.current !== request || request.signal.aborted) return;
      request.abort(); setError("库存预警读取超时，请重试"); setLoading(false);
    }, 15000);
    try {
      const value = await fetchJson<InventoryAlertsPage>(`/api/report/inventory-alerts?${query}${refresh ? "&refresh=1" : ""}`, { signal: request.signal });
      if (!request.signal.aborted) setSnapshot({ query, value });
    }
    catch (e) { if (!request.signal.aborted) setError((e as Error).message); }
    finally { clearTimeout(timeout); if (!request.signal.aborted) setLoading(false); }
  }, [query]);
  useEffect(() => { void load(); return () => readRequest.current?.abort(); }, [load]);

  const onExport = async () => {
    try {
      const sp = new URLSearchParams(query); sp.set("page", "1"); sp.set("pageSize", "5000");
      const all = await fetchJson<InventoryAlertsPage>(`/api/report/inventory-alerts?${sp.toString()}`);
      exportCsv(
        `库存预警表-${all.builtAt.slice(0, 10)}`,
        ["等级", "等级来源", "SKU", "名称", "品牌", "日销外部", "日销内部", "实时仓销售净出库日均", "主日销", "主日销来源", "外部近30天净件", "在库", "可销天数", "阈值天", "阈值依据", "状态", "主预警", "标签", "优先级分", "实时仓窗口开始(含)", "实时仓窗口结束(不含)", "实时仓销售净出库(含销售红字)", "非销售作业出库(未扣正向冲销,不作需求)", "内部月销窗口开始(含)", "内部月销窗口结束(不含)", "内部月销窗口自然日", "内部已登记销量", "内部有记录月份数(不证明完整覆盖)"],
        all.rows.map((r) => [r.tier, r.tierSource, r.code, r.name, r.brand, r.daily.external, r.daily.internal, r.daily.ledger, r.primaryDaily, r.primaryDailySource, r.net30External, r.onHand, r.coverDays, r.alertDays, r.alertBasis, r.status, r.primary, r.tags.join("|"), r.priorityScore, r.ledgerDemand.startDay, r.ledgerDemand.endDayExclusive, r.ledgerDemand.salesNetQty, r.ledgerDemand.operationsOutQty, r.internalDemand.startDay, r.internalDemand.endDayExclusive, r.internalDemand.days, r.internalDemand.salesQty, r.internalDemand.observedMonths]),
        all.filtered.total > all.rows.length ? `仅导出前 ${all.rows.length} 行，共 ${all.filtered.total} 行` : undefined,
      );
    } catch (e) { message.error((e as Error).message); }
  };

  const columns: ColumnsType<InventoryAlertRow> = [
    { title: "SKU", key: "sku", width: 220, fixed: "left", render: (_, r) => <Space direction="vertical" size={0}><Typography.Text strong>{r.code}</Typography.Text><Typography.Text type="secondary" ellipsis style={{ maxWidth: 200 }}>{r.name}{r.brand ? ` · ${r.brand}` : ""}</Typography.Text></Space> },
    { title: "等级", dataIndex: "tier", width: 64, render: (v: string | null, r) => v ? <Tag color={TIER_COLOR[v]}>{v}{r.tierSource === "computed" ? "*" : ""}</Tag> : <Tag>未分层</Tag> },
    { title: "日销 外部", key: "de", align: "right", width: 110, render: (_, r) => dailyText(r.daily.external) },
    { title: "内部", key: "di", align: "right", width: 140, render: (_, r) => <InternalDemandCell row={r} /> },
    { title: "系统销售 / 作业", key: "dl", align: "right", width: 185, render: (_, r) => <LedgerDemandCell row={r} /> },
    { title: "外部30天净件", dataIndex: "net30External", align: "right", width: 110, sorter: (a, b, order) => compareDecimalValues(a.net30External, b.net30External, order === "descend" ? "first" : "last"), render: (v: string | null) => v == null ? "—" : formatQty(v) },
    { title: "在库", dataIndex: "onHand", align: "right", width: 90, sorter: (a, b) => compareDecimalValues(a.onHand, b.onHand), render: (v: string) => formatQty(v) },
    { title: "可销天数", dataIndex: "coverDays", align: "right", width: 100, sorter: (a, b) => (a.coverDays ?? Number.MAX_SAFE_INTEGER) - (b.coverDays ?? Number.MAX_SAFE_INTEGER), render: (v: number | null, r) => v == null ? <Typography.Text type="secondary">无日销</Typography.Text> : <Typography.Text type={r.status === "alert" ? "danger" : r.status === "watch" ? "warning" : undefined} strong>{v}d</Typography.Text> },
    { title: "阈值", key: "ad", width: 150, render: (_, r) => <span>{r.alertDays}d {r.usedDefault ? <Tag>缺省周期</Tag> : null}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.alertBasis}</Typography.Text></span> },
    { title: "主预警", key: "p", width: 120, render: (_, r) => r.primary ? <Space size={4} wrap><Tag color={r.primary === "out_of_stock" ? "error" : r.primary === "spike" ? "magenta" : "warning"}>{KIND_LABEL[r.primary]}</Tag>{r.tags.map((t) => <Tag key={t}>{KIND_LABEL[t]}</Tag>)}</Space> : <Typography.Text type="secondary">—</Typography.Text> },
    { title: "已知悉", key: "ack", width: 150, render: (_, r) => <AckCell alert={alerts.byKey[`inventory_cover:${r.skuId}`]} onAck={(id) => void alerts.ack(id)} /> },
    {
      title: "动作", key: "a", width: 150, fixed: "right",
      // 每个主预警种类都有落地页：临期 → 效期批次清单（该 SKU 全部段位），积压 → 风险处置；标签命中也给入口
      render: (_, r) => <CoverActions row={r} />,
    },
  ];

  return (
    <div className={styles.list}>
      {data ? (
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={12} md={6}><a href={inventoryCoverMetricHref("outOfStock")}><Statistic title="断货（有需求无在库）" value={data.totals.outOfStock} valueStyle={{ color: data.totals.outOfStock ? "#B23A2E" : undefined }} /></a></Col>
          <Col xs={12} md={6}><a href={inventoryCoverMetricHref("alert")}><Statistic title="低于阈值" value={data.totals.alert} valueStyle={{ color: data.totals.alert ? "#B7791F" : undefined }} /></a></Col>
          <Col xs={12} md={6}><a href={inventoryCoverMetricHref("watch")}><Statistic title="关注" value={data.totals.watch} /></a></Col>
          <Col xs={12} md={6}><Statistic title="未知悉告警" value={alerts.unacked == null ? "—" : alerts.unacked} valueStyle={{ color: alerts.unacked ? "#B23A2E" : undefined }} /></Col>
        </Row>
      ) : null}
      <ListToolbar
        state={listState}
        onExport={data ? () => void onExport() : undefined}
        extra={(
          <Space wrap>
            <SearchInput key={filters.q} allowClear size="small" placeholder="编码 / 名称 / 品牌" defaultValue={filters.q} onSearch={(v) => listState.setFilter({ q: v.trim() })} style={{ width: 200 }} />
            <Select allowClear size="small" placeholder="等级" style={{ width: 100 }} value={filters.tier || undefined} onChange={(v) => listState.setFilter({ tier: v ?? "" })} options={[{ value: "S", label: "S" }, { value: "A", label: "A" }, { value: "B", label: "B" }, { value: "C", label: "C" }, { value: "none", label: "未分层" }]} />
            <Select allowClear size="small" placeholder="主预警" style={{ width: 120 }} value={filters.primary || undefined} onChange={(v) => listState.setFilter({ primary: v ?? "" })} options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} />
            <Select aria-label="覆盖状态" allowClear size="small" placeholder="覆盖状态" style={{ width: 130 }} value={filters.status || undefined} onChange={(v) => listState.setFilter({ status: v ?? "" })} options={[{ value: "alert", label: "低于阈值" }, { value: "watch", label: "关注" }, { value: "ok", label: "正常" }]} />
            <span>只看预警 <Switch size="small" checked={filters.onlyAlert !== "0"} onChange={(on) => listState.setFilter({ onlyAlert: on ? "1" : "0" })} /></span>
            <span>含 C 级 <Switch size="small" checked={filters.showC === "1"} onChange={(on) => listState.setFilter({ showC: on ? "1" : "" })} /></span>
          </Space>
        )}
        primaryActions={(
          <Space>
            {canRefresh ? <Button size="small" onClick={() => void load(true)} loading={loading}>重算</Button> : null}
            <Button size="small" onClick={() => void load()} loading={loading}>刷新</Button>
          </Space>
        )}
      />
      <LoadErrorAlert error={error} onRetry={() => void load()} subject="库存预警表" retrying={loading} />
      <Table<InventoryAlertRow>
        className={styles.desktop}
        rowKey="skuId"
        size={listState.tableSize}
        loading={loading}
        columns={columns}
        dataSource={data?.rows ?? []}
        pagination={false}
        scroll={{ x: 1500 }}
        locale={{ emptyText: loading ? "正在加载库存预警…" : error ? "数据未加载" : "当前筛选下没有预警行" }}
        expandable={{
          rowExpandable: (r) => !!alerts.byKey[`inventory_cover:${r.skuId}`],
          expandedRowRender: (r) => { const a = alerts.byKey[`inventory_cover:${r.skuId}`]; return a ? <AlertRowDetail alert={a} onClosed={() => void alerts.reload()} /> : null; },
        }}
      />
      <div className={styles.mobile} data-density={listState.density} aria-busy={loading}>
        {loading ? <div className={styles.empty}><Spin /> 正在加载库存预警…</div> : data?.rows.length ? <ul className={styles.cards}>
          {data.rows.map(row => {
            const alert = alerts.byKey[`inventory_cover:${row.skuId}`];
            return <li key={row.skuId}><InventoryCoverCard row={row}
              ack={<AckCell alert={alert} onAck={id => void alerts.ack(id)} />}
              actions={<CoverActions row={row} />}
              detail={alert ? <AlertRowDetail alert={alert} onClosed={() => void alerts.reload()} /> : null} /></li>;
          })}
        </ul> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error ? "数据未加载" : "当前筛选下没有预警行"} />}
      </div>
      <div className={styles.pagination}><Pagination {...listState.paginationProps({ total: data?.filtered.total ?? 0, showTotal: (t) => `筛选命中 ${t} 个 SKU（成品共 ${data?.totals.skus ?? "—"}）` })} size="small" responsive /></div>
      {data ? (
        <CaliberNote
          summary={`参数：加工缺省 ${data.params.productionDefault} 天 · 在途缺省 ${data.params.logisticsDefault} 天 · 缓冲 ${data.params.bufferDays} 天 · 分层切点 ${data.params.tierCuts.sPct}/${data.params.tierCuts.aPct}/${data.params.tierCuts.bPct}%（* 为现算等级）`}
          detail={<div>{data.limitations.map((l) => <p key={l} style={{ margin: "0 0 4px" }}>· {l}</p>)}</div>}
        />
      ) : null}
    </div>
  );
}

/* ── Tab 2：爆单预警 ── */
export function SpikeTab() {
  const me = useMe();
  const canRefresh = hasAnyRole(me, "pmc", "ops"); // 与 /api/report/sales-spike?refresh=1 的 requireAnyRole(pmc, ops, admin) 一致
  const listState = useListState<{ q?: string }>({ key: "inventory-alerts-spike", paramPrefix: "spike", defaults: { q: "" }, paginated: false });
  const { filters } = listState;
  const [data, setData] = useState<SalesSpikePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alerts = useAlertIndex("sales_spike");
  const request = useRef<AbortController | null>(null);
  const q = (filters.q ?? "").trim();
  const load = useCallback(async (refresh = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setData(null);
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams(); if (q) sp.set("q", q); if (refresh) sp.set("refresh", "1");
      const next = await fetchJson<SalesSpikePage>(`/api/report/sales-spike?${sp.toString()}`, { signal: controller.signal });
      if (!controller.signal.aborted) setData(next);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "爆单预警加载失败，请重试"); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [q]);
  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);

  const keyOf = (r: SpikeHit) => r.kind === "sku" ? `sales_spike:sku:${r.skuId}` : `sales_spike:platform:${r.shopName}|${r.platformSkuId}`;
  const columns: ColumnsType<SpikeHit> = [
    { title: "SKU / 平台 SKU", key: "k", width: 220, fixed: "left", render: (_, r) => r.kind === "sku" ? <Space direction="vertical" size={0}><Typography.Text strong>{r.code}</Typography.Text><Typography.Text type="secondary">{r.name}</Typography.Text></Space> : <Space direction="vertical" size={0}><Tag color="blue">未映射</Tag><Typography.Text>{r.platformSkuId}</Typography.Text></Space> },
    { title: "店铺", dataIndex: "shopName", ellipsis: true },
    { title: "最近各日", key: "d", render: (_, r) => r.days.map((d) => formatQty(d.qty)).join(" / ") },
    { title: "涨幅", dataIndex: "risePct", align: "right", width: 90, sorter: (a, b) => Number(a.risePct ?? 0) - Number(b.risePct ?? 0), defaultSortOrder: "descend", render: (v: string | null) => v == null ? "—" : <Typography.Text type="danger" strong>+{v}%</Typography.Text> },
    { title: "基线 / 阈值", key: "b", width: 120, render: (_, r) => `${formatQty(r.baseline)} / ${formatQty(r.threshold)}` },
    { title: "截止", dataIndex: "anchorDate", width: 100 },
    { title: "已知悉", key: "ack", width: 150, render: (_, r) => <AckCell alert={alerts.byKey[keyOf(r)]} onAck={(id) => void alerts.ack(id)} /> },
    { title: "动作", key: "a", width: 120, fixed: "right", render: (_, r) => <a href={r.href}>{r.kind === "sku" ? "看补货" : "认领身份"}</a> },
  ];
  const onExport = () => {
    if (!data) return;
    exportCsv(
      `爆单预警-${data.anchorDate ?? data.builtAt.slice(0, 10)}`,
      ["类型", "SKU", "名称", "平台SKU", "店铺", "各日", "涨幅%", "基线", "阈值", "截止", "已知悉"],
      [...data.hits, ...data.unmappedHits].map((r) => [r.kind, r.code, r.name, r.platformSkuId, r.shopName, r.days.map((d) => d.qty).join("|"), r.risePct, r.baseline, r.threshold, r.anchorDate, alerts.byKey[keyOf(r)] ? ackText(alerts.byKey[keyOf(r)]) : "未开告警"]),
    );
  };
  const table = (rows: SpikeHit[]) => (
    <Table<SpikeHit>
      rowKey={keyOf}
      size={listState.tableSize}
      loading={loading}
      columns={columns}
      dataSource={rows}
      scroll={{ x: 1200 }}
      pagination={{ showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
      locale={{ emptyText: loading ? "正在加载当前窗口…" : error || !data ? "数据未加载" : data.state === "insufficient" ? "证据不足，无法判定；不代表没有爆单" : "完整观测窗口内没有命中" }}
      expandable={{
        rowExpandable: (r) => !!alerts.byKey[keyOf(r)],
        expandedRowRender: (r) => { const a = alerts.byKey[keyOf(r)]; return a ? <AlertRowDetail alert={a} onClosed={() => void alerts.reload()} /> : null; },
      }}
    />
  );

  return (
    <div>
      {data ? (
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={12} md={6}><Statistic title="窗口命中 · 系统 SKU" value={data.state === "insufficient" ? "—" : data.hitCount} valueStyle={{ color: data.hitCount ? "#B23A2E" : undefined }} /></Col>
          <Col xs={12} md={6}><Statistic title="窗口命中 · 未映射 SKU" value={data.state === "insufficient" ? "—" : data.unmappedCount} /></Col>
          <Col xs={12} md={6}><Statistic title="未知悉告警" value={alerts.unacked == null ? "—" : alerts.unacked} valueStyle={{ color: alerts.unacked ? "#B23A2E" : undefined }} /></Col>
          <Col xs={12} md={6}><Statistic title="数据截止" value={data.anchorDate ?? "缺流"} valueStyle={{ fontSize: 18 }} /></Col>
        </Row>
      ) : null}
      <ListToolbar
        state={listState}
        onExport={data ? onExport : undefined}
        extra={<SearchInput key={q} allowClear size="small" placeholder="编码 / 名称 / 平台 SKU / 店铺" defaultValue={q} onSearch={(v) => listState.setFilter({ q: v.trim() })} style={{ width: 240 }} />}
        primaryActions={(
          <Space>
            {canRefresh ? <Button size="small" onClick={() => void load(true)} loading={loading}>重算</Button> : null}
            <Button size="small" onClick={() => void load()} loading={loading}>刷新</Button>
          </Space>
        )}
      />
      <LoadErrorAlert error={error} onRetry={() => void load()} subject="爆单预警" retrying={loading} />
      {data ? <Alert
        showIcon
        type={data.state !== "ready" || !data.currentEvidence ? "warning" : "info"}
        style={{ marginBottom: 12 }}
        message={`完整窗口可判定 ${data.coverage.evaluatedItems} 项；证据不足 ${data.coverage.incompleteItems} 项`}
        description={<>
          缺日或非法销量不当作零，多店铺须逐序列覆盖。无法判定或已消失的序列不会自动关闭旧告警。
          {!data.currentEvidence ? " 当前为历史、未来或缺失窗口，不用于当前告警更新；请核对来源业务日期。" : " 来源截止符合 T+1；不代表未接入平台已有覆盖。"}
          {" "}<a href="/alerts?category=sales_spike">核对已有爆单告警</a>
        </>}
      /> : null}
      <Typography.Title level={5} style={{ marginTop: 4 }}>已映射 SKU {data ? `（${data.q ? `筛选 ${data.hits.length} / ` : ""}共 ${data.hitCount}）` : ""}</Typography.Title>
      {table(data?.hits ?? [])}
      <Typography.Title level={5} style={{ marginTop: 12 }}>未映射平台 SKU {data ? `（${data.q ? `筛选 ${data.unmappedHits.length} / ` : ""}共 ${data.unmappedCount}）` : ""}</Typography.Title>
      {table(data?.unmappedHits ?? [])}
      {data ? (
        <CaliberNote
          summary={`规则：最近 ${data.params.consecutiveDays} 天每日 ≥ 前 ${data.params.baselineDays} 日日均 × ${(1 + data.params.risePct / 100).toFixed(2)}，基线 ≥ ${data.params.minBaseQty} · 覆盖：平台序列 ${data.coverage.platformSeries}，已映射 ${data.coverage.mappedSeries}，系统 SKU ${data.coverage.systemSkus}`}
          detail={<div>{data.limitations.map((l) => <p key={l} style={{ margin: "0 0 4px" }}>· {l}</p>)}</div>}
        />
      ) : null}
    </div>
  );
}

export default function AlertsClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const tab = sp.get("tab") === "spike" ? "spike" : "cover";
  const setTab = (key: string) => { const p = new URLSearchParams(sp.toString()); p.set("tab", key); router.replace(`/inventory/alerts?${p.toString()}`, { scroll: false }); };
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>库存预警与爆单</Typography.Title>
      <CaliberNote
        summary="每个 SKU 只有一个主预警；日销三口径（外部 / 内部 / 实时仓）并列不相加；C 级默认折叠；观察序列只预警不定量。"
        detail={<div>主预警优先级：断货 &gt; 爆单 &gt; 低于阈值（rules/alert-priority）。阈值 = 加工周期 + 在途周期 + 缓冲，逐 SKU 主数据优先、缺则用运行参数缺省并标「缺省周期」。已知悉只留审计不改状态。自动关闭按各类规则判断；爆单须有完整且符合 T+1 时效的新窗口确认不命中，并距最后命中满 3 天。缺失或过期证据保留旧告警待复核，不能视为问题已解决。</div>}
      />
      <Tabs activeKey={tab} onChange={setTab} destroyOnHidden items={[
        { key: "cover", label: "库存预警表", children: <CoverTab /> },
        { key: "spike", label: "爆单预警", children: <SpikeTab /> },
      ]} />
    </div>
  );
}
